/**
 * Base service class for handling LLM API interactions and managing conversation flow.
 * This service orchestrates:
 * 
 * 1. Message Management:
 *    - Maintains conversation history
 *    - Processes incoming messages
 *    - Handles tool calls and responses
 *    - Manages streaming responses
 * 
 * 2. Tool Integration:
 *    - Dynamically loads tools from manifest
 *    - Executes tool calls
 *    - Handles tool responses
 * 
 * 3. Event Management:
 *    - Emits content events for responses
 *    - Emits tool result events
 *    - Handles errors and interruptions
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
 * @extends EventEmitter
 * @property {OpenAI} openai - OpenAI API client instance
 * @property {string} model - Model to use (from environment variables)
 * @property {Array} messages - Conversation history
 * @property {string} promptContext - Initial context from context.md
 * @property {Object} toolManifest - Tool definitions from toolManifest.json
 * @property {boolean} isInterrupted - Flag for interrupting response generation
 * @property {Object} loadedTools - Map of loaded tool functions
 * 
 * Events Emitted:
 * - llm.content: Response content chunks
 * - llm.toolResult: Results from tool executions
 * - llm.error: Error events
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { logOut, logError } = require('../utils/logger');

class ResponseService extends EventEmitter {
    /**
     * Creates a new ResponseService instance.
     * Initializes client, loads tools from manifest, and sets up initial state.
     * 
     * @param {string} contextFile - Path to the context.md file
     * @param {string} toolManifestFile - Path to the toolManifest.json file
     * @throws {Error} If tool loading fails
     */
    constructor(contextFile, toolManifestFile) {
        super();
        this.messages = [];
        this.isInterrupted = false;

        // Initialize context and tools using updateContext
        this.updateContextAndManifest(contextFile, toolManifestFile);
    }

    /**
     * Sets call-specific parameters for the conversation.
     * Updates message history with call details for tool usage.
     * 
     * @param {string} to - Twilio number receiving the call
     * @param {string} from - Customer's phone number
     * @param {string} callSid - Unique Twilio call identifier
     */
    setCallParameters(to, from, callSid) {
        this.twilioNumber = to;
        this.customerNumber = from;
        this.callSid = callSid;

        logOut('ResponseService', `Call to: ${this.twilioNumber} from: ${this.customerNumber} with call SID: ${this.callSid}`);
        this.messages.push({
            role: 'system',
            content: `The customer phone number or "from" number is ${this.customerNumber}, the callSid is ${this.callSid} and the number to send SMSs from is: ${this.twilioNumber}. Use this information throughout as the reference when calling any of the tools. Specifically use the callSid when you use the "transfer-to-agent" tool to transfer the call to the agent`
        });
    }

    /**
     * Executes a tool call based on function calling feature.
     * 
     * @param {Object} tool - Tool call object
     * @param {Object} tool.function - Function details
     * @param {string} tool.function.name - Name of the tool to execute
     * @param {string} tool.function.arguments - JSON string of arguments
     * @returns {Promise<Object|null>} Tool execution result or null if execution fails
     */
    async executeToolCall(tool) {
        logOut('ResponseService', `Executing tool call with tool being: ${JSON.stringify(tool, null, 4)} `);

        try {
            let calledTool = this.loadedTools[tool.function.name];
            let calledToolArgs = JSON.parse(tool.function.arguments);
            logOut('ResponseService', `Executing tool call: ${tool.function.name} with args: ${JSON.stringify(calledToolArgs, null, 4)}`);

            // Now run the loaded tool
            let toolResponse = calledTool(calledToolArgs);

            return toolResponse;
        } catch (error) {
            console.error(`ResponseService Error executing tool ${tool.function.name}:`, error);
            return null;
        }
    }

    /**
     * Retrieves the current conversation history.
     * 
     * @returns {Array} Array of message objects
     */
    getMessages() {
        return this.messages;
    }

    /**
     * Clears conversation history except for the initial system message.
     */
    clearMessages() {
        const systemMessage = this.messages[0];
        this.messages = [systemMessage];
    }

    /**
     * Interrupts current response generation.
     * Sets isInterrupted flag to true to stop streaming.
     */
    interrupt() {
        this.isInterrupted = true;
    }

    /**
     * Resets the interruption flag.
     * Allows new responses to be generated after an interruption.
     */
    resetInterrupt() {
        this.isInterrupted = false;
    }

    /**
     * Inserts a message into conversation context without generating a response.
     * Used for live agent handling when an agent interjects in the conversation.
     * 
     * @param {string} role - Message role ('system' or 'user')
     * @param {string} message - Message content to add to context
     */
    async insertMessageIntoContext(role = 'system', message) {
        logOut('ResponseService', `Inserting message into context: ${role}: ${message}`);
        this.messages.push({ role, content: message });
    }

    /**
     * Updates the context and tool manifest files used by the service dynamically. The name passed in will be used to load the context and tool manifest files.
     * The convention is that the context and manifest filles will be stored in the assets directory.
     * 
     * @param {string} contextFile - Path to the new context.md file
     * @param {string} toolManifestFile - Path to the new toolManifest.json file
     * @throws {Error} If file loading fails
     */
    updateContextAndManifest(contextFile, toolManifestFile) {
        logOut('ResponseService', `Updating context with new files: ${contextFile}, ${toolManifestFile}`);

        try {
            // Load new context and tool manifest from provided file paths
            const context = fs.readFileSync(path.join(__dirname, `../assets/${contextFile}`), 'utf8');
            const toolManifest = require(path.join(__dirname, `../assets/${toolManifestFile}`));

            // Reset conversation history and initialize with new system context
            this.messages = [{
                role: 'system',
                content: context
            }];

            // Update tool definitions and reload tools
            this.toolManifest = toolManifest;

            // Update tool definitions and reload tools
            this.toolDefinitions = toolManifest.tools;
            this.loadedTools = {};

            logOut('ResponseService', `Reloading tools...`);
            this.toolDefinitions.forEach((tool) => {
                let functionName = tool.function.name;
                this.loadedTools[functionName] = require(`../tools/${functionName}`);
                logOut('ResponseService', `Loaded function: ${functionName}`);
            });
            logOut('ResponseService', `Loaded ${this.toolDefinitions.length} tools`);

        } catch (error) {
            logError('ResponseService', `Error updating context. Please ensure the files are in the /assets directory:`, error);
            throw error;
        }
    }

    /**
     * Performs cleanup of service resources.
     * Removes all event listeners to prevent memory leaks.
     */
    cleanup() {
        // Remove all event listeners
        this.removeAllListeners();
    }

    /**
     * Generates a streaming response using the LLM API.
     * Handles tool calls, manages conversation history, and emits response chunks.
     * 
     *  == Streaming and Tool Calls ==
     * The service handles streaming responses that may include both content and tool calls:
     *      1. Content chunks are emitted directly via 'llm.content' events
     *      2. Tool call chunks are accumulated until complete, as they may span multiple chunks
     *      3. When a complete tool call is received (finish_reason='tool_calls'):
     *          - The tool is executed with the assembled arguments
     *          - The result is added to conversation history
     *          - A new stream is created to continue the conversation with the tool result
     * This chunked approach ensures reliable tool execution even with complex arguments while maintaining a responsive streaming experience.
     * 
     * == Tool Execution Flow ==
     * When the LLM suggests a tool call, the executeToolCall method processes it by:
     *      1. Retrieving the tool function from the loadedTools map using the tool name
     *      2. Parsing the JSON string arguments into an object
     *      3. Executing the tool with the parsed arguments
     *      4. Returning the tool's response for inclusion in the conversation
     * 
     * @param {string} role - Message role ('user' or 'system')
     * @param {string} prompt - Input message content
     * @throws {Error} If response generation fails
     * @emits llm.content
     * @emits llm.toolResult
     * @emits llm.error
     */
    async generateResponse(role = 'user', prompt) {
        let fullResponse = '';
        let toolCallCollector = null;
        logOut('ResponseService', `Generating response for ${role}: ${prompt}`);

        try {
            // Add the prompt message to history
            this.messages.push({ role: role, content: prompt });

            const stream = await this.openai.chat.completions.create({
                model: this.model,
                messages: this.messages,
                tools: this.toolManifest.tools,
                stream: true
            });

            logOut('ResponseService', `Stream created`);

            for await (const chunk of stream) {
                if (this.isInterrupted) {
                    break;
                }

                const content = chunk.choices[0]?.delta?.content || '';
                const toolCalls = chunk.choices[0]?.delta?.tool_calls;

                if (content) {
                    fullResponse += content;
                    this.emit('llm.content', {
                        type: "text",
                        token: content,
                        last: false
                    });
                }

                if (toolCalls && toolCalls.length > 0) {
                    const toolCall = toolCalls[0];

                    // Initialize collector if this is the first tool call chunk
                    if (!toolCallCollector) {
                        toolCallCollector = {
                            id: toolCall.id || '',
                            type: "function",
                            function: {
                                name: '',
                                arguments: ''
                            }
                        };
                    }

                    // Store the ID if it's present
                    if (toolCall.id) {
                        toolCallCollector.id = toolCall.id;
                    }

                    // Store the name if it's present
                    if (toolCall.function?.name) {
                        toolCallCollector.function.name = toolCall.function.name;
                    }

                    // Accumulate arguments if they're present
                    if (toolCall.function?.arguments) {
                        toolCallCollector.function.arguments += toolCall.function.arguments;
                    }
                }

                if (chunk.choices[0]?.finish_reason === 'tool_calls' && toolCallCollector) {

                    const toolCallObj = {
                        id: toolCallCollector.id,
                        type: "function",
                        function: {
                            name: toolCallCollector.function.name,
                            arguments: toolCallCollector.function.arguments
                        }
                    };

                    let toolResult = null;
                    try {
                        let calledTool = this.loadedTools[toolCallObj.function.name];
                        let calledToolArgs = JSON.parse(toolCallObj.function.arguments);

                        toolResult = await calledTool(calledToolArgs);

                        // Emit the tool result if anybody needs to use it
                        this.emit('llm.toolResult', toolResult);

                    } catch (error) {
                        logError('ResponseService', `Error executing tool ${toolCallObj.function.name}:`, error);
                    }

                    // Add assistant response and tool result to history
                    this.messages.push({
                        role: "assistant",
                        content: fullResponse,
                        tool_calls: [toolCallObj]
                    });

                    this.messages.push({
                        role: "tool",
                        content: JSON.stringify(toolResult),
                        tool_call_id: toolCallObj.id
                    });

                    // Continue the conversation with tool results
                    const followUpStream = await this.openai.chat.completions.create({
                        model: this.model,
                        messages: this.messages,
                        stream: true
                    });

                    for await (const chunk of followUpStream) {
                        if (this.isInterrupted) {
                            break;
                        }
                        const content = chunk.choices[0]?.delta?.content || '';
                        if (content) {
                            fullResponse += content;
                            this.emit('llm.content', {
                                type: "text",
                                token: content,
                                last: false
                            });
                        }
                    }
                }
            }

            // Add final assistant response to history if no tool was called
            if (!toolCallCollector) {
                this.messages.push({
                    role: "assistant",
                    content: fullResponse
                });
            }

            // Emit the final content with last=true
            this.emit('llm.content', {
                type: "text",
                token: '',
                last: true
            });

        } catch (error) {
            this.emit('llm.error', error);
            throw error;
        }
    }
}

module.exports = { ResponseService };
