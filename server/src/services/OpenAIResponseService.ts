/**
 * OpenAIResponseService — streams responses from OpenAI's Responses API and
 * routes tool calls through a `ToolRegistry`.
 *
 * v4.12 changes:
 *  - Replaced `loadedTools: Record<string, Function>` + `manifest` with a
 *    single `ToolRegistry`. Schema and handler now co-located in tool files.
 *  - `executeToolCall()` looks up via `registry.get(name).handler(args, session)`.
 *    The session is threaded through at construction for tools that need it
 *    (e.g. `change-context`, which calls `session.updateContext`).
 *  - Calls `responseHandler.toolCallStart?(promise)` so the session can
 *    track in-flight tool promises (lets `sendText(last=true)` await them
 *    before emitting the terminal text — closes the farewell/end race).
 *  - `updateTools(registry)` accepts a `ToolRegistry` instead of a JSON
 *    manifest.
 */

import dotenv from 'dotenv';
import OpenAI from 'openai';
import type {
    ResponseInput,
    ResponseStreamEvent,
} from 'openai/resources/responses/responses.mjs';

import { logOut, logError } from '../utils/logger.js';
import type {
    ResponseService,
    ContentResponse,
    ToolResult as IToolResult,
    ToolResultEvent,
    ResponseHandler,
} from '../interfaces/ResponseService.js';
import type { ServerConfig } from '../config/ServerConfig.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ConversationRelaySession } from './ConversationRelaySession.js';

dotenv.config();

interface ResponsesAPIToolCall {
    id: string;
    type: 'function_call';
    call_id: string;
    name: string;
    arguments: string;
}

class OpenAIResponseService implements ResponseService {
    protected openai: OpenAI;
    protected model: string;
    protected currentResponseId: string | null;
    protected instructions: string;
    protected isInterrupted: boolean;
    protected registry: ToolRegistry;
    protected inputMessages: ResponseInput;
    protected listenMode: boolean;
    /** Set by `setSession()` — required before `generateResponse()` is called via a session. */
    protected session: ConversationRelaySession | null = null;

    private responseHandler!: ResponseHandler;

    constructor(
        context: string,
        registry: ToolRegistry,
        listenMode: boolean,
        config: ServerConfig
    ) {
        this.openai = new OpenAI();
        this.model = config.openaiModel;
        this.currentResponseId = null;
        this.instructions = context;
        this.isInterrupted = false;
        this.registry = registry;
        this.inputMessages = [];
        this.listenMode = listenMode;
    }

    /**
     * Inject the session reference. Called once by
     * `ConversationRelaySession` after it constructs the service — the
     * session reference is needed by tool handlers that mutate session
     * state (e.g. `change-context`).
     *
     * The `/conversation` HTTP endpoint doesn't use a session; tools that
     * require one will fail gracefully if called without it (which is
     * fine — that endpoint is for non-call LLM exchanges).
     */
    setSession(session: ConversationRelaySession): void {
        this.session = session;
    }

    createResponseHandler(handler: ResponseHandler): void {
        this.responseHandler = handler;
    }

    /**
     * Execute a tool call via the registry. Notifies
     * `responseHandler.toolCallStart` with the execution promise so the
     * session can track in-flight tools for terminal-text deferral.
     */
    async executeToolCall(tool: ResponsesAPIToolCall): Promise<IToolResult | null> {
        try {
            const registered = this.registry.get(tool.name);
            if (!registered) {
                logError('OpenAIResponseService', `Unknown tool: ${tool.name}`);
                return null;
            }

            const toolArgs = JSON.parse(tool.arguments);
            // The registry's handler expects a session. For the HTTP
            // `/conversation` path (no session), pass a placeholder `any`
            // — tools that need the session (e.g. `change-context`) will
            // throw; that's the correct behavior for a session-less context.
            const sessionArg = this.session as unknown as ConversationRelaySession;

            const promise = Promise.resolve(registered.handler(toolArgs, sessionArg));
            // Track the in-flight tool promise before awaiting so the
            // session can include it in any concurrent sendText(last=true)
            // await set.
            this.responseHandler.toolCallStart?.(promise);

            const toolResponse = (await promise) as IToolResult;

            if (toolResponse) {
                this.responseHandler.toolResult({
                    toolType: tool.name,
                    toolData: toolResponse,
                } as ToolResultEvent);
            }

            return toolResponse;
        } catch (error) {
            logError(
                'OpenAIResponseService',
                `Tool call failed: ${tool.name} with arguments: ${tool.arguments} — ${error instanceof Error ? error.message : String(error)}`
            );
            return null;
        }
    }

    getCurrentResponseId(): string | null {
        return this.currentResponseId;
    }

    clearMessages(): void {
        this.currentResponseId = null;
        this.inputMessages = [];
        logOut('OpenAIResponseService', 'Cleared conversation history');
    }

    interrupt(): void {
        this.isInterrupted = true;
    }

    resetInterrupt(): void {
        this.isInterrupted = false;
    }

    async insertMessage(
        role: 'system' | 'user' | 'assistant' = 'system',
        message: string
    ): Promise<void> {
        try {
            switch (role) {
                case 'system':
                    this.instructions += `\n\n${message}`;
                    break;
                case 'user':
                case 'assistant':
                    this.inputMessages.push({ role, content: message });
                    break;
                default:
                    logError('OpenAIResponseService', `Unknown role: ${role}`);
                    break;
            }
        } catch (error) {
            logError(
                'OpenAIResponseService',
                `Error inserting message: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    async updateContext(context: string): Promise<void> {
        if (!context || typeof context !== 'string') {
            throw new Error('Context must be a non-empty string');
        }
        this.instructions = context;
        this.currentResponseId = null;
        this.inputMessages = [];
        logOut('OpenAIResponseService', `Updated context (${context.length} characters)`);
    }

    /**
     * Replace the tool registry. Typed as `any` in the `ResponseService`
     * interface to avoid a cross-layer import; narrowed here.
     */
    updateTools(registry: ToolRegistry): void {
        this.registry = registry;
        logOut(
            'OpenAIResponseService',
            `Updated tool registry (${registry.size()} tools)`
        );
    }

    cleanup(): void {
        // Handler cleanup is managed by the caller (session).
    }

    private async processStream(stream: any): Promise<void> {
        let currentToolCall: ResponsesAPIToolCall | null = null;

        // @ts-ignore — OpenAI stream's async-iterator typing lags behind.
        for await (const event of stream) {
            if (this.isInterrupted) break;

            const eventData = event as ResponseStreamEvent;

            switch (eventData.type) {
                case 'response.output_text.delta': {
                    if (this.listenMode) break;
                    const content = eventData.delta || '';
                    if (content) {
                        this.responseHandler.content({
                            type: 'text',
                            token: content,
                            last: false,
                        } as ContentResponse);
                    }
                    break;
                }

                case 'response.output_item.added':
                    if (eventData.item?.type === 'function_call') {
                        currentToolCall = {
                            id: eventData.item.id || 'unknown',
                            type: 'function_call',
                            call_id: eventData.item.call_id || eventData.item.id || 'unknown',
                            name: eventData.item.name || '',
                            arguments: eventData.item.arguments || '',
                        };
                    }
                    break;

                case 'response.function_call_arguments.delta':
                    if (currentToolCall && eventData.delta) {
                        currentToolCall.arguments += eventData.delta;
                    }
                    break;

                case 'response.function_call_arguments.done':
                    if (currentToolCall) {
                        try {
                            const toolResult = await this.executeToolCall(currentToolCall);

                            if (toolResult !== null) {
                                this.inputMessages.push({
                                    type: 'function_call',
                                    id: currentToolCall.id,
                                    call_id: currentToolCall.call_id,
                                    name: currentToolCall.name,
                                    arguments: currentToolCall.arguments,
                                });
                                this.inputMessages.push({
                                    type: 'function_call_output',
                                    call_id: currentToolCall.call_id,
                                    output: JSON.stringify(toolResult),
                                });

                                const tools = this.registry.listForOpenAI();
                                const followUpStream = await this.openai.responses.create({
                                    model: this.model,
                                    input: this.inputMessages,
                                    tools: tools.length > 0 ? (tools as unknown as any) : undefined,
                                    stream: true,
                                    instructions: this.instructions,
                                });
                                await this.processStream(followUpStream);
                            } else {
                                logError('OpenAIResponseService', 'Tool execution returned null');
                            }
                        } catch (error) {
                            logError(
                                'OpenAIResponseService',
                                `Error executing tool ${currentToolCall.name}: ${error instanceof Error ? error.message : String(error)}`
                            );
                        }
                        currentToolCall = null;
                    }
                    break;

                case 'response.completed':
                    if (!currentToolCall) {
                        this.responseHandler.content({
                            type: 'text',
                            token: '',
                            last: true,
                        } as ContentResponse);
                    }
                    break;

                case 'response.created':
                case 'response.in_progress':
                case 'response.content_part.added':
                case 'response.content_part.done':
                case 'response.output_item.done':
                case 'response.output_text.done':
                    // No-op
                    break;

                default:
                    logOut('OpenAIResponseService', `Unhandled event: ${eventData.type}`);
                    break;
            }
        }
    }

    async generateResponse(role: 'user' | 'system' = 'user', prompt: string): Promise<void> {
        this.isInterrupted = false;

        try {
            this.inputMessages.push({
                role: role === 'system' ? 'user' : role,
                content: role === 'system' ? `System: ${prompt}` : prompt,
            });

            const tools = this.registry.listForOpenAI();
            const stream = await this.openai.responses.create({
                model: this.model,
                input: this.inputMessages,
                stream: true,
                tools: tools.length > 0 ? (tools as unknown as any) : undefined,
                instructions: this.instructions,
            });

            await this.processStream(stream);
        } catch (error) {
            this.responseHandler.error(error as Error);
            throw error;
        }
    }
}

export { OpenAIResponseService };
