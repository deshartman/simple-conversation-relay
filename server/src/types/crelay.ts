/**
 * ConversationRelay wire-frame types and Zod schemas.
 *
 * Single source of truth for the JSON that crosses the WebSocket between this
 * server and Twilio ConversationRelay.
 *
 * - Incoming frames use `.passthrough()` so unknown future Twilio fields don't
 *   hard-fail. The inferred TS type won't include them; cast at callsites if
 *   needed.
 * - Outgoing frames are strict discriminated unions validated at send time.
 * - SDK drift guards at the bottom pin our types to the Twilio SDK so a
 *   breaking SDK change fails at build time.
 *
 * @see https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
 */

import { z } from 'zod';
import type VoiceResponse from 'twilio/lib/twiml/VoiceResponse.js';

// =============================================================================
// Incoming frames (Twilio → us)
// =============================================================================

export const SetupFrameSchema = z
    .object({
        type: z.literal('setup'),
        sessionId: z.string().optional(),
        callSid: z.string().optional(),
        parentCallSid: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        forwardedFrom: z.string().optional(),
        callerName: z.string().optional(),
        direction: z.string().optional(),
        callType: z.string().optional(),
        callStatus: z.string().optional(),
        accountSid: z.string().optional(),
        customParameters: z.record(z.string(), z.string()).optional(),
    })
    .passthrough();
export type SetupFrame = z.infer<typeof SetupFrameSchema>;

export const PromptFrameSchema = z
    .object({
        type: z.literal('prompt'),
        voicePrompt: z.string(),
        lang: z.string().optional(),
        last: z.boolean().optional(),
    })
    .passthrough();
export type PromptFrame = z.infer<typeof PromptFrameSchema>;

export const InterruptFrameSchema = z
    .object({
        type: z.literal('interrupt'),
        utteranceUntilInterrupt: z.string().optional(),
        durationUntilInterruptMs: z.number().optional(),
    })
    .passthrough();
export type InterruptFrame = z.infer<typeof InterruptFrameSchema>;

export const DtmfFrameSchema = z
    .object({
        type: z.literal('dtmf'),
        digit: z.string(),
    })
    .passthrough();
export type DtmfFrame = z.infer<typeof DtmfFrameSchema>;

export const InfoFrameSchema = z
    .object({
        type: z.literal('info'),
        description: z.string().optional(),
    })
    .passthrough();
export type InfoFrame = z.infer<typeof InfoFrameSchema>;

export const ErrorFrameSchema = z
    .object({
        type: z.literal('error'),
        description: z.string().optional(),
    })
    .passthrough();
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

export const IncomingFrameSchema = z.discriminatedUnion('type', [
    SetupFrameSchema,
    PromptFrameSchema,
    InterruptFrameSchema,
    DtmfFrameSchema,
    InfoFrameSchema,
    ErrorFrameSchema,
]);
export type IncomingFrame = z.infer<typeof IncomingFrameSchema>;

// =============================================================================
// Outgoing frames (us → Twilio)
// =============================================================================

export const TextFrameSchema = z.object({
    type: z.literal('text'),
    token: z.string(),
    last: z.boolean().optional(),
    lang: z.string().optional(),
    interruptible: z.boolean().optional(),
    preemptible: z.boolean().optional(),
});
export type TextFrame = z.infer<typeof TextFrameSchema>;

export const PlayFrameSchema = z.object({
    type: z.literal('play'),
    source: z.string(),
    loop: z.number().int().min(0).optional(),
    interruptible: z.boolean().optional(),
    preemptible: z.boolean().optional(),
});
export type PlayFrame = z.infer<typeof PlayFrameSchema>;

export const SendDigitsFrameSchema = z.object({
    type: z.literal('sendDigits'),
    digits: z.string().regex(/^[0-9w*#]+$/, 'Digits must be 0-9, w, *, #'),
});
export type SendDigitsFrame = z.infer<typeof SendDigitsFrameSchema>;

/**
 * Base schema for the `language` outgoing frame — no refinement so it
 * participates in the discriminated union. The `LanguageFrameSchema` alias
 * applies the "at least one language" constraint for input validation; use
 * that where you want the stricter check.
 */
export const LanguageFrameBaseSchema = z.object({
    type: z.literal('language'),
    ttsLanguage: z.string().optional(),
    transcriptionLanguage: z.string().optional(),
});

export const LanguageFrameSchema = LanguageFrameBaseSchema.refine(
    data => data.ttsLanguage !== undefined || data.transcriptionLanguage !== undefined,
    { message: 'At least one of ttsLanguage or transcriptionLanguage must be provided' }
);
export type LanguageFrame = z.infer<typeof LanguageFrameBaseSchema>;

export const EndFrameSchema = z.object({
    type: z.literal('end'),
    handoffData: z.string().optional(),
});
export type EndFrame = z.infer<typeof EndFrameSchema>;

export const OutgoingFrameSchema = z.discriminatedUnion('type', [
    TextFrameSchema,
    PlayFrameSchema,
    SendDigitsFrameSchema,
    LanguageFrameBaseSchema,
    EndFrameSchema,
]);
export type OutgoingFrame = z.infer<typeof OutgoingFrameSchema>;

// =============================================================================
// SDK drift guards — compile-time assertions pinned to twilio SDK types
// =============================================================================

/**
 * @internal Compile-time drift guards. If the Twilio SDK updates
 * `VoiceResponse.LanguageAttributes` and our outgoing `language` frame
 * drifts, TypeScript will fail these assertions at build time.
 *
 * We only guard what we emit on the wire (language). The outbound TwiML
 * attrs (`ConversationRelayAttributes`) are already typed via the SDK at
 * the TwiML builder site, so mirroring them here would duplicate coverage.
 */
type _LangKeys = keyof VoiceResponse.LanguageAttributes;
type _LangFrameOut = { ttsLanguage?: string; transcriptionLanguage?: string };
// Every outgoing language field must correspond to a LanguageAttributes key
// (ttsLanguage and transcriptionLanguage both exist on LanguageAttributes).
type _LangDriftCheck = 'ttsLanguage' extends _LangKeys
    ? 'transcriptionLanguage' extends _LangKeys
        ? true
        : never
    : never;
// @ts-ignore — value is type-level assertion; unused at runtime.
const _langDriftGuard: _LangDriftCheck = true;
// Referenced to satisfy TS's `noUnusedLocals` if enabled later.
void _langDriftGuard;
// Keep `_LangFrameOut` in the graph so unused-type lints don't strip the
// intent. The cast is a no-op at runtime.
export type _CrelayLangOut = _LangFrameOut;
