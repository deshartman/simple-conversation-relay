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
import type { OpenAIResponseService } from './OpenAIResponseService.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
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
const LISTEN_MODE_GATED: ReadonlySet<OutgoingFrame['type']> = new Set(['text', 'play', 'language']);

export interface ConversationRelaySessionOptions {
    responseService: ResponseService;
    sessionData: SessionData;
    silenceConfig: SilenceDetectionConfig;
    initialListenMode: boolean;
    registry: ToolRegistry;
    /** Inject the ws.send wrapper. The session never touches `ws` directly. */
    send: (frame: OutgoingFrame) => void;
}

export class ConversationRelaySession {
    private readonly responseService: ResponseService;
    private readonly sessionData: SessionData;
    private readonly registry: ToolRegistry;
    private readonly send: (frame: OutgoingFrame) => void;
    private readonly silenceHandler: SilenceHandler | null;
    private readonly logPrefix: string;

    private listenMode: boolean;
    private suppressedCount = 0;
    private accumulatedTokens = '';
    private pendingTerminalFrame: OutgoingFrame | null = null;
    private readonly inFlightToolCalls: Set<Promise<unknown>> = new Set();

    constructor(opts: ConversationRelaySessionOptions) {
        this.responseService = opts.responseService;
        this.sessionData = opts.sessionData;
        this.registry = opts.registry;
        this.send = opts.send;
        this.listenMode = opts.initialListenMode;
        this.logPrefix = `Call SID: ${this.sessionData.setupData.callSid ?? 'unknown'}]`;

        this.silenceHandler = opts.silenceConfig.enabled
            ? new SilenceHandler({
                  enabled: true,
                  secondsThreshold: opts.silenceConfig.secondsThreshold,
                  messages: opts.silenceConfig.messages,
                  onReminder: reminder => {
                      logOut('Session', `${this.logPrefix} Silence reminder: "${reminder}"`);
                      this.sendText(reminder, true).catch(err =>
                          logError('Session', `Reminder sendText failed: ${err.message}`)
                      );
                  },
                  onTerminate: () => {
                      logOut('Session', `${this.logPrefix} Silence terminal — ending call`);
                      this.endCall({
                          reasonCode: 'unresponsive',
                          reason: 'The caller was not speaking',
                      });
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
        // Hand ourselves to the response service so tool handlers can
        // receive the session reference. Not all ResponseService
        // implementations have `setSession`, so guard the call.
        const maybeWithSession = this.responseService as unknown as Partial<OpenAIResponseService>;
        if (typeof maybeWithSession.setSession === 'function') {
            maybeWithSession.setSession(this);
        }

        logOut(
            'Session',
            `${this.logPrefix} constructed (listenMode=${this.listenMode}, silence=${opts.silenceConfig.enabled})`
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

    /** Called from the server WS handler on first `setup` frame. */
    async setup(): Promise<void> {
        const { parameterData, setupData } = this.sessionData;
        const initialMessage = `These are all the details of the call: ${JSON.stringify(
            setupData,
            null,
            4
        )} and the parameter data needed to complete your objective: ${JSON.stringify(
            parameterData,
            null,
            4
        )}. Use this to complete your objective`;
        await this.responseService.insertMessage('system', initialMessage);

        this.silenceHandler?.start();
        logOut('Session', `${this.logPrefix} Setup complete`);
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
                    await this.responseService.generateResponse('user', message.voicePrompt || '');
                    break;
                case 'dtmf':
                    logOut('Session', `${this.logPrefix} DTMF: ${message.digit}`);
                    break;
                case 'interrupt':
                    logOut(
                        'Session',
                        `${this.logPrefix} INTERRUPT: ${message.utteranceUntilInterrupt}`
                    );
                    this.responseService.interrupt();
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

    switchLanguage(opts: { ttsLanguage?: string; transcriptionLanguage?: string }): void {
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

    // =========================================================================
    // Proxies for HTTP endpoints (/twilioStatusCallback, /updateResponseService)
    // =========================================================================

    async insertMessage(role: 'system' | 'user' | 'assistant', content: string): Promise<void> {
        await this.responseService.insertMessage(role, content);
    }

    async updateContext(context: string): Promise<void> {
        await this.responseService.updateContext(context);
    }

    /**
     * Accept a new `ToolRegistry` for this session. In v4.12 the registry is
     * process-wide and identical for every session (all-tools-all-legs), so
     * this is effectively a no-op unless a caller wants to swap in a subset
     * registry. Kept for forward compatibility.
     */
    async updateTools(registry: ToolRegistry): Promise<void> {
        this.responseService.updateTools(registry);
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
                } else {
                    logOut(
                        'Session',
                        `${this.logPrefix} Complete response: "${this.accumulatedTokens}"`
                    );
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
