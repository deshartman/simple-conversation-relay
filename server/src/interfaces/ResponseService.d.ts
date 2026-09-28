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
 * Call events the transport (ConversationRelaySession) reports to the service.
 * These are SCR's own events, not raw CR frames: `info`/`error` frames are
 * transport noise, and `status` is not a CR frame at all.
 */
export type CallEvent =
    | {
          type: 'setup';
          /** The CR setup frame: callSid, from, to, direction, customParameters, … */
          setup: { callSid?: string; from?: string; customParameters?: Record<string, string>; [key: string]: any };
          /** Request data stored for SCR-originated outbound calls (callReference). */
          parameters: Record<string, any>;
      }
    | { type: 'prompt'; text: string; lang?: string }
    | { type: 'dtmf'; digit: string }
    | {
          type: 'interrupt';
          /** CR's `utteranceUntilInterrupt` — what the caller actually heard. */
          heard?: string;
      }
    | {
          type: 'status';
          /** Evaluated Twilio status callback (see TwilioService.evaluateStatusCallback). */
          status: unknown;
      }
    | {
          type: 'context';
          /**
           * Operator request (POST /updateResponseService) to switch this call's
           * prompt. The service resolves the key; services that don't own a
           * prompt ignore it.
           */
          key: string;
      };

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
         * Single entry point for call events, mirroring the transport's switch
         * on CR frame type. The service decides what each event means for the
         * conversation (prompt, context, tools); the transport only reports.
         */
        handleEvent(event: CallEvent): Promise<void>;

        /**
         * Optional wording for the transport's silence reminder `count` (1-based).
         * The transport owns the policy — when to remind and when to end the
         * call — so this only supplies words. Return null (or omit the method)
         * to use the configured `SilenceDetection.messages`.
         */
        silenceReminder?(count: number): Promise<string | null>;

        /**
         * Performs cleanup of service resources
         * Clears handlers and cleans up any active connections
         */
        cleanup(): void;
    }