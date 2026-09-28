/**
 * ConversationRelaySession — one WebSocket, one session.
 *
 * Replaces v4.11's `ConversationRelayService`. Owns every scrap of per-call
 * state that used to be scattered across the service + server.ts + callback
 * plumbing:
 *
 *   - callSid, from, to, startedAt, customParameters (session identity)
 *   - listenMode + suppressedCount
 *   - SilenceHandler (per-session, not a module-level timer)
 *   - pendingTerminalFrame — deferred `end` frame waiting for farewell flush
 *   - inFlightToolCalls — tool promises still resolving; sendText(last:true)
 *     awaits this set before emitting the terminal text so tools that stash
 *     terminal frames during the same turn get a chance to land first.
 *
 * The session is the SOLE writer to the WebSocket. `send` is injected as a
 * constructor callback so the class doesn't import `ws` directly (keeps it
 * test-friendly and decoupled from the transport).
 *
 * Ported from packages/conversationrelay/src/lib/conversation-relay-session.ts
 * in twilio-innovation/twilio-agent-connect-typescript PR #54.
 */

import { logOut, logError } from '../utils/logger.js';
import { SilenceHandler } from './SilenceHandler.js';
import type { SilenceDetectionConfig } from './SilenceHandler.js';
import type { ResponseService, ResponseHandler, ContentResponse, ToolResultEvent } from '../interfaces/ResponseService.js';
import type { SessionData, IncomingMessage } from '../interfaces/ConversationRelay.js';
import {
    OutgoingFrameSchema,
    type OutgoingFrame,
} from '../types/crelay.js';

/**
 * Outgoing frame types suppressed when listen-mode is enabled.
 * `sendDigits` and `end` are deliberately excluded — DTMF navigation and
 * call termination must always work.
 */
/**
 * How long a silence reminder waits for service wording before the configured
 * wording is spoken. Enforced here, not trusted to the service: the caller is
 * already waiting, and a hung service must not swallow the reminder.
 */
const SILENCE_WORDING_TIMEOUT_MS = 1500;

const LISTEN_MODE_GATED: ReadonlySet<OutgoingFrame['type']> = new Set(['text', 'play', 'language']);

export interface ConversationRelaySessionOptions {
    responseService: ResponseService;
    sessionData: SessionData;
    silenceConfig: SilenceDetectionConfig;
    initialListenMode: boolean;
    /** Inject the ws.send wrapper. The session never touches `ws` directly. */
    send: (frame: OutgoingFrame) => void;
    /**
     * Language codes declared as <Language> children in the TwiML, e.g.
     * ['en-AU', 'fr-FR']. Doubles as the allow-list for automatic TTS
     * switching: a detected language with no declared entry is left alone.
     */
    declaredLanguages?: string[];
    /** ttsLanguage the TwiML opened on, so an already-active code isn't re-sent. */
    initialTtsLanguage?: string;
}

export class ConversationRelaySession {
    private readonly responseService: ResponseService;
    private readonly sessionData: SessionData;
    private readonly send: (frame: OutgoingFrame) => void;
    private readonly silenceHandler: SilenceHandler | null;
    /** Default reminder wording; its length is the number of reminders before ending. */
    private readonly silenceMessages: string[];
    private readonly logPrefix: string;

    /** Detected primary tag (`fr`) -> declared code (`fr-FR`). First declaration wins. */
    private readonly ttsLanguageByTag: Map<string, string>;
    private activeTtsLanguage: string | null;
    private manualLanguageOverride = false;
    /** A detected change seen once, waiting for a second prompt to confirm it. */
    private pendingTtsLanguage: string | null = null;

    private listenMode: boolean;
    private suppressedCount = 0;
    private accumulatedTokens = '';
    private pendingTerminalFrame: OutgoingFrame | null = null;
    private readonly inFlightToolCalls: Set<Promise<unknown>> = new Set();

    constructor(opts: ConversationRelaySessionOptions) {
        this.responseService = opts.responseService;
        this.sessionData = opts.sessionData;
        this.send = opts.send;
        this.listenMode = opts.initialListenMode;
        this.logPrefix = `Call SID: ${this.sessionData.setupData.callSid ?? 'unknown'}]`;

        this.ttsLanguageByTag = new Map();
        for (const code of opts.declaredLanguages ?? []) {
            const tag = code.split('-')[0].toLowerCase();
            if (!this.ttsLanguageByTag.has(tag)) this.ttsLanguageByTag.set(tag, code);
        }
        this.activeTtsLanguage = opts.initialTtsLanguage ?? null;

        // Silence policy is the transport's, whatever the back end: remind once
        // per configured message, then end the call. Only the words may come
        // from the ResponseService.
        this.silenceMessages = opts.silenceConfig.messages ?? [];
        this.silenceHandler = opts.silenceConfig.enabled
            ? new SilenceHandler({
                  enabled: true,
                  secondsThreshold: opts.silenceConfig.secondsThreshold,
                  onBreach: count => {
                      this.onSilence(count).catch(err =>
                          logError('Session', `${this.logPrefix} silence handling failed: ${err.message}`)
                      );
                  },
              })
            : null;

        // BUG-2: starting in listen mode must mirror the runtime
        // `setListenMode()` path and disarm silence detection. Otherwise the
        // reminders are swallowed (they are `text` frames, which listen mode
        // gates) while the terminal `end` frame is NOT gated — so the call is
        // hung up with `reasonCode: 'unresponsive'` and no audible warning.
        if (this.listenMode) {
            this.silenceHandler?.setEnabled(false);
        }

        this.responseService.createResponseHandler(this.buildResponseHandler());

        logOut(
            'Session',
            `${this.logPrefix} constructed (listenMode=${this.listenMode}, silence=${
                this.silenceHandler?.isEnabled() ?? false
            })`
        );
    }

    // =========================================================================
    // Public accessors
    // =========================================================================

    isListenMode(): boolean {
        return this.listenMode;
    }

    getSuppressedCount(): number {
        return this.suppressedCount;
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Called from the server WS handler on first `setup` frame. Reports the
     * setup to the service, which owns what (if anything) the model is told.
     */
    async setup(): Promise<void> {
        const { parameterData, setupData } = this.sessionData;
        await this.responseService.handleEvent({
            type: 'setup',
            setup: setupData,
            parameters: parameterData,
        });

        this.silenceHandler?.start();
        logOut('Session', `${this.logPrefix} Setup complete`);
    }

    /** Evaluated Twilio status callback for this call, reported to the service. */
    async handleStatus(status: unknown): Promise<void> {
        await this.responseService.handleEvent({ type: 'status', status });
    }

    /** Called from the server WS handler for every validated incoming frame (post-setup). */
    async handleIncoming(message: IncomingMessage): Promise<void> {
        try {
            // Signal-of-life events reset the silence timer. `info` is noise
            // (status updates from Twilio) and doesn't count.
            if (message.type !== 'info') {
                this.silenceHandler?.reset();
            }

            switch (message.type) {
                case 'setup':
                    // First setup already handled by server.ts before construction.
                    // A second setup on the same ws shouldn't happen; log and ignore.
                    logOut('Session', `${this.logPrefix} Duplicate setup ignored`);
                    break;
                case 'prompt':
                    logOut('Session', `${this.logPrefix} PROMPT: ${message.voicePrompt}`);
                    this.autoSwitchTtsLanguage(message.lang);
                    await this.responseService.handleEvent({
                        type: 'prompt',
                        text: message.voicePrompt || '',
                        lang: message.lang,
                    });
                    break;
                case 'dtmf':
                    logOut('Session', `${this.logPrefix} DTMF: ${message.digit}`);
                    await this.responseService.handleEvent({ type: 'dtmf', digit: message.digit });
                    break;
                case 'interrupt':
                    logOut(
                        'Session',
                        `${this.logPrefix} INTERRUPT: ${message.utteranceUntilInterrupt}`
                    );
                    // logOut(
                    //     'Session',
                    //     `${this.logPrefix} INTERRUPT: ${JSON.stringify(message, null, 2)}`
                    // );
                    await this.responseService.handleEvent({
                        type: 'interrupt',
                        heard: message.utteranceUntilInterrupt,
                    });
                    break;
                case 'info':
                    // Intentionally quiet — info frames are frequent.
                    break;
                case 'error':
                    logError('Session', `${this.logPrefix} ERROR: ${message.description}`);
                    break;
                default:
                    logError(
                        'Session',
                        `${this.logPrefix} Unknown incoming type: ${(message as { type?: unknown }).type}`
                    );
            }
        } catch (error) {
            logError(
                'Session',
                `${this.logPrefix} handleIncoming failed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    cleanup(): void {
        this.silenceHandler?.stop();
        this.responseService.cleanup();
        logOut('Session', `${this.logPrefix} Cleaned up`);
    }

    // =========================================================================
    // Outgoing — the single path back to Twilio
    // =========================================================================

    /**
     * Ship a validated OutgoingFrame. Listen-mode suppresses text/play/
     * language; sendDigits and end always go through. Parse failures throw
     * (outgoing validation errors are programmer errors, not wire events).
     */
    private sendResponse(frame: OutgoingFrame): void {
        const validated = OutgoingFrameSchema.safeParse(frame);
        if (!validated.success) {
            logError(
                'Session',
                `${this.logPrefix} Outgoing frame validation failed: ${JSON.stringify(
                    validated.error.issues
                )} — frame: ${JSON.stringify(frame)}`
            );
            throw new Error(
                `Invalid outgoing frame (type=${(frame as { type?: unknown }).type}): ${validated.error.message}`
            );
        }

        if (this.listenMode && LISTEN_MODE_GATED.has(validated.data.type)) {
            this.suppressedCount += 1;
            logOut(
                'Session',
                `${this.logPrefix} Suppressed ${validated.data.type} frame (listen mode, total=${this.suppressedCount})`
            );
            return;
        }

        this.send(validated.data);
    }

    /**
     * Send a text token. When `last` is true, await any in-flight tool calls
     * first so tool-dispatched terminal frames have a chance to land in
     * `pendingTerminalFrame`. After the text frame, flush any stashed
     * terminal frame.
     */
    async sendText(token: string, last: boolean): Promise<void> {
        if (last && this.inFlightToolCalls.size > 0) {
            await Promise.allSettled([...this.inFlightToolCalls]);
        }

        this.sendResponse({ type: 'text', token, last });

        if (last && this.pendingTerminalFrame) {
            const terminal = this.pendingTerminalFrame;
            this.pendingTerminalFrame = null;
            logOut(
                'Session',
                `${this.logPrefix} Flushing deferred terminal frame: ${JSON.stringify(terminal)}`
            );
            this.sendResponse(terminal);
        }
    }

    sendDigits(digits: string): void {
        this.sendResponse({ type: 'sendDigits', digits });
    }

    sendPlay(
        source: string,
        opts: { loop?: number; interruptible?: boolean; preemptible?: boolean } = {}
    ): void {
        const frame: OutgoingFrame = { type: 'play', source };
        if (opts.loop !== undefined) (frame as { loop?: number }).loop = opts.loop;
        if (opts.interruptible !== undefined)
            (frame as { interruptible?: boolean }).interruptible = opts.interruptible;
        if (opts.preemptible !== undefined)
            (frame as { preemptible?: boolean }).preemptible = opts.preemptible;
        this.sendResponse(frame);
    }

    /**
     * ConversationRelay reports the detected language on every prompt when
     * transcriptionLanguage is `multi`, but never acts on it — detection is a
     * read, not a write. This closes that loop: map the detected primary tag
     * (`fr`) onto a declared <Language> code (`fr-FR`) and switch TTS so the
     * reply is spoken with that language's configured voice.
     *
     * transcriptionLanguage is deliberately left on `multi`. Pinning STT to the
     * detected language would end detection for the rest of the call, so a
     * caller who switched back would be transcribed by the wrong model with
     * nothing to signal it.
     *
     * Detection misfires on short utterances ("Okay." reported as `es`), so a
     * change away from an active declared voice needs two consecutive prompts
     * in the new language. The first detection of the call (opening on `multi`
     * or an undeclared code) switches immediately — there is no voice to keep.
     */
    private autoSwitchTtsLanguage(detected?: string): void {
        if (this.manualLanguageOverride || !detected) return;
        const code = this.ttsLanguageByTag.get(detected.split('-')[0].toLowerCase());
        if (!code) return;
        if (code === this.activeTtsLanguage) {
            this.pendingTtsLanguage = null;
            return;
        }

        const onDeclaredVoice = [...this.ttsLanguageByTag.values()].includes(
            this.activeTtsLanguage ?? ''
        );
        if (onDeclaredVoice && this.pendingTtsLanguage !== code) {
            this.pendingTtsLanguage = code;
            logOut(
                'Session',
                `${this.logPrefix} Detected '${detected}' once — keeping ${this.activeTtsLanguage} until it repeats`
            );
            return;
        }

        this.pendingTtsLanguage = null;
        logOut(
            'Session',
            `${this.logPrefix} Detected '${detected}' — switching ttsLanguage to ${code}`
        );
        this.activeTtsLanguage = code;
        this.sendResponse({ type: 'language', ttsLanguage: code });
    }

    /**
     * Breach `count` of continuous silence. Breaches 1..n speak reminder n;
     * breach n+1 ends the call. The ResponseService may reword a reminder but
     * cannot skip it or change when the call ends.
     */
    private async onSilence(count: number): Promise<void> {
        const fallback = this.silenceMessages[count - 1];
        if (fallback === undefined) {
            if (count !== this.silenceMessages.length + 1) return;
            logOut('Session', `${this.logPrefix} Silence terminal — ending call`);
            this.endCall({ reasonCode: 'unresponsive', reason: 'The caller was not speaking' });
            return;
        }

        let reminder = fallback;
        let timer: NodeJS.Timeout | undefined;
        try {
            const timeout = new Promise<null>(resolve => {
                timer = setTimeout(() => resolve(null), SILENCE_WORDING_TIMEOUT_MS);
            });
            const worded = this.responseService.silenceReminder?.(count) ?? null;
            reminder = (await Promise.race([worded, timeout])) || fallback;
        } catch (error) {
            logError(
                'Session',
                `${this.logPrefix} silenceReminder failed, using configured wording: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        } finally {
            clearTimeout(timer);
        }
        logOut('Session', `${this.logPrefix} Silence reminder ${count}: "${reminder}"`);
        await this.sendText(reminder, true);
    }

    switchLanguage(opts: { ttsLanguage?: string; transcriptionLanguage?: string }): void {
        // An explicit switch (the switch-language tool — i.e. the caller asked)
        // wins for the rest of the call. Without this latch, automatic
        // detection would flip TTS straight back on the next prompt.
        this.manualLanguageOverride = true;
        if (opts.ttsLanguage) this.activeTtsLanguage = opts.ttsLanguage;
        const frame: OutgoingFrame = { type: 'language' };
        if (opts.ttsLanguage) (frame as { ttsLanguage?: string }).ttsLanguage = opts.ttsLanguage;
        if (opts.transcriptionLanguage)
            (frame as { transcriptionLanguage?: string }).transcriptionLanguage =
                opts.transcriptionLanguage;
        this.sendResponse(frame);
    }

    /**
     * End the call immediately. Bypasses listen-mode gating (always sent)
     * and the terminal-deferral path (callers invoking this directly are
     * asking for immediate hangup).
     */
    endCall(handoffData?: Record<string, unknown> | string): void {
        const frame: OutgoingFrame = { type: 'end' };
        if (handoffData !== undefined) {
            const stringified =
                typeof handoffData === 'string' ? handoffData : JSON.stringify(handoffData);
            (frame as { handoffData?: string }).handoffData = stringified;
        }
        this.sendResponse(frame);
    }

    // =========================================================================
    // State controls
    // =========================================================================

    setListenMode(enabled: boolean): void {
        this.listenMode = enabled;
        if (this.silenceHandler) {
            if (enabled) {
                this.silenceHandler.setEnabled(false);
            } else {
                this.silenceHandler.setEnabled(true);
                this.silenceHandler.reset();
            }
        }
        logOut(
            'Session',
            `${this.logPrefix} Listen-mode ${enabled ? 'enabled' : 'disabled'}`
        );
    }

    setSilenceDetection(enabled: boolean): void {
        if (!this.silenceHandler) {
            logOut(
                'Session',
                `${this.logPrefix} setSilenceDetection no-op (silence disabled at session construction)`
            );
            return;
        }
        this.silenceHandler.setEnabled(enabled);
        if (enabled) {
            this.silenceHandler.reset();
        }
    }

    /** Operator request to switch this call's prompt; the service resolves `key`. */
    async switchContext(key: string): Promise<void> {
        await this.responseService.handleEvent({ type: 'context', key });
    }

    // =========================================================================
    // Internal — response handler wiring
    // =========================================================================

    /**
     * Bridge from `ResponseService` (streaming tokens, tool results) to the
     * session's outgoing methods. Routes tool-result side-effect fields
     * (`silenceEnabled`, `listenMode`, `outgoingMessage`) to the right
     * session method.
     */
    private buildResponseHandler(): ResponseHandler {
        return {
            content: (response: ContentResponse) => {
                // Accumulate token stream for logging; ship each token as a
                // text frame via the session's outgoing path.
                if (!response.last) {
                    this.accumulatedTokens += response.token || '';
                    logOut(
                        'Session',
                        `${this.logPrefix} Streaming response: "${response.token}"`
                    );
                } else {
                    // logOut(
                    //     'Session',
                    //     `${this.logPrefix} Complete response: "${this.accumulatedTokens}"`
                    // );
                    this.accumulatedTokens = '';
                }
                this.sendText(response.token, response.last).catch(err =>
                    logError('Session', `sendText failed: ${err.message}`)
                );
            },

            toolResult: (event: ToolResultEvent) => {
                const { toolType, toolData } = event;
                logOut('Session', `${this.logPrefix} Tool result: ${toolType}`);

                if (!toolData) return;

                // Priority 1: silence-detection toggle.
                if (typeof toolData.silenceEnabled === 'boolean') {
                    this.setSilenceDetection(toolData.silenceEnabled);
                    return;
                }

                // Priority 2: listen-mode toggle.
                if (typeof toolData.listenMode === 'boolean') {
                    this.setListenMode(toolData.listenMode);
                    return;
                }

                // Priority 3: outgoing frame from the tool.
                const outgoing = toolData.outgoingMessage;
                if (!outgoing) return;

                const parsed = OutgoingFrameSchema.safeParse(outgoing);
                if (!parsed.success) {
                    logError(
                        'Session',
                        `${this.logPrefix} Tool '${toolType}' produced invalid outgoingMessage: ${JSON.stringify(parsed.error.issues)}`
                    );
                    return;
                }

                const frame = parsed.data;
                if (frame.type === 'end') {
                    // Defer terminal frames until after the final text token,
                    // so the LLM's farewell isn't cut off mid-sentence.
                    this.pendingTerminalFrame = frame;
                    logOut(
                        'Session',
                        `${this.logPrefix} Deferring terminal frame from '${toolType}' until farewell flush`
                    );
                    return;
                }

                // Non-terminal frames ship immediately.
                this.sendResponse(frame);
            },

            error: (error: Error) => {
                logError('Session', `${this.logPrefix} ResponseService error: ${error.message}`);
            },

            callSid: (callSid: string, responseMessage: unknown) => {
                logOut(
                    'Session',
                    `${this.logPrefix} callSid event: ${callSid}, ${JSON.stringify(responseMessage)}`
                );
            },

            toolCallStart: (promise: Promise<unknown>) => {
                this.trackToolCall(promise);
            },
        };
    }

    // =========================================================================
    // Tool-dispatch tracking hooks — called by OpenAIResponseService
    // =========================================================================

    /**
     * Called by the ResponseService when a tool call starts. The session
     * tracks in-flight promises so `sendText(last=true)` can await them
     * before emitting the terminal text. See `inFlightToolCalls` above.
     */
    trackToolCall(promise: Promise<unknown>): void {
        this.inFlightToolCalls.add(promise);
        promise
            .finally(() => {
                this.inFlightToolCalls.delete(promise);
            })
            .catch(() => {
                /* swallowed — original caller sees rejection elsewhere */
            });
    }
}
