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
import { ConversationRelaySession } from '../../../src/services/ConversationRelaySession.js';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';

function makeFakeResponseService() {
    return {
        handler: null as any,
        createResponseHandler(h: any) {
            this.handler = h;
        },
        generateResponse: vi.fn(async () => {}),
        insertMessage: vi.fn(async () => {}),
        interrupt: vi.fn(),
        updateContext: vi.fn(async () => {}),
        updateTools: vi.fn(),
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
        registry: new ToolRegistry(),
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
            const { session, sent } = makeSession({ initialListenMode: true, silenceEnabled: true });
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
            const { session, sent } = makeLangSession();
            sessions.push(session);

            await say(session, 'fr');
            session.switchLanguage({ ttsLanguage: 'en-AU' });
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
});
