/**
 * ConversationRelaySession Tests
 *
 * Regression coverage for the two listen-mode defects found while assessing
 * outbound-call readiness:
 *
 *   BUG-1 — listen mode was duplicated in `OpenAIResponseService`, whose copy
 *           had no setter. Turning listen mode off left that copy stuck
 *           `true`, so every text delta was discarded and the agent went
 *           permanently mute. The session is now the sole owner.
 *
 *   BUG-2 — constructing in listen mode left silence detection armed. Its
 *           reminders are `text` frames (gated by listen mode, so inaudible)
 *           but its terminal `end` frame is NOT gated, so the call was hung
 *           up with no audible warning.
 *
 * Plus behavioural coverage for automatic TTS language switching, asserting
 * the table in `docs/language-detection.md` rather than trusting it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationRelaySession, resolveCallLanguages } from '../../../src/services/ConversationRelaySession.js';

function makeFakeResponseService() {
    return {
        handler: null as any,
        createResponseHandler(h: any) {
            this.handler = h;
        },
        handleEvent: vi.fn(async (_event: any) => {}),
        cleanup: vi.fn(),
    };
}

function makeSession(opts: {
    initialListenMode: boolean;
    silenceEnabled?: boolean;
    declaredLanguages?: string[];
    initialTtsLanguage?: string;
}) {
    const sent: any[] = [];
    const responseService = makeFakeResponseService();

    const session = new ConversationRelaySession({
        responseService: responseService as any,
        sessionData: {
            parameterData: {},
            setupData: { callSid: 'CAtest0000000000000000000000000000' },
        } as any,
        silenceConfig: {
            enabled: opts.silenceEnabled ?? true,
            secondsThreshold: 20,
            messages: ['Still there?', 'Just checking you are still there?'],
        },
        initialListenMode: opts.initialListenMode,
        send: (frame: any) => sent.push(frame),
        declaredLanguages: opts.declaredLanguages,
        initialTtsLanguage: opts.initialTtsLanguage,
    });

    return { session, sent, responseService };
}

const typesOf = (frames: any[]) => frames.map(f => f.type);

describe('ConversationRelaySession', () => {
    let sessions: ConversationRelaySession[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
        sessions = [];
    });

    afterEach(() => {
        sessions.forEach(s => s.cleanup());
        vi.useRealTimers();
    });

    describe('listen mode gating (BUG-1)', () => {
        it('suppresses text frames while listen mode is enabled', async () => {
            const { session, sent } = makeSession({ initialListenMode: true });
            sessions.push(session);

            await session.sendText('this should not be spoken', true);

            expect(typesOf(sent)).not.toContain('text');
            expect(session.isListenMode()).toBe(true);
            expect(session.getSuppressedCount()).toBe(1);
        });

        /**
         * The mute bug. Before the fix the session un-gated correctly, but
         * `OpenAIResponseService` still held `listenMode === true` and dropped
         * every delta upstream — so nothing reached this path at all.
         */
        it('ships text frames again once listen mode is disabled', async () => {
            const { session, sent } = makeSession({ initialListenMode: true });
            sessions.push(session);

            await session.sendText('suppressed', true);
            expect(typesOf(sent)).not.toContain('text');

            session.setListenMode(false);
            await session.sendText('now audible', true);

            expect(session.isListenMode()).toBe(false);
            const text = sent.filter(f => f.type === 'text');
            expect(text).toHaveLength(1);
            expect(text[0].token).toBe('now audible');
        });

        it('suppresses again when listen mode is re-enabled', async () => {
            const { session, sent } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.sendText('audible', true);
            expect(sent.filter(f => f.type === 'text')).toHaveLength(1);

            session.setListenMode(true);
            await session.sendText('suppressed', true);

            expect(sent.filter(f => f.type === 'text')).toHaveLength(1);
            expect(session.getSuppressedCount()).toBe(1);
        });

        it('always ships DTMF and end frames, even in listen mode', () => {
            const { session, sent } = makeSession({ initialListenMode: true });
            sessions.push(session);

            session.sendDigits('1234');
            session.endCall({ reasonCode: 'test' });

            expect(typesOf(sent)).toEqual(['sendDigits', 'end']);
        });
    });

    describe('silence detection vs listen mode (BUG-2)', () => {
        it('disarms silence detection when constructed in listen mode', () => {
            const { session } = makeSession({ initialListenMode: true, silenceEnabled: true });
            sessions.push(session);

            expect((session as any).silenceHandler.isEnabled()).toBe(false);
        });

        it('leaves silence detection armed when constructed in normal mode', () => {
            const { session } = makeSession({ initialListenMode: false, silenceEnabled: true });
            sessions.push(session);

            expect((session as any).silenceHandler.isEnabled()).toBe(true);
        });

        it('never terminates the call while starting in listen mode', async () => {
            const { session, sent } = makeSession({
                initialListenMode: true,
                silenceEnabled: true,
            });
            sessions.push(session);

            await session.setup();
            // Well past 3 x 20s — reminders exhausted plus a terminal breach.
            await vi.advanceTimersByTimeAsync(90_000);

            expect(typesOf(sent)).not.toContain('end');
        });

        it('re-arms silence detection when listen mode is turned off', () => {
            const { session } = makeSession({ initialListenMode: true, silenceEnabled: true });
            sessions.push(session);

            expect((session as any).silenceHandler.isEnabled()).toBe(false);

            session.setListenMode(false);

            expect((session as any).silenceHandler.isEnabled()).toBe(true);
        });
    });

    /**
     * ConversationRelay reports the detected language but never acts on it, so
     * these assertions are the only thing standing between the feature and a
     * silent regression to an English voice reading French.
     *
     * Driven through `handleIncoming` rather than calling the private switcher
     * directly, so the `prompt` wiring is covered too — a switcher that works
     * but is never called is the more likely failure.
     */
    describe('automatic TTS language switching', () => {
        const DECLARED = ['en-AU', 'fr-FR', 'es-ES'];

        function makeLangSession(over: Partial<Parameters<typeof makeSession>[0]> = {}) {
            return makeSession({
                initialListenMode: false,
                silenceEnabled: false,
                declaredLanguages: DECLARED,
                // What the TwiML opens on: `multi` lets ElevenLabs infer, and
                // the first detection upgrades to a declared voice.
                initialTtsLanguage: 'multi',
                ...over,
            });
        }

        const say = (session: ConversationRelaySession, lang?: string) =>
            session.handleIncoming({ type: 'prompt', voicePrompt: 'hello', lang } as any);

        const ttsFrames = (frames: any[]) =>
            frames.filter(f => f.type === 'language').map(f => f.ttsLanguage);

        it('switches on change only — 4 frames for 7 prompts', async () => {
            const { session, sent } = makeLangSession();
            sessions.push(session);

            for (const lang of ['en', 'en', 'fr', 'fr', 'fr', 'es', 'en']) {
                await say(session, lang);
            }

            expect(ttsFrames(sent)).toEqual(['en-AU', 'fr-FR', 'es-ES', 'en-AU']);
        });

        it('leaves undeclared languages alone rather than switching somewhere undefined', async () => {
            const { session, sent } = makeLangSession();
            sessions.push(session);

            await say(session, 'de');
            await say(session, 'ja');

            expect(ttsFrames(sent)).toEqual([]);
        });

        it('does nothing when the prompt carries no lang at all', async () => {
            const { session, sent } = makeLangSession();
            sessions.push(session);

            await say(session, undefined);

            expect(ttsFrames(sent)).toEqual([]);
        });

        /**
         * `lang` carries the primary tag (`fr`), but a full tag has been seen —
         * hence the tag map rather than a direct code comparison.
         */
        it('resolves a full tag onto its declared code (fr-CA -> fr-FR)', async () => {
            const { session, sent } = makeLangSession();
            sessions.push(session);

            await say(session, 'fr-CA');

            expect(ttsFrames(sent)).toEqual(['fr-FR']);
        });

        it('matches the detected tag case-insensitively', async () => {
            const { session, sent } = makeLangSession();
            sessions.push(session);

            await say(session, 'FR');

            expect(ttsFrames(sent)).toEqual(['fr-FR']);
        });

        /**
         * The latch. Without it, a caller who asks for English while still
         * speaking French is flipped straight back on the next prompt.
         */
        it('stops switching for the rest of the call once the caller explicitly asks', async () => {
            const { session, sent, responseService } = makeLangSession();
            sessions.push(session);

            await say(session, 'fr');
            (responseService as any).handler.toolResult({
                toolType: 'switch-language',
                toolData: { success: true, message: '', action: { type: 'language', ttsLanguage: 'en-AU' } },
            });
            await say(session, 'fr');
            await say(session, 'fr');

            expect(ttsFrames(sent)).toEqual(['fr-FR', 'en-AU']);
        });

        it('keeps the first declaration when two variants share a primary tag', async () => {
            const { session, sent } = makeLangSession({
                declaredLanguages: ['en-AU', 'en-US'],
            });
            sessions.push(session);

            await say(session, 'en');

            expect(ttsFrames(sent)).toEqual(['en-AU']);
        });

        /**
         * Listen mode gates `language` frames, so the switch is suppressed and
         * the parent's `ttsLanguage: "multi"` stays in force — the documented
         * fallback, not a broken switch.
         */
        it('suppresses the switch in listen mode', async () => {
            const { session, sent } = makeLangSession({ initialListenMode: true });
            sessions.push(session);

            await say(session, 'fr');

            expect(ttsFrames(sent)).toEqual([]);
            expect(session.getSuppressedCount()).toBe(1);
        });

        it('re-sends nothing when the detected language is already active', async () => {
            const { session, sent } = makeLangSession({ initialTtsLanguage: 'fr-FR' });
            sessions.push(session);

            await say(session, 'fr');

            expect(ttsFrames(sent)).toEqual([]);
        });
    });

    describe('silence (transport owns policy, service may reword)', () => {
        const texts = (frames: any[]) => frames.filter(f => f.type === 'text').map(f => f.token);

        it('speaks the configured reminders, then ends the call as unresponsive', async () => {
            const { session, sent } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(61_000);

            expect(typesOf(sent)).toEqual(['text', 'text', 'end']);
            expect(texts(sent)).toEqual(['Still there?', 'Just checking you are still there?']);
            expect(JSON.parse(sent[2].handoffData)).toEqual({
                reasonCode: 'unresponsive',
                reason: 'The caller was not speaking',
            });
        });

        it('uses the service wording when it supplies one', async () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            (responseService as any).silenceReminder = vi.fn(async (n: number) =>
                n === 1 ? 'Kia ora, still there?' : null
            );
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(41_000);

            // Reminder 2 falls back to config when the service returns null.
            expect(texts(sent)).toEqual(['Kia ora, still there?', 'Just checking you are still there?']);
        });

        it('falls back to the configured wording when the service throws', async () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            (responseService as any).silenceReminder = vi.fn(async () => {
                throw new Error('down');
            });
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(21_000);

            expect(texts(sent)).toEqual(['Still there?']);
        });

        it('speaks the configured wording after 1.5s when the service never answers', async () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            (responseService as any).silenceReminder = vi.fn(() => new Promise(() => {}));
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(20_000 + 1_400);
            expect(texts(sent)).toEqual([]);
            await vi.advanceTimersByTimeAsync(200);
            expect(texts(sent)).toEqual(['Still there?']);
        });

        it('ends the call on schedule whatever the service returns', async () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            (responseService as any).silenceReminder = vi.fn(async () => 'Custom');
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(61_000);

            expect(typesOf(sent)).toEqual(['text', 'text', 'end']);
            // Asked for reminders only — never consulted about ending.
            expect((responseService as any).silenceReminder.mock.calls).toEqual([[1], [2]]);
        });

        it('restarts from the first reminder when the caller speaks', async () => {
            const { session, sent } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(21_000);
            await session.handleIncoming({ type: 'prompt', voicePrompt: 'hi' } as any);
            await vi.advanceTimersByTimeAsync(21_000);

            expect(texts(sent)).toEqual(['Still there?', 'Still there?']);
        });

        it('never reports silence to the service as an event', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.setup();
            await vi.advanceTimersByTimeAsync(61_000);

            const types = responseService.handleEvent.mock.calls.map(c => c[0].type);
            expect(types).toEqual(['setup']);
        });
    });

    /**
     * The allow-list must describe the call's TwiML. When another app (MINI-TAC)
     * writes the TwiML, SCR's own config is the wrong source.
     */
    describe('resolveCallLanguages (whoever writes the TwiML owns the languages)', () => {
        const config = { languages: ['en-AU', 'en-NZ', 'fr-FR', 'es-ES'], ttsLanguage: 'multi' };

        it("uses the call's <Parameter>s when present", () => {
            expect(
                resolveCallLanguages({ crLanguages: 'en-GB, de-DE', crTtsLanguage: 'en-GB' }, config)
            ).toEqual({ languages: ['en-GB', 'de-DE'], ttsLanguage: 'en-GB', source: 'call' });
        });

        it("falls back to config ttsLanguage when the call gives languages only", () => {
            expect(resolveCallLanguages({ crLanguages: 'en-GB' }, config)).toEqual({
                languages: ['en-GB'],
                ttsLanguage: 'multi',
                source: 'call',
            });
        });

        it('falls back to config when the call says nothing (or an empty list)', () => {
            expect(resolveCallLanguages(undefined, config)).toEqual({ ...config, source: 'config' });
            expect(resolveCallLanguages({ crLanguages: ' , ' }, config)).toEqual({ ...config, source: 'config' });
        });

        it("drives the session's switching: an undeclared-by-the-call language is left alone", async () => {
            const langs = resolveCallLanguages({ crLanguages: 'en-GB,de-DE' }, config);
            const { session, sent } = makeSession({
                initialListenMode: false,
                silenceEnabled: false,
                declaredLanguages: langs.languages,
                initialTtsLanguage: 'multi',
            });
            sessions.push(session);

            await session.handleIncoming({ type: 'prompt', voicePrompt: 'bonjour', lang: 'fr' } as any);
            await session.handleIncoming({ type: 'prompt', voicePrompt: 'hallo', lang: 'de' } as any);

            // fr-FR is in SCR's config but not this call's TwiML, so no switch;
            // de resolves to the call's own de-DE.
            expect(sent.filter(f => f.type === 'language').map(f => f.ttsLanguage)).toEqual(['de-DE']);
        });
    });

    describe('call actions (service asks, transport builds the frame)', () => {
        const act = (rs: any, action: any) =>
            rs.handler.toolResult({ toolType: 't', toolData: { success: true, message: '', action } });

        it('builds sendDigits, play and language frames from actions', () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            act(responseService, { type: 'sendDigits', digits: '6' });
            act(responseService, { type: 'play', source: 'https://x/a.mp3', loop: 1 });
            act(responseService, { type: 'language', ttsLanguage: 'fr-FR' });

            expect(sent).toEqual([
                { type: 'sendDigits', digits: '6' },
                { type: 'play', source: 'https://x/a.mp3', loop: 1 },
                { type: 'language', ttsLanguage: 'fr-FR' },
            ]);
        });

        it('holds endCall until the farewell has been spoken', async () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            act(responseService, { type: 'endCall', handoffData: '{"conversationId":"c1"}' });
            expect(sent).toEqual([]);

            await session.sendText('Transferring you now', true);

            expect(typesOf(sent)).toEqual(['text', 'end']);
            expect(sent[1]).toEqual({ type: 'end', handoffData: '{"conversationId":"c1"}' });
        });

        it('toggles listen mode from an action', () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            act(responseService, { type: 'listenMode', enabled: true });

            expect(session.isListenMode()).toBe(true);
        });

        it('maps an undeclared code to the declared one with the same tag', () => {
            const { session, sent, responseService } = makeSession({
                initialListenMode: false,
                declaredLanguages: ['en-AU', 'fr-FR'],
            });
            sessions.push(session);

            act(responseService, { type: 'language', ttsLanguage: 'en-US', transcriptionLanguage: 'en-GB' });
            act(responseService, { type: 'language', ttsLanguage: 'fr-FR', transcriptionLanguage: 'multi' });

            expect(sent).toEqual([
                { type: 'language', ttsLanguage: 'en-AU', transcriptionLanguage: 'en-AU' },
                { type: 'language', ttsLanguage: 'fr-FR', transcriptionLanguage: 'multi' },
            ]);
        });

        it('drops a language action with no declared match', () => {
            const { session, sent, responseService } = makeSession({
                initialListenMode: false,
                declaredLanguages: ['en-AU', 'fr-FR'],
            });
            sessions.push(session);

            act(responseService, { type: 'language', ttsLanguage: 'de-DE' });

            expect(sent).toEqual([]);
        });

        it('reports what it did: endCall is terminal, a dropped language is not applied', () => {
            const { session, responseService } = makeSession({
                initialListenMode: false,
                declaredLanguages: ['en-AU', 'fr-FR'],
            });
            sessions.push(session);

            expect(act(responseService, { type: 'endCall', handoffData: '{}' })).toEqual({ applied: true, terminal: true });
            expect(act(responseService, { type: 'sendDigits', digits: '6' })).toEqual({ applied: true, terminal: false });
            expect(act(responseService, { type: 'language', ttsLanguage: 'en-US' })).toEqual({
                applied: true,
                terminal: false,
                detail: "Used the call's language: en-US -> en-AU",
            });
            expect(act(responseService, { type: 'language', ttsLanguage: 'de-DE' })).toEqual({
                applied: false,
                terminal: false,
                detail: 'This call only supports: en-AU, fr-FR',
            });
            expect(act(responseService, { type: 'sendDigits', digits: 'abc' })).toEqual({ applied: false, terminal: false });
        });

        it('drops an action whose frame is invalid', () => {
            const { session, sent, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            act(responseService, { type: 'sendDigits', digits: 'abc' });

            expect(sent).toEqual([]);
        });
    });

    describe('call events (transport reports, service decides)', () => {
        it('reports setup as data, with no prompt text of its own', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.setup();

            expect(responseService.handleEvent).toHaveBeenCalledWith({
                type: 'setup',
                setup: { callSid: 'CAtest0000000000000000000000000000' },
                parameters: {},
            });
            expect(Object.keys(responseService)).not.toContain('insertMessage');
        });

        it('maps prompt, dtmf and interrupt frames onto events', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.handleIncoming({ type: 'prompt', voicePrompt: 'hi', lang: 'en-US' } as any);
            await session.handleIncoming({ type: 'dtmf', digit: '5' } as any);
            await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'Hel' } as any);

            expect(responseService.handleEvent.mock.calls.map(c => c[0])).toEqual([
                { type: 'prompt', text: 'hi', lang: 'en-US' },
                { type: 'dtmf', digit: '5' },
                { type: 'interrupt', heard: 'Hel' },
            ]);
        });

        it('reports a status callback as an event', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.handleStatus({ callStatus: 'completed' });

            expect(responseService.handleEvent).toHaveBeenCalledWith({
                type: 'status',
                status: { callStatus: 'completed' },
            });
        });

        it('relays an operator context switch as an event', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.switchContext('campaign');

            expect(responseService.handleEvent).toHaveBeenCalledWith({ type: 'context', key: 'campaign' });
        });

        it('does not forward info or error frames to the service', async () => {
            const { session, responseService } = makeSession({ initialListenMode: false });
            sessions.push(session);

            await session.handleIncoming({ type: 'info' } as any);
            await session.handleIncoming({ type: 'error', description: 'x' } as any);

            expect(responseService.handleEvent).not.toHaveBeenCalled();
        });
    });
});
