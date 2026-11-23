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
import { matchFiller, type MissReason } from '../latency/matchFiller.js';
import { classifyCoherence } from '../latency/coherence.js';
import { getMode, getLlmDelayMs, getQuestionWaitMs, isHandlerEnabled } from '../latency/mode.js';
import { nextFallback } from '../latency/fallbackFillers.js';
import { opener } from '../latency/fillers.js';
import { SilenceHandler } from './SilenceHandler.js';
import type { SilenceDetectionConfig } from './SilenceHandler.js';
import type { ResponseService, ResponseHandler, ContentResponse, ToolResultEvent, CallAction, ActionOutcome } from '../interfaces/ResponseService.js';
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
/** How many recent filler opening words are kept off-limits for the next filler. */
const RECENT_OPENERS = 3;

const LISTEN_MODE_GATED: ReadonlySet<OutgoingFrame['type']> = new Set(['text', 'play', 'language']);

/**
 * `<Parameter>` names the TwiML author uses to tell the session which
 * `<Language>` codes and opening `ttsLanguage` the call was set up with. The
 * setup frame carries neither, so without these the session could only guess
 * from its own config — which drifts when someone else writes the TwiML.
 */
export const CALL_LANGUAGES_PARAM = 'crLanguages';
export const CALL_TTS_LANGUAGE_PARAM = 'crTtsLanguage';

/**
 * The call's declared languages and opening TTS language: from the TwiML's
 * `<Parameter>`s when present, otherwise the transport's own config.
 */
export function resolveCallLanguages(
    customParameters: Record<string, string> | undefined,
    fallback: { languages: string[]; ttsLanguage?: string }
): { languages: string[]; ttsLanguage?: string; source: 'call' | 'config' } {
    const declared = customParameters?.[CALL_LANGUAGES_PARAM]
        ?.split(',')
        .map(code => code.trim())
        .filter(Boolean);
    if (declared?.length) {
        return {
            languages: declared,
            ttsLanguage: customParameters?.[CALL_TTS_LANGUAGE_PARAM] || fallback.ttsLanguage,
            source: 'call',
        };
    }
    return { ...fallback, source: 'config' };
}

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
     * switching (a detected language with no declared entry is left alone)
     * and for `language` actions (Twilio rejects an undeclared code).
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
    private readonly declaredLanguages: ReadonlySet<string>;
    private activeTtsLanguage: string | null;
    private manualLanguageOverride = false;

    private listenMode: boolean;
    private suppressedCount = 0;
    private accumulatedTokens = '';
    private pendingTerminalFrame: OutgoingFrame | null = null;
    private readonly inFlightToolCalls: Set<Promise<unknown>> = new Set();
    /** Filler bookkeeping: a filler may only be sent for the current turn, before the LLM speaks. */
    private turnSeq = 0;
    private llmStarted = false;
    private promptAt = 0;
    private firstTokenLogged = false;
    private lastFallback: string | undefined;
    /** Hold media (plan MEDIA-PLAYBACK.md, Option A): one play per turn, queued behind the acknowledgement. */
    private holdActive = false;
    private holdSentAt = 0;
    private holdTurn = 0;
    /** Opening words of the last few fillers spoken, so "Okay" doesn't keep coming back. */
    private recentOpeners: string[] = [];
    /** Coherence: prompt fragments held back until the caller looks done (or question_wait expires). */
    private promptBuffer: string[] = [];
    private waitTimer: NodeJS.Timeout | undefined;
    private bufferLang: string | undefined;
    /** Bumped per buffered prompt so a slow classification of an older fragment is ignored. */
    private coherenceSeq = 0;
    /**
     * Pending answer: from a flush until the LLM's first content token. While no LLM text has been sent
     * and no tool has started, a new caller prompt is merged into it. Our own filler and hold don't count.
     */
    private pending: { seq: number; text: string; pieces: number; sent: boolean; toolStarted: boolean; merged: boolean } | null = null;
    private flushSeq = 0;
    /** Flush whose test LLM delay was overtaken by a merge: it must not send. */
    private cancelledFlushSeq = 0;

    constructor(opts: ConversationRelaySessionOptions) {
        this.responseService = opts.responseService;
        this.sessionData = opts.sessionData;
        this.send = opts.send;
        this.listenMode = opts.initialListenMode;
        this.logPrefix = `Call SID: ${this.sessionData.setupData.callSid ?? 'unknown'}]`;

        this.declaredLanguages = new Set(opts.declaredLanguages ?? []);
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
                    {
                        const turn = ++this.turnSeq;
                        this.llmStarted = false;
                        this.firstTokenLogged = false;
                        this.holdActive = false;
                        this.promptAt = performance.now();
                        void this.sendFiller(message.voicePrompt || '', turn);
                    }
                    // Both run synchronously up to the buffer push, so pieces arriving together keep their order.
                    this.mergePending();
                    await this.routePrompt(message.voicePrompt || '', message.lang);
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
                    this.turnSeq++;
                    this.holdActive = false;
                    // Caller spoke over the acknowledgement/hold: they are mid-sentence, so keep waiting.
                    if (this.waitTimer) this.startWaitTimer();
                    // Before the answer started, the caller talking over our acknowledgement/hold is not
                    // a request to stop the answer: forwarding would silently kill the in-flight stream.
                    if (this.pendingWindowOpen()) {
                        logOut('Session', `${this.logPrefix} interrupt before answer: treated as caller still talking`);
                        break;
                    }
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
        this.holdActive = false;
        clearTimeout(this.waitTimer);
        this.waitTimer = undefined;
        this.promptBuffer = [];
        this.coherenceSeq++;
        this.silenceHandler?.stop();
        this.responseService.cleanup();
        logOut('Session', `${this.logPrefix} Cleaned up`);
    }

    // =========================================================================
    // Outgoing — the single path back to Twilio
    // =========================================================================

    /** True while an answer is pending (flushed, no LLM text, no tool) and the Handler is on. */
    private pendingWindowOpen(): boolean {
        return isHandlerEnabled() && !!this.pending && !this.pending.toolStarted && !this.llmStarted;
    }

    /**
     * A new caller prompt inside the pending window: take back the unanswered text so it is sent
     * again together with the new piece. Still in the test LLM delay: cancel that send. Already
     * with the LLM: retract its user message and stop its stream.
     */
    private mergePending(): void {
        const p = this.pending;
        if (!p || p.merged || !this.pendingWindowOpen()) return;
        p.merged = true;
        this.promptBuffer.unshift(p.text);
        // Not awaited: awaiting here let a piece arriving at the same moment reach the buffer first
        // (call CAdb229c). The retract is done long before the merged prompt is sent (after classify).
        if (p.sent) {
            this.responseService.handleEvent({ type: 'retract' }).catch((e) =>
                logError('Latency', `${this.logPrefix} retract failed: ${e instanceof Error ? e.message : String(e)}`));
        } else this.cancelledFlushSeq = p.seq;
        logOut('Latency', `${this.logPrefix} coherence merge state=${p.sent ? 'in-flight' : 'delay'} pieces=${p.pieces + 1}`);
    }

    /**
     * Coherence (part of the Handler): decide when a caller prompt goes to the LLM. With the Handler
     * off, question_wait 0 or mode none it goes at once. Otherwise it is buffered and classified: question/changed-mind flush now,
     * statement/filler wait up to question_wait for more words, a classifier failure flushes now.
     */
    private async routePrompt(text: string, lang: string | undefined): Promise<void> {
        const mode = getMode();
        const wait = getQuestionWaitMs();
        if (wait === 0 || mode === 'none' || !isHandlerEnabled()) {
            this.promptBuffer.push(text);
            this.bufferLang = lang;
            await this.flushPrompt('off');
            return;
        }
        clearTimeout(this.waitTimer);
        this.waitTimer = undefined;
        const context = [...this.promptBuffer];
        this.promptBuffer.push(text);
        this.bufferLang = lang;
        const seq = ++this.coherenceSeq;
        try {
            const r = await classifyCoherence(mode, text, context);
            if (seq !== this.coherenceSeq) return; // a newer fragment arrived; it decides
            const send = r.cls === 'question' || r.cls === 'changed-mind';
            logOut('Latency', `${this.logPrefix} coherence class=${r.cls} source=${r.source} ms=${Math.round(r.ms)} action=${send ? 'send' : 'wait'} buffer="${this.promptBuffer.join(' ')}"`);
            if (send) await this.flushPrompt('class');
            else this.startWaitTimer();
        } catch (e) {
            if (seq !== this.coherenceSeq) return;
            logError('Latency', `${this.logPrefix} coherence classify (${mode}) failed: ${e instanceof Error ? e.message : String(e)}`);
            await this.flushPrompt('error');
        }
    }

    /** (Re)start the wait for more words; flushes when question_wait expires. */
    private startWaitTimer(): void {
        clearTimeout(this.waitTimer);
        this.waitTimer = setTimeout(() => {
            this.waitTimer = undefined;
            this.flushPrompt('timeout').catch((e) =>
                logError('Latency', `${this.logPrefix} coherence flush failed: ${e instanceof Error ? e.message : String(e)}`));
        }, getQuestionWaitMs());
    }

    /** Send everything buffered to the LLM as one prompt. The test LLM delay counts from here. */
    private async flushPrompt(reason: 'class' | 'timeout' | 'error' | 'off'): Promise<void> {
        clearTimeout(this.waitTimer);
        this.waitTimer = undefined;
        const pieces = this.promptBuffer.length;
        const text = this.promptBuffer.join(' ');
        this.promptBuffer = [];
        if (!pieces) return;
        logOut('Latency', `${this.logPrefix} coherence flush reason=${reason} pieces=${pieces}`);
        const seq = ++this.flushSeq;
        const pending = { seq, text, pieces, sent: false, toolStarted: false, merged: false };
        this.pending = pending;
        // Test-only: hold back the LLM so the hold sound gets a chance to play. 0 = off.
        if (getLlmDelayMs() > 0) {
            await new Promise((r) => setTimeout(r, getLlmDelayMs()));
        }
        if (this.cancelledFlushSeq === seq) {
            logOut('Latency', `${this.logPrefix} coherence flush skipped (merged into a newer prompt)`);
            return;
        }
        pending.sent = true;
        await this.responseService.handleEvent({ type: 'prompt', text, lang: this.bufferLang });
    }

    /**
     * Acknowledge every caller prompt (modes jev/embedding), in parallel with the LLM: the matched
     * filler if it is good and arrives within LATENCY_FILLER_BUDGET_MS, otherwise a neutral fallback.
     * At the budget the fallback goes out without waiting for the matcher; a late match is dropped.
     * Exactly one acknowledgement per turn. Dropped if the turn moved on, the LLM already spoke,
     * or listen mode is on.
     */
    private async sendFiller(text: string, turn: number): Promise<void> {
        const mode = getMode();
        if (mode === 'none') return;
        const t0 = performance.now();
        const budget = Number(process.env.LATENCY_FILLER_BUDGET_MS) || 350;
        let miss: MissReason = 'no-match';
        const matching = matchFiller(text, undefined, (r) => { miss = r; }, { avoidOpeners: new Set(this.recentOpeners) });
        let timer: NodeJS.Timeout | undefined;
        const timedOut = Symbol('timeout');
        const first = await Promise.race([
            matching,
            new Promise<typeof timedOut>((r) => { timer = setTimeout(() => r(timedOut), budget); }),
        ]);
        clearTimeout(timer);

        const emit = async (source: 'match' | 'fallback', id: string, say: string, score: string, reason?: string) => {
            const drop =
                turn !== this.turnSeq ? 'stale'
                : this.llmStarted ? 'late (LLM already speaking)'
                : this.listenMode ? 'listen mode'
                : null;
            logOut(
                'Latency',
                `${this.logPrefix} filler mode=${mode} source=${source} id=${id}${reason ? ` reason=${reason}` : ''} score=${score} ms=${Math.round(performance.now() - t0)} ${drop ? `dropped: ${drop}` : 'sent'}`
            );
            if (!drop) {
                this.recentOpeners = [...this.recentOpeners, opener(say)].slice(-RECENT_OPENERS);
                await this.sendText(`${say} `, false);
                this.maybeStartHold(turn);
            }
        };
        const fallback = (reason: string, score: string) => {
            this.lastFallback = nextFallback(this.lastFallback, new Set(this.recentOpeners));
            return emit('fallback', 'fallback', this.lastFallback, score, reason);
        };

        if (first === timedOut) {
            await fallback('timeout', '-');
            const late = await matching;
            logOut('Latency', `${this.logPrefix} filler match late, fallback sent (${late ? `id=${late.filler.id} score=${late.score.toFixed(2)} ` : 'no match '}after ${Math.round(performance.now() - t0)}ms)`);
        } else if (first) {
            await emit('match', first.filler.id, first.filler.say, first.score.toFixed(2));
        } else {
            await fallback(miss, '-');
        }
    }

    /**
     * Right after the acknowledgement went out: queue one preemptible hold sound behind it, so the
     * caller isn't left in silence until the LLM speaks. The LLM's first text frame preempts it.
     * LATENCY_HOLD_URL: unset -> https://<SERVER_BASE_URL>/media/hold.wav; empty -> disabled.
     * At most one play per turn.
     */
    private maybeStartHold(turn: number): void {
        const url = process.env.LATENCY_HOLD_URL ?? (process.env.SERVER_BASE_URL ? `https://${process.env.SERVER_BASE_URL}/media/hold.wav` : '');
        const skip =
            turn !== this.turnSeq ? 'stale'
            : this.llmStarted ? 'llm-started'
            : this.listenMode ? 'listen-mode'
            : !isHandlerEnabled() ? 'handler-off'
            : !url ? 'disabled'
            : this.holdTurn === turn ? 'already-sent'
            : null;
        if (skip === 'already-sent') return;
        if (skip) {
            logOut('Latency', `${this.logPrefix} hold skipped reason=${skip}`);
            return;
        }
        const loop = Number(process.env.LATENCY_HOLD_LOOP) || 1;
        this.holdTurn = turn;
        this.sendPlay(url, { loop, preemptible: true, interruptible: true });
        this.holdActive = true;
        this.holdSentAt = performance.now();
        logOut('Latency', `${this.logPrefix} hold sent url=${url} loop=${loop}`);
    }

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
     */
    private autoSwitchTtsLanguage(detected?: string): void {
        if (this.manualLanguageOverride || !detected) return;
        const code = this.ttsLanguageByTag.get(detected.split('-')[0].toLowerCase());
        if (!code || code === this.activeTtsLanguage) return;
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
     * session's outgoing methods. Applies a tool result's `action` to the call.
     */
    private buildResponseHandler(): ResponseHandler {
        return {
            content: (response: ContentResponse) => {
                if (response.token && !this.llmStarted) {
                    this.llmStarted = true;
                    this.pending = null;
                    if (!this.firstTokenLogged) {
                        this.firstTokenLogged = true;
                        logOut('Latency', `${this.logPrefix} first LLM token ${Math.round(performance.now() - this.promptAt)}ms after prompt`);
                    }
                }
                if (response.last) this.pending = null;
                if (this.holdActive && response.token?.trim()) {
                    this.holdActive = false;
                    logOut('Latency', `${this.logPrefix} hold preempted ${Math.round(performance.now() - this.holdSentAt)}ms after hold sent`);
                }
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

            toolResult: (event: ToolResultEvent): ActionOutcome | void => {
                const { toolType, toolData } = event;
                logOut('Session', `${this.logPrefix} Tool result: ${toolType}`);

                if (toolData?.action) {
                    return this.applyAction(toolData.action, toolType);
                }
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
                if (this.pending) this.pending.toolStarted = true;
                this.trackToolCall(promise);
            },
        };
    }

    /**
     * What a call action means on the wire. The only place tools' effects
     * become frames, and the only place that knows which action ends the call.
     */
    private applyAction(action: CallAction, toolType: string): ActionOutcome {
        switch (action.type) {
            case 'listenMode':
                this.setListenMode(action.enabled);
                return { applied: true, terminal: false };
            case 'silence':
                this.setSilenceDetection(action.enabled);
                return { applied: true, terminal: false };
            case 'language': {
                // Twilio rejects a code the TwiML didn't declare, so resolve
                // each one against the declared list (same lookup as the
                // auto-switch: `en-US` -> the declared `en-AU`).
                const tts = this.resolveDeclaredLanguage(action.ttsLanguage, toolType);
                const stt = this.resolveDeclaredLanguage(action.transcriptionLanguage, toolType);
                if (tts === null || stt === null) {
                    return {
                        applied: false,
                        terminal: false,
                        detail: `This call only supports: ${[...this.declaredLanguages].join(', ')}`,
                    };
                }
                const frame: CallAction = { type: 'language' };
                if (tts) frame.ttsLanguage = tts;
                if (stt) frame.transcriptionLanguage = stt;
                if (!this.applyToolFrame(frame, toolType)) return { applied: false, terminal: false };
                // An explicit switch (the caller asked) wins for the rest of
                // the call; without this, automatic detection would flip TTS
                // straight back on the next prompt.
                this.manualLanguageOverride = true;
                if (tts) this.activeTtsLanguage = tts;
                const substituted = [
                    tts !== action.ttsLanguage ? `${action.ttsLanguage} -> ${tts}` : null,
                    stt !== action.transcriptionLanguage ? `${action.transcriptionLanguage} -> ${stt}` : null,
                ].filter(Boolean);
                return substituted.length > 0
                    ? { applied: true, terminal: false, detail: `Used the call's language: ${substituted.join(', ')}` }
                    : { applied: true, terminal: false };
            }
            case 'endCall':
            case 'sendDigits':
            case 'play': {
                const { type, ...fields } = action;
                const frameType = type === 'endCall' ? 'end' : type;
                const applied = this.applyToolFrame({ type: frameType, ...fields }, toolType);
                return { applied, terminal: applied && type === 'endCall' };
            }
            default:
                logError(
                    'Session',
                    `${this.logPrefix} Tool '${toolType}' requested unknown action: ${JSON.stringify(action)}`
                );
                return { applied: false, terminal: false, detail: 'Unknown action' };
        }
    }

    /**
     * A declared code for `code`: itself if declared, else the declared code
     * with the same primary tag. `undefined` passes through; null means no
     * declared match, so the action is dropped. With no declared list, every
     * code passes.
     */
    private resolveDeclaredLanguage(code: string | undefined, toolType: string): string | undefined | null {
        if (code === undefined || code === 'multi' || this.declaredLanguages.size === 0) return code;
        if (this.declaredLanguages.has(code)) return code;
        const match = this.ttsLanguageByTag.get(code.split('-')[0].toLowerCase());
        if (match) {
            logOut('Session', `${this.logPrefix} Tool '${toolType}' asked for ${code} — using declared ${match}`);
            return match;
        }
        logError(
            'Session',
            `${this.logPrefix} Tool '${toolType}' asked for undeclared language ${code} — declared: ${[...this.declaredLanguages].join(', ')}`
        );
        return null;
    }

    /** Validates and ships (or defers) a tool's frame; false when invalid. */
    private applyToolFrame(outgoing: unknown, toolType: string): boolean {
        const parsed = OutgoingFrameSchema.safeParse(outgoing);
        if (!parsed.success) {
            logError(
                'Session',
                `${this.logPrefix} Tool '${toolType}' produced invalid frame: ${JSON.stringify(parsed.error.issues)}`
            );
            return false;
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
            return true;
        }

        // Non-terminal frames ship immediately.
        this.sendResponse(frame);
        return true;
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
