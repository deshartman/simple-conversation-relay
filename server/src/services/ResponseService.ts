/**
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
 * 3. Event Management:
 *    - Emits content events for responses
 *    - Emits tool result events
 *    - Handles errors and interruptions
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
 * @extends EventEmitter
 * @property {OpenAI} openai - OpenAI API client instance
 * @property {string} model - Model to use (from environment variables)
 * @property {string} currentResponseId - Current response ID for conversation continuity
 * @property {string} instructions - System instructions/context from context.md
 * @property {Object} toolManifest - Tool definitions from toolManifest.json
 * @property {Object} loadedTools - Map of loaded tool functions
 * @property {Array} inputMessages - Message history for Responses API
 *
 * Events Emitted:
 * - responseService.content: Response content chunks
 * - responseService.toolResult: Results from tool executions
 * - responseService.error: Error events
 */

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Import proper OpenAI types
// Note: ResponseInput is not yet exported in main OpenAI namespace (see issue #1378)
// Using direct import as recommended workaround until it's properly exported
import type {
  ResponseInput,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.mjs";

import { logOut, logError } from "../utils/logger.js";

dotenv.config();

/**
 * Interface for content response
 */
interface ContentResponse {
  type: string;
  token: string;
  last: boolean;
}

// ToolEvent interface for tool execution context. This is used by tools to emit events
interface ToolEvent {
  emit: (eventType: string, data: any) => void;
  log: (message: string) => void;
  logError: (message: string) => void;
}

/**
 * Interface for tool result
 */
interface ToolResult {
  success: boolean;
  message: string;
  [key: string]: any; // Allows additional properties like digits, recipient, summary, etc.
}

/**
 * Type for loaded tool function
 */
type ToolFunction = (
  args: any,
  toolEvent?: ToolEvent
) => Promise<ToolResult> | ToolResult;

/**
 * Interface for tool call from streaming events
 */
interface ResponsesAPIToolCall {
  id: string;
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

class ResponseService extends EventEmitter {
  protected openai: OpenAI;
  protected model: string;
  protected currentResponseId: string | null;
  protected instructions: string;
  protected abortController: AbortController | null;
  protected toolManifest: { tools: any[] };
  protected toolDefinitions: any[];
  protected loadedTools: Record<string, ToolFunction>;
  protected inputMessages: ResponseInput;

  /**
   * Creates a new ResponseService instance.
   * Initializes client, loads tools from manifest, and sets up initial state.
   *
   * @throws {Error} If tool loading fails
   */
  constructor() {
    super();
    this.openai = new OpenAI();
    this.model = process.env.OPENAI_MODEL || "gpt-4o";
    this.currentResponseId = null;
    this.instructions = "";
    this.abortController = null;
    this.toolManifest = { tools: [] };
    this.toolDefinitions = [];
    this.loadedTools = {};
    this.inputMessages = [];

    // Which Context, Tool Manifest to use for this call (or the default)
    const contextFile = process.env.LLM_CONTEXT || "defaultContext.md";
    const toolManifestFile =
      process.env.LLM_MANIFEST || "defaultToolManifest.json";

    // Initialize context and tools using updateContext
    this.updateContextAndManifest(contextFile, toolManifestFile);
  }

  /**
   * Creates a ToolEvent object that tools can use to emit events
   */
  private createToolEvent(): ToolEvent {
    return {
      emit: (eventType: string, data: any) => {
        this.emit("responseService.toolResult", {
          toolType: eventType,
          toolData: data,
        });
      },
      log: (message: string) => logOut("Tool", message),
      logError: (message: string) => logError("Tool", message),
    };
  }

  /**
   * Executes a tool call with proper type safety
   *
   * @param {ResponsesAPIToolCall} tool - Tool call object
   * @returns {Promise<ToolResult|null>} Tool execution result or null if execution fails
   */
  async executeToolCall(
    tool: ResponsesAPIToolCall
  ): Promise<ToolResult | null> {
    try {
      const calledTool: ToolFunction = this.loadedTools[tool.name];
      const calledToolArgs = JSON.parse(tool.arguments);

      // Create ToolEvent for the tool
      const toolEvent = this.createToolEvent();

      // Call the tool with both arguments and toolEvent
      const toolResponse: ToolResult = await calledTool(
        calledToolArgs,
        toolEvent
      );

      return toolResponse;
    } catch (error) {
      logError(
        "ResponseService",
        `Tool call failed: ${tool.name} with arguments: ${tool.arguments}`
      );
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
    logOut(
      "ResponseService",
      "Cleared conversation history - will start new thread"
    );
  }

  /**
   * Interrupts current response generation.
   * Triggers the AbortController to stop streaming immediately.
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
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Inserts a message into conversation context without generating a response.
   * With the Responses API, this is handled by adding to the input messages array.
   *
   * @param {string} role - Message role ('system', 'user', or 'assistant')
   * @param {string} message - Message content to add to context
   */
  async insertMessageIntoContext(
    role: "system" | "user" | "assistant" = "system",
    message: string
  ): Promise<void> {
    try {
      switch (role) {
        case "system":
          // System messages can be added as instructions updates
          this.instructions += `\n\n${message}`;
          break;
        case "user":
        case "assistant":
          // For user/assistant messages, add to input messages
          this.inputMessages.push({
            role: role,
            content: message,
          });
          break;
        default:
          logError("ResponseService", `Unknown role: ${role}`);
          break;
      }
    } catch (error) {
      logError(
        "ResponseService",
        `Error inserting message into context: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Updates the context and tool manifest files used by the service dynamically. The name passed in will be used to load the context and tool manifest files.
   * The convention is that the context and manifest files will be stored in the assets directory.
   *
   * @param {string} contextFile - Path to the new context.md file
   * @param {string} toolManifestFile - Path to the new toolManifest.json file
   * @throws {Error} If file loading fails
   */
  async updateContextAndManifest(
    contextFile: string,
    toolManifestFile: string
  ): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    try {
      // Load new context and tool manifest from provided file paths
      const assetsDir = path.join(__dirname, "..", "..", "assets");
      const context = fs.readFileSync(
        path.join(assetsDir, contextFile),
        "utf8"
      );
      const toolManifestPath = path.join(assetsDir, toolManifestFile);
      const toolManifest = JSON.parse(
        fs.readFileSync(toolManifestPath, "utf8")
      ) as { tools: any[] };

      // Update instructions and reset conversation
      this.instructions = context;
      this.currentResponseId = null; // Reset conversation to use new context
      this.inputMessages = []; // Reset input messages

      // Update tool definitions and reload tools
      this.toolManifest = toolManifest;
      this.toolDefinitions = toolManifest.tools;
      this.loadedTools = {};

      logOut("ResponseService", `Reloading tools...`);
      for (const tool of this.toolDefinitions) {
        if (tool.type === "function") {
          let functionName = tool.function?.name || tool.name;
          try {
            // Dynamic import for ES modules - use same path resolution as ChatCompletions version
            const toolsDir = path.join(__dirname, "..", "tools");
            const toolModule = await import(
              path.join(toolsDir, `${functionName}.js`)
            );
            this.loadedTools[functionName] = toolModule.default;
            logOut("ResponseService", `Loaded function: ${functionName}`);
          } catch (error) {
            logError(
              "ResponseService",
              `Error loading tool ${functionName}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      }
      logOut(
        "ResponseService",
        `Loaded ${Object.keys(this.loadedTools).length} tools`
      );
    } catch (error) {
      logError(
        "ResponseService",
        `Error updating context. Please ensure the files are in the /assets directory: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  /**
   * Performs cleanup of service resources.
   * Removes all event listeners to prevent memory leaks.
   */
  cleanup(): void {
    // Remove all event listeners
    this.removeAllListeners();
  }

  /**
   * Processes a stream and handles tool calls by creating follow-up responses.
   * This is a helper method to reduce code duplication between initial and follow-up streams.
   */
  private async processStream(stream: any): Promise<void> {
    let currentToolCall: ResponsesAPIToolCall | null = null;

    // @ts-ignore - TypeScript doesn't recognize the async iterator on the Responses API stream yet
    for await (const event of stream) {
      const eventData = event as ResponseStreamEvent;

      // Handle different event types from the Responses API
      switch (eventData.type) {
        case "response.output_text.delta":
          // Text content streaming
          const content = eventData.delta || "";
          if (content) {
            this.emit("responseService.content", {
              type: "text",
              token: content,
              last: false,
            } as ContentResponse);
          }
          break;

        case "response.output_item.added":
          if (eventData.item?.type === "function_call") {
            currentToolCall = {
              id: eventData.item.id || "unknown",
              type: "function_call",
              call_id: eventData.item.call_id || eventData.item.id || "unknown",
              name: eventData.item.name || "",
              arguments: eventData.item.arguments || "",
            };
          }
          break;

        case "response.function_call_arguments.delta":
          // Function call arguments streaming - accumulate the arguments
          if (currentToolCall && eventData.delta) {
            currentToolCall.arguments += eventData.delta;
          }
          break;

        case "response.function_call_arguments.done":
          // Function call completed - execute it and create follow-up response
          if (currentToolCall) {
            try {
              const toolResult: ToolResult | null = await this.executeToolCall(
                currentToolCall
              );

              if (toolResult !== null) {
                // Always add function call and result to conversation
                this.inputMessages.push({
                  type: "function_call",
                  id: currentToolCall.id,
                  call_id: currentToolCall.call_id,
                  name: currentToolCall.name,
                  arguments: currentToolCall.arguments,
                });

                // Add function result to input messages
                this.inputMessages.push({
                  type: "function_call_output",
                  call_id: currentToolCall.call_id,
                  output: JSON.stringify(toolResult),
                });

                const completionParams: OpenAI.Responses.ResponseCreateParamsStreaming =
                  {
                    model: this.model,
                    input: this.inputMessages,
                    tools:
                      this.toolDefinitions.length > 0
                        ? this.toolDefinitions
                        : undefined,
                    previous_response_id: this.currentResponseId,
                    store: true,
                    stream: true,
                  };

                // Create follow-up response with tool results
                const followUpStream = await this.openai.responses.stream(
                  completionParams,
                  {
                    // Pass the abort signal via options parameter
                    signal: this.abortController?.signal,
                  }
                );

                // Process the follow-up stream recursively
                await this.processStream(followUpStream);
              } else {
                logError(
                  "ResponseService",
                  `Tool execution returned null result`
                );
              }
            } catch (error) {
              logError(
                "ResponseService",
                `Error executing tool ${currentToolCall.name}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }

            currentToolCall = null;
          } else {
            logError(
              "ResponseService",
              `Function call completed but no currentToolCall available`
            );
          }
          break;

        case "response.completed":
          // Response completed - store the response ID for conversation continuity
          if ("response" in eventData && eventData.response?.id) {
            this.currentResponseId = eventData.response.id;
          }

          // Only emit final content marker if this is the end of the conversation
          // (not if we're about to create a follow-up for tool results)
          if (!currentToolCall) {
            this.emit("responseService.content", {
              type: "text",
              token: "",
              last: true,
            } as ContentResponse);
          }
          break;
        case "response.created":
        case "response.in_progress":
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.output_item.done":
        case "response.completed":
        case "response.output_text.done":
          // These events don't require special handling
          break;
        default:
          // Handle any unrecognized event types
          logOut("ResponseService", `Unhandled event type: ${eventData.type}`);
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
   *      1. Content chunks are emitted directly via 'responseService.content' events
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
   *      1. An AbortController is created at the start of each response
   *      2. During streaming, the AbortController may send a signal to the stream
   *      3. If an interruption is detected, the streaming loop breaks immediately
   *      4. This allows the system to quickly respond to user interruptions
   * This approach ensures responsive conversation flow by allowing users to interrupt
   * lengthy responses without waiting for completion.
   *
   * @param {string} role - Message role ('user' or 'system')
   * @param {string} prompt - Input message content
   * @throws {Error} If response generation fails
   * @emits responseService.content
   * @emits responseService.toolResult
   * @emits responseService.error
   */
  async generateResponse(
    role: "user" | "system" = "user",
    prompt: string
  ): Promise<void> {
    // Create a new AbortController for this response
    this.abortController = new AbortController();

    try {
      // Add the new message to input messages
      this.inputMessages.push({
        role: role === "system" ? "user" : role, // Responses API doesn't accept 'system' in input
        content: role === "system" ? `System: ${prompt}` : prompt,
      });

      const tools =
        this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined;

      // Create the response with streaming enabled
      const createParams: OpenAI.Responses.ResponseCreateParamsStreaming = {
        model: this.model,
        input: this.inputMessages,
        stream: true,
        store: true, // Enable conversation storage
        tools: tools,
      };

      // If we have an existing conversation, continue it
      if (this.currentResponseId) {
        createParams.previous_response_id = this.currentResponseId;
      } else {
        // Only add instructions on new conversations
        createParams.instructions = this.instructions;
      }

      const stream = await this.openai.responses.stream(createParams, {
        // Pass the abort signal via options parameter
        signal: this.abortController.signal,
      });

      // Process the stream using the helper method
      await this.processStream(stream);
    } catch (error) {
      this.emit("responseService.error", error);
      throw error;
    }
  }
}

export { ResponseService };
