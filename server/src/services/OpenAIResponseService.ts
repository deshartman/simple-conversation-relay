/**
 * OpenAIResponseService — streams responses from OpenAI's Responses API and
 * routes tool calls through a `ToolRegistry`.
 *
 * v4.12 changes:
 *  - Replaced `loadedTools: Record<string, Function>` + `manifest` with a
 *    single `ToolRegistry`. Schema and handler now co-located in tool files.
 *  - `executeToolCall()` looks up via `registry.get(name).handler(args, ctx)`.
 *    `ctx` is this service's `ToolContext` — tools never see the transport
 *    session (e.g. `change-context` calls `ctx.changeContext`).
 *  - Calls `responseHandler.toolCallStart?(promise)` so the session can
 *    track in-flight tool promises (lets `sendText(last=true)` await them
 *    before emitting the terminal text — closes the farewell/end race).
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
    CallEvent,
    ActionOutcome,
} from '../interfaces/ResponseService.js';
import type { ServerConfig } from '../config/ServerConfig.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolContext } from '../tools/define-tool.js';
import { ContextNotFoundError, type ContextSource } from './ContextStore.js';

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
    /** Null until loaded: on setup (default or contextKey), or on first use. */
    protected instructions: string | null;
    protected isInterrupted: boolean;
    protected registry: ToolRegistry;
    protected inputMessages: ResponseInput;
    /**
     * Monotonic id for the current generation. Each `generateResponse()` claims
     * the next value; a stream whose generation is no longer current stops
     * emitting. Two prompts arriving close together would otherwise start two
     * independent streams that both feed the same handler, interleaving their
     * tokens mid-sentence on the wire.
     */
    protected generation = 0;
    private responseHandler!: ResponseHandler;

    /** Where this service reads its prompt from; nothing is loaded until needed. */
    private readonly contexts: ContextSource;
    constructor(
        contexts: ContextSource,
        registry: ToolRegistry,
        config: ServerConfig
    ) {
        this.contexts = contexts;
        this.openai = new OpenAI();
        this.model = config.openaiModel;
        this.currentResponseId = null;
        this.instructions = null;
        this.isInterrupted = false;
        this.registry = registry;
        this.inputMessages = [];
    }

    createResponseHandler(handler: ResponseHandler): void {
        this.responseHandler = handler;
    }

    /**
     * The service, not the transport, decides what each call event means for
     * the conversation: which context applies, what the model is told about
     * the call, and what DTMF and status updates contribute.
     */
    async handleEvent(event: CallEvent): Promise<void> {
        switch (event.type) {
            case 'setup': {
                // Per-call context selection. Without this the active context is
                // global, so an outbound campaign prompt would also be served to
                // inbound callers.
                const contextKey = event.setup.customParameters?.contextKey;
                if (contextKey) {
                    const override = await this.contexts.get(contextKey);
                    if (override) {
                        this.instructions = override;
                        logOut('OpenAIResponseService', `Using context '${contextKey}' for this call`);
                    } else {
                        logError(
                            'OpenAIResponseService',
                            `contextKey '${contextKey}' not found — falling back to the default context`
                        );
                    }
                }
                await this.insertMessage(
                    'system',
                    `These are all the details of the call: ${JSON.stringify(
                        event.setup,
                        null,
                        4
                    )} and the parameter data needed to complete your objective: ${JSON.stringify(
                        event.parameters,
                        null,
                        4
                    )}. Use this to complete your objective`
                );
                break;
            }
            case 'prompt':
                await this.generateResponse('user', event.text);
                break;
            case 'interrupt':
                this.interrupt();
                break;
            case 'dtmf':
                // Unchanged behaviour: the model is not told about key presses.
                logOut('OpenAIResponseService', `DTMF '${event.digit}' ignored`);
                break;
            case 'status':
                await this.insertMessage('system', JSON.stringify(event.status));
                break;
            case 'context': {
                const context = await this.contexts.get(event.key);
                if (!context) throw new ContextNotFoundError(event.key);
                await this.updateContext(context);
                break;
            }
        }
    }

    /**
     * What tools may do to this conversation. Same object for the voice path
     * and /conversation, so a tool works identically with or without a call.
     */
    private readonly toolContext: ToolContext = {
        changeContext: async (context, handoffSummary) => {
            await this.updateContext(context);
            await this.insertMessage('system', `Context handoff summary: ${handoffSummary}`);
        },
    };

    /**
     * Execute a tool call via the registry. Notifies
     * `responseHandler.toolCallStart` with the execution promise so the
     * session can track in-flight tools for terminal-text deferral.
     */
    async executeToolCall(
        tool: ResponsesAPIToolCall
    ): Promise<{ result: IToolResult; outcome?: ActionOutcome } | null> {
        try {
            const registered = this.registry.get(tool.name);
            if (!registered) {
                logError('OpenAIResponseService', `Unknown tool: ${tool.name}`);
                return null;
            }

            const toolArgs = JSON.parse(tool.arguments);
            const promise = Promise.resolve(registered.handler(toolArgs, this.toolContext));
            // Track the in-flight tool promise before awaiting so the
            // session can include it in any concurrent sendText(last=true)
            // await set.
            this.responseHandler.toolCallStart?.(promise);

            const toolResponse = (await promise) as IToolResult;
            if (!toolResponse) return null;

            const outcome =
                this.responseHandler.toolResult({
                    toolType: tool.name,
                    toolData: toolResponse,
                } as ToolResultEvent) ?? undefined;

            // The model sees what actually happened to the call, not what the
            // tool hoped would happen (e.g. an unsupported language dropped).
            if (outcome && !outcome.applied) {
                return {
                    result: { ...toolResponse, success: false, message: outcome.detail ?? 'The call could not do that' },
                    outcome,
                };
            }
            if (outcome?.detail) {
                return { result: { ...toolResponse, message: `${toolResponse.message}. ${outcome.detail}` }, outcome };
            }
            return { result: toolResponse, outcome };
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
                    this.instructions = `${await this.loadInstructions()}\n\n${message}`;
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

    cleanup(): void {
        // Handler cleanup is managed by the caller (session).
    }

    private async processStream(stream: any, generation: number): Promise<void> {
        let currentToolCall: ResponsesAPIToolCall | null = null;

        // @ts-ignore — OpenAI stream's async-iterator typing lags behind.
        for await (const event of stream) {
            if (this.isInterrupted) break;

            // A newer prompt has arrived; this stream's output is stale and
            // must not reach the wire alongside the newer response.
            if (generation !== this.generation) {
                logOut(
                    'OpenAIResponseService',
                    `Abandoning superseded stream (generation ${generation}, current ${this.generation})`
                );
                break;
            }

            const eventData = event as ResponseStreamEvent;

            switch (eventData.type) {
                case 'response.output_text.delta': {
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
                            const executed = await this.executeToolCall(currentToolCall);

                            if (executed !== null) {
                                const toolResult = executed.result;
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

                                // A tool that ends the call is terminal: there
                                // is nothing left to say. Generating a follow-up
                                // makes the model deliver a second farewell on
                                // top of the one it already spoke, and the
                                // caller hears the goodbye twice.
                                //
                                // We deliberately do NOT stop reading this
                                // stream — `response.completed` must still fire
                                // its `last: true` token, because the session
                                // defers the terminal frame until the final text
                                // token. Skip that and the call never hangs up.
                                //
                                // Whether it ended the call is the transport's
                                // answer, not something this service works out.
                                const isTerminal = executed.outcome?.terminal === true;

                                if (isTerminal) {
                                    logOut(
                                        'OpenAIResponseService',
                                        `Tool '${currentToolCall.name}' is terminal — skipping follow-up generation`
                                    );
                                } else {
                                    const tools = this.registry.listForOpenAI();
                                    const followUpStream = await this.openai.responses.create({
                                        model: this.model,
                                        input: this.inputMessages,
                                        tools:
                                            tools.length > 0 ? (tools as unknown as any) : undefined,
                                        stream: true,
                                        instructions: await this.loadInstructions(),
                                    });
                                    await this.processStream(followUpStream, generation);
                                }
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

    /** The current instructions, loading the default context on first use. */
    private async loadInstructions(): Promise<string> {
        if (this.instructions === null) this.instructions = await this.contexts.getDefault();
        return this.instructions;
    }

    async generateResponse(role: 'user' | 'system' = 'user', prompt: string): Promise<void> {
        // Cancel-previous: a newer prompt supersedes whatever is in flight.
        // Claiming the next generation is what stops the older stream.
        const generation = ++this.generation;
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
                instructions: await this.loadInstructions(),
            });

            await this.processStream(stream, generation);
        } catch (error) {
            this.responseHandler.error(error as Error);
            throw error;
        }
    }
}

export { OpenAIResponseService };
