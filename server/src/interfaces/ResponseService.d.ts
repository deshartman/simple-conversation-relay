/**
 * Interface for Response Service implementations
 * Defines the contract that all LLM services must implement for conversation handling
 */

/**
 * Handler function type for content responses from LLM services
 */
export type ContentHandler = (response: ContentResponse) => void;

/**
 * Handler function type for tool result events from LLM services
 */
export type ToolResultHandler = (toolResult: ToolResultEvent) => void;

/**
 * Handler function type for error events from LLM services
 */
export type ErrorHandler = (error: Error) => void;

/**
 * Unified response handler interface for dependency injection
 */
export interface ResponseHandler {
    content(response: ContentResponse): void;
    toolResult(toolResult: ToolResultEvent): void;
    error(error: Error): void;
    callSid(callSid: string, responseMessage: any): void;
    /**
     * Optional. Called when a tool call begins execution — before the
     * handler promise resolves. Lets the caller (typically a
     * `ConversationRelaySession`) track in-flight tool promises so
     * terminal-text flushing can await them.
     */
    toolCallStart?(promise: Promise<unknown>): void;
}

/**
 * Interface for content response chunks
 */
export interface ContentResponse {
    type: string;
    token: string;
    last: boolean;
}

/**
 * Interface for tool result events
 */
export interface ToolResultEvent {
    toolType: string;  // The tool name (e.g., "send-dtmf", "live-agent-handoff", "send-sms")
    toolData: ToolResult; // The complete tool result including outgoingMessage for CRelay tools
}

/**
 * Interface for tool result from individual tool execution
 */
export interface ToolResult {
    success: boolean;
    message: string;
    [key: string]: any; // Allows additional properties like digits, recipient, summary, etc.
}

/**
 * Interface that all Response Service implementations must follow
 * Uses dependency injection with unified response handler for better type safety
 */
export interface ResponseService {
        /**
         * Creates and sets up the response handler for the service
         * 
         * @param handler - Unified handler for all response events
         */
        createResponseHandler(handler: ResponseHandler): void;
        /**
         * Generates a streaming response from the LLM service
         * 
         * @param role - Message role ('user' or 'system')
         * @param prompt - Input message content
         * @returns Promise that resolves when response generation starts
         */
        generateResponse(role: 'user' | 'system', prompt: string): Promise<void>;

        /**
         * Inserts a message into conversation context without generating a response
         * 
         * @param role - Message role ('system', 'user', or 'assistant')
         * @param message - Message content to add to context
         * @returns Promise that resolves when message is inserted
         */
        insertMessage(role: 'system' | 'user' | 'assistant', message: string): Promise<void>;

        /**
         * Interrupts current response generation
         * Used when user interrupts AI during response to stop streaming
         */
        interrupt(): void;

        /**
         * Updates the context for the response service
         * 
         * @param context - New context content string
         * @returns Promise that resolves when update is complete
         */
        updateContext(context: string): Promise<void>;

        /**
         * Updates the tool registry for the response service.
         * v4.12: replaced the `object` (JSON manifest) arg with a
         * `ToolRegistry`. Typed as `any` in this declaration file to avoid a
         * cross-layer import; implementations narrow it.
         */
        updateTools(registry: any): void;

        /**
         * Performs cleanup of service resources
         * Clears handlers and cleans up any active connections
         */
        cleanup(): void;
    }