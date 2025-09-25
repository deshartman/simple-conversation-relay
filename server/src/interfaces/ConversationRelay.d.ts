/**
 * ConversationRelay Type Definitions
 * Centralized type definitions for IncomingMessage and OutgoingMessage interfaces
 */

/**
 * Interface for incoming messages from clients
 * Combines all fields from both server.ts and ConversationRelayService.ts definitions
 */
export interface IncomingMessage {
    type: 'setup' | 'prompt' | 'dtmf' | 'interrupt' | 'info' | 'error';
    callSid?: string;
    customParameters?: {
        callReference?: string;
        contextFile?: string;
        toolManifestFile?: string;
    };
    voicePrompt?: string;
    utteranceUntilInterrupt?: string;
    digit?: string;
    description?: string;
    [key: string]: any;
}

/**
 * Text tokens message for streaming text responses
 */
export interface TextTokensMessage {
    type: 'text-tokens';
    text: string;
    [key: string]: any;
}

/**
 * Play media message for audio content
 */
export interface PlayMediaMessage {
    type: 'play-media';
    mediaUrl: string;
    [key: string]: any;
}

/**
 * Send digits message for DTMF tones
 */
export interface SendDigitsMessage {
    type: 'send-digits';
    digits: string;
    [key: string]: any;
}

/**
 * Switch language message for changing conversation language
 */
export interface SwitchLanguageMessage {
    type: 'switch-language';
    language: string;
    [key: string]: any;
}

/**
 * End session message for terminating the conversation
 */
export interface EndSessionMessage {
    type: 'end-session';
    reason?: string;
    [key: string]: any;
}

/**
 * Union type for all outgoing message types
 */
export type OutgoingMessage = TextTokensMessage | PlayMediaMessage | SendDigitsMessage | SwitchLanguageMessage | EndSessionMessage;

/**
 * Interface for session data
 * Combines fields from both server.ts and ConversationRelayService.ts definitions
 */
export interface SessionData {
    parameterData: Record<string, any>;
    setupData: {
        callSid: string;
        customParameters?: {
            callReference?: string;
            contextFile?: string;
            toolManifestFile?: string;
        };
        [key: string]: any;
    };
}

/**
 * Interface for tool execution context
 * Used by tools to emit events and log messages
 */
export interface ToolEvent {
    emit: (eventType: string, data: any) => void;
    log: (message: string) => void;
    logError: (message: string) => void;
}

/**
 * Interface for tool execution results
 */
export interface ToolResult {
    success: boolean;
    message: string;
    [key: string]: any; // Allows additional properties like digits, recipient, summary, etc.
}