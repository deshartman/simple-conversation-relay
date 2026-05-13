/**
 * Legacy CR type surface.
 *
 * v4.12: The wire-frame types live in `src/types/crelay.ts` (Zod-inferred).
 * This file now re-exports those for back-compat with existing imports, and
 * retains:
 *
 *   - The Twilio SDK-backed TwiML configuration types (`ConversationRelay`
 *     etc.) used by the TwiML builder in `TwilioService`.
 *   - `SessionData`, consumed by the server WS handler and session class.
 *   - `ConversationRelayConfig`, the extended TwiML config shape used in
 *     `serverConfig.json`.
 */

import type { VoiceResponse } from 'twilio/lib/twiml/VoiceResponse.js';

// -- TwiML types (unchanged) -------------------------------------------------

export type ConversationRelay = VoiceResponse.ConversationRelayAttributes;
export type ConversationRelayLanguage = VoiceResponse.LanguageAttributes;
export type ConversationRelayParameter = VoiceResponse.ParameterAttributes;

export interface ConversationRelayConfig extends ConversationRelay {
    languages?: ConversationRelayLanguage[];
    parameters?: ConversationRelayParameter[];
}

// -- Session data ------------------------------------------------------------

export interface SessionData {
    parameterData: Record<string, any>;
    setupData: {
        callSid: string;
        [key: string]: any;
    };
}

// -- Re-exports from the Zod source-of-truth --------------------------------

export type {
    SetupFrame as SetupMessage,
    PromptFrame as PromptMessage,
    DtmfFrame as DTMFMessage,
    InterruptFrame as InterruptMessage,
    InfoFrame as InfoMessage,
    ErrorFrame as ErrorMessage,
    IncomingFrame as IncomingMessage,
    TextFrame as TextTokensMessage,
    PlayFrame as PlayMediaMessage,
    SendDigitsFrame as SendDigitsMessage,
    LanguageFrame as SwitchLanguageMessage,
    EndFrame as EndSessionMessage,
    OutgoingFrame as OutgoingMessage,
} from '../types/crelay.js';

// -- Handler interface -------------------------------------------------------

/**
 * Kept for callers that still construct a plain handler object (e.g. the
 * `/conversation` HTTP endpoint). The session class provides a richer
 * internal interface.
 */
export interface ConversationRelayHandler {
    outgoingMessage(message: unknown): void;
    callSid(callSid: string, responseMessage: any): void;
}
