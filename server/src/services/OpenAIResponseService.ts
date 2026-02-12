/**
 * @class OpenAIResponseService 
 * @implements ResponseService
 * Base service class for handling LLM API interactions using OpenAI's Responses API and managing conversation flow.
 * This service orchestrates:
 * 
 * 1. Message Management:
 *    - Utilizes OpenAI's stateful conversation history management
 *    - Processes incoming messages
 *    - Handles tool calls and responses
 *    - Manages streaming responses
 * 
 * 2. Tool Integration:
 *    - Dynamically loads tools from manifest
 *    - Executes tool calls
 *    - Handles tool responses
 * 
 * 3. Handler Management:
 *    - Uses dependency injection for response handlers
 *    - Calls content handlers for responses
 *    - Calls tool result and error handlers
 * 
 * 4. Interrupt Handling:
 *    - Provides methods to interrupt ongoing responses
 *    - Manages interruption state through isInterrupted flag
 *    - Gracefully stops streaming when interrupted
 *    - Enables natural conversation flow with interruptions
 * 
 * Tool Loading and Execution:
 * The service implements a dynamic tool loading system where tools are loaded based on their
 * names defined in the toolManifest.json file. Each tool's filename in the /tools directory
 * must exactly match its corresponding name in the manifest. For example, if the manifest
 * defines a tool with name "send-sms", the service will attempt to load it from
 * "/tools/send-sms.js". This naming convention is critical for the dynamic loading system
 * to work correctly.
 * 
 * @class
 * @property {OpenAI} openai - OpenAI API client instance
 * @property {string} model - Model to use (from environment variables)
 * @property {string} currentResponseId - Current response ID for conversation continuity
 * @property {string} instructions - System instructions/context from context.md
 * @property {Object} toolManifest - Tool definitions from toolManifest.json
 * @property {boolean} isInterrupted - Flag for interrupting response generation
 * @property {Object} loadedTools - Map of loaded tool functions
 * @property {Array} inputMessages - Message history for Responses API
 * 
 * Handler Functions Called:
 * - contentHandler: Response content chunks
 * - toolResultHandler: Results from tool executions  
 * - errorHandler: Error events
 */

import dotenv from 'dotenv';
import OpenAI from 'openai';

// Import proper OpenAI types 
// Note: ResponseInput is not yet exported in main OpenAI namespace (see issue #1378)
// Using direct import as recommended workaround until it's properly exported
import type { ResponseInput, ResponseStreamEvent } from 'openai/resources/responses/responses.mjs';

import { logOut, logError } from '../utils/logger.js';
import { ResponseService, ContentResponse, ToolResult, ToolResultEvent, ResponseHandler } from '../interfaces/ResponseService.js';
import { ServerConfig } from '../config/ServerConfig.js';

dotenv.config();


/**
 * Type for loaded tool function
 */
type ToolFunction = (args: any) => Promise<ToolResult> | ToolResult;

/**
 * Interface for tool call from streaming events
 */
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
    protected toolManifest: { tools: any[] };
    protected toolDefinitions: any[];
    protected loadedTools: Record<string, ToolFunction>;
    protected inputMessages: ResponseInput;
    protected listenMode: boolean;

    // Unified response handler
    private responseHandler!: ResponseHandler;

    /**
     * Constructor for ResponseService instance.
     * Initializes client and sets up initial state with pre-loaded assets.
     *
     * @param {string} context - Pre-loaded context content
     * @param {object} manifest - Pre-loaded tool manifest
     * @param {Record<string, ToolFunction>} loadedTools - Pre-loaded tool functions
     * @param {boolean} listenMode - Listen mode setting
     * @param {ServerConfig} config - Optional server configuration
     */
    constructor(
        context: string,
        manifest: object,
        loadedTools: Record<string, ToolFunction>,
        listenMode: boolean = false,
        config?: ServerConfig
    ) {
        this.openai = new OpenAI();
        // Use config if provided, fallback to env for gradual migration
        this.model = config?.openaiModel || process.env.OPENAI_MODEL || "gpt-4o";
        this.currentResponseId = null;
        this.instructions = context;
        this.isInterrupted = false;

        // Set up tools from pre-loaded data
        this.toolManifest = manifest as { tools: any[] };
        this.toolDefinitions = this.toolManifest.tools || [];
        this.loadedTools = loadedTools;

        this.inputMessages = [];
        this.listenMode = listenMode;
    }


    /**
     * Creates and sets up the response handler for the service
     * 
     * @param handler - Unified handler for all response events
     */
    createResponseHandler(handler: ResponseHandler): void {
        this.responseHandler = handler;
    }


    /**
    * Executes a tool call with proper type safety
    * 
    * @param {ResponsesAPIToolCall} tool - Tool call object
    * @returns {Promise<ToolResult|null>} Tool execution result or null if execution fails
    */
    async executeToolCall(tool: ResponsesAPIToolCall): Promise<ToolResult | null> {
        try {
            const calledTool: ToolFunction = this.loadedTools[tool.name];
            const calledToolArgs = JSON.parse(tool.arguments);

            // Special handling for change-context tool: Add service reference to enable self-contained context switching
            // This approach keeps the tool interface clean for all other tools while allowing change-context
            // to access the service it needs to update context directly within the tool execution
            if (tool.name === 'change-context') {
                calledToolArgs._openaiService = this;
            }

            // Call the tool with arguments
            const toolResponse: ToolResult = await calledTool(calledToolArgs);

            // Always pass tool results to higher-level service for processing
            if (toolResponse) {
                this.responseHandler.toolResult({
                    toolType: tool.name,
                    toolData: toolResponse
                } as ToolResultEvent);
            }

            return toolResponse;
        } catch (error) {
            logError('OpenAIResponseService', `Tool call failed: ${tool.name} with arguments: ${tool.arguments}`);
            return null;
        }
    }

    /**
     * Retrieves the current conversation ID for state management.
     * 
     * @returns {string|null} Current response ID or null if no active conversation
     */
    getCurrentResponseId(): string | null {
        return this.currentResponseId;
    }

    /**
     * Clears conversation history by resetting the response ID and input messages.
     * This will start a new conversation thread with the Responses API.
     */
    clearMessages(): void {
        this.currentResponseId = null;
        this.inputMessages = [];
        logOut('OpenAIResponseService', 'Cleared conversation history - will start new thread');
    }

    /**
     * Interrupts current response generation.
     * Sets isInterrupted flag to true to stop streaming immediately.
     * This method is called when a user interrupts the AI during a response,
     * allowing the system to stop the current response and process the new input.
     * 
     * The interrupt mechanism works by:
     * 1. Setting the isInterrupted flag to true
     * 2. Breaking out of the streaming loop in generateResponse
     * 3. Allowing the system to process the new user input
     * 
     * This enables more natural conversation flow by letting users
     * interrupt lengthy responses without waiting for completion.
     */
    interrupt(): void {
        this.isInterrupted = true;
    }

    /**
     * Resets the interruption flag.
     * Allows new responses to be generated after an interruption.
     * This method is called automatically at the beginning of generateResponse
     * to ensure each new response starts with a clean interrupt state.
     * 
     * The reset mechanism ensures that:
     * 1. Previous interruptions don't affect new responses
     * 2. Each response generation starts with isInterrupted = false
     * 3. The system is ready to handle new potential interruptions
     */
    resetInterrupt(): void {
        this.isInterrupted = false;
    }

    /**
     * Inserts a message into conversation context without generating a response.
     * With the Responses API, this is handled by adding to the input messages array.
     * 
     * @param {string} role - Message role ('system', 'user', or 'assistant')
     * @param {string} message - Message content to add to context
     */
    async insertMessage(role: 'system' | 'user' | 'assistant' = 'system', message: string): Promise<void> {
        try {
            switch (role) {
                case 'system':
                    // System messages can be added as instructions updates
                    this.instructions += `\n\n${message}`;
                    break;
                case 'user':
                case 'assistant':
                    // For user/assistant messages, add to input messages
                    this.inputMessages.push({
                        role: role,
                        content: message
                    });
                    break;
                default:
                    logError('OpenAIResponseService', `Unknown role: ${role}`);
                    break;
            }
        } catch (error) {
            logError('OpenAIResponseService', `Error inserting message into context: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Updates the context (instructions) for the conversation from content string.
     * This changes the system instructions that guide the LLM's responses.
     * 
     * @param {string} context - Context content string
     * @throws {Error} If context is invalid
     */
    async updateContext(context: string): Promise<void> {
        try {
            if (!context || typeof context !== 'string') {
                throw new Error('Context must be a non-empty string');
            }

            // Update instructions and reset conversation
            this.instructions = context;
            this.currentResponseId = null; // Reset conversation to use new context
            this.inputMessages = []; // Reset input messages

            logOut('OpenAIResponseService', `Updated context content (${context.length} characters)`);

        } catch (error) {
            logError('OpenAIResponseService', `Error updating context: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }


    /**
     * Updates the tool manifest used by the service dynamically from content object.
     * Tools are already pre-loaded, so this just updates the manifest definitions.
     *
     * @param {any} toolManifest - Tool manifest object
     * @throws {Error} If tool manifest is invalid
     */
    async updateTools(toolManifest: any): Promise<void> {
        try {
            if (!toolManifest || typeof toolManifest !== 'object') {
                throw new Error('Tool manifest must be a valid object');
            }

            if (!toolManifest.tools || !Array.isArray(toolManifest.tools)) {
                throw new Error('Tool manifest must have a tools array');
            }

            // Update tool definitions (tools are already loaded)
            this.toolManifest = toolManifest;
            this.toolDefinitions = toolManifest.tools;

            logOut('OpenAIResponseService', `Updated tool manifest with ${this.toolDefinitions.length} tool definitions`);

        } catch (error) {
            logError('OpenAIResponseService', `Error updating tools: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }


    /**
     * Performs cleanup of service resources.
     * Clears handlers to prevent memory leaks.
     */
    cleanup(): void {
        // Clear handlers instead of removing listeners
        // Handler cleanup is managed by the calling code
    }

    /**
     * Processes a stream and handles tool calls by creating follow-up responses.
     * This is a helper method to reduce code duplication between initial and follow-up streams.
     */
    private async processStream(stream: any): Promise<void> {
        let currentToolCall: ResponsesAPIToolCall | null = null;

        // @ts-ignore - TypeScript doesn't recognize the async iterator on the Responses API stream yet
        for await (const event of stream) {
            if (this.isInterrupted) {
                break;
            }

            const eventData = event as ResponseStreamEvent;

            // Handle different event types from the Responses API
            switch (eventData.type) {
                case 'response.output_text.delta':
                    // Text content streaming - suppress if listenMode is enabled
                    if (this.listenMode) break;

                    const content = eventData.delta || '';
                    if (content) {
                        this.responseHandler.content({
                            type: "text",
                            token: content,
                            last: false
                        } as ContentResponse);
                    }
                    break;

                case 'response.output_item.added':
                    if (eventData.item?.type === 'function_call') {
                        currentToolCall = {
                            id: eventData.item.id || 'unknown',
                            type: 'function_call',
                            call_id: eventData.item.call_id || eventData.item.id || 'unknown',
                            name: eventData.item.name || '',
                            arguments: eventData.item.arguments || ''
                        };
                    }
                    break;

                case 'response.function_call_arguments.delta':
                    // Function call arguments streaming - accumulate the arguments
                    if (currentToolCall && eventData.delta) {
                        currentToolCall.arguments += eventData.delta;
                    }
                    break;

                case 'response.function_call_arguments.done':
                    // Function call completed - execute it and create follow-up response
                    if (currentToolCall) {
                        try {
                            const toolResult: ToolResult | null = await this.executeToolCall(currentToolCall);

                            if (toolResult !== null) {
                                // Always add function call and result to conversation
                                this.inputMessages.push({
                                    type: 'function_call',
                                    id: currentToolCall.id,
                                    call_id: currentToolCall.call_id,
                                    name: currentToolCall.name,
                                    arguments: currentToolCall.arguments
                                });

                                // Add function result to input messages
                                this.inputMessages.push({
                                    type: 'function_call_output',
                                    call_id: currentToolCall.call_id,
                                    output: JSON.stringify(toolResult)
                                });

                                // Create follow-up response with tool results
                                const followUpStream = await this.openai.responses.create({
                                    model: this.model,
                                    input: this.inputMessages,
                                    tools: this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined,
                                    stream: true,
                                    instructions: this.instructions
                                });

                                // Process the follow-up stream recursively
                                await this.processStream(followUpStream);

                            } else {
                                logError('OpenAIResponseService', `Tool execution returned null result`);
                            }
                        } catch (error) {
                            logError('OpenAIResponseService', `Error executing tool ${currentToolCall.name}: ${error instanceof Error ? error.message : String(error)}`);
                        }

                        currentToolCall = null;
                    } else {
                        logError('OpenAIResponseService', `Function call completed but no currentToolCall available`);
                    }
                    break;

                case 'response.completed':
                    // Only send final content marker if this is the end of the conversation
                    // (not if we're about to create a follow-up for tool results)
                    // Always send completion to ensure terminal messages are dispatched even in listen mode
                    if (!currentToolCall) {
                        this.responseHandler.content({
                            type: "text",
                            token: '',
                            last: true
                        } as ContentResponse);
                    }
                    break;
                case 'response.created':
                case 'response.in_progress':
                case 'response.content_part.added':
                case 'response.content_part.done':
                case 'response.output_item.done':
                case 'response.completed':
                case 'response.output_text.done':
                    // These events don't require special handling
                    break;
                default:
                    // Handle any unrecognized event types
                    logOut('OpenAIResponseService', `Unhandled event type: ${eventData.type}`);
                    break;
            }
        }
    }

    /**
     * Generates a streaming response using the OpenAI Responses API.
     * Handles tool calls, manages conversation history, and emits response chunks.
     * 
     * == Streaming and Tool Calls ==
     * The Responses API handles streaming responses that may include both content and tool calls:
     *      1. Content chunks are passed via responseHandler.content calls
     *      2. Tool call events are processed as they arrive
     *      3. When tool calls are detected, they are executed immediately
     *      4. Tool results are added to input messages and a follow-up response is created
     * This approach ensures reliable tool execution while maintaining a responsive streaming experience.
     * 
     * == Tool Execution Flow ==
     * When the LLM suggests a tool call, the executeToolCall method processes it by:
     *      1. Retrieving the tool function from the loadedTools map using the tool name
     *      2. Parsing the JSON string arguments into an object
     *      3. Executing the tool with the parsed arguments
     *      4. Adding both the function call and result to input messages
     *      5. Creating a new response with the updated input for conversation continuity
     * 
     * == Interrupt Handling ==
     * The method supports graceful interruption during response generation:
     *      1. The isInterrupted flag is reset to false at the start of each response
     *      2. During streaming, each event checks if isInterrupted has been set to true
     *      3. If an interruption is detected, the streaming loop breaks immediately
     *      4. This allows the system to quickly respond to user interruptions
     * This approach ensures responsive conversation flow by allowing users to interrupt
     * lengthy responses without waiting for completion.
     * 
     * @param {string} role - Message role ('user' or 'system')
     * @param {string} prompt - Input message content
     * @throws {Error} If response generation fails
     * @calls responseHandler.content for streaming response chunks
     * @calls responseHandler.toolResult for tool execution results
     * @calls responseHandler.error for error events
     */
    async generateResponse(role: 'user' | 'system' = 'user', prompt: string): Promise<void> {
        this.isInterrupted = false;

        try {
            // Add the new message to input messages
            this.inputMessages.push({
                role: role === 'system' ? 'user' : role, // Responses API doesn't accept 'system' in input
                content: role === 'system' ? `System: ${prompt}` : prompt
            });

            const tools = this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined;

            // Create the response with streaming enabled
            const createParams: any = {
                model: this.model,
                input: this.inputMessages,
                stream: true,
                tools: tools,
                instructions: this.instructions
            };

            const stream = await this.openai.responses.create(createParams);

            // Process the stream using the helper method
            await this.processStream(stream);

        } catch (error) {
            this.responseHandler.error(error as Error);
            throw error;
        }
    }
}

export { OpenAIResponseService };
