import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/latency/matchFiller.js', () => ({ matchFiller: vi.fn() }));
vi.mock('../../../src/utils/logger.js', async (orig) => ({ ...(await orig<any>()), logOut: vi.fn(), logError: vi.fn() }));

import { matchFiller } from '../../../src/latency/matchFiller.js';
import { setMode, setHandlerEnabled, setLlmDelayMs } from '../../../src/latency/mode.js';
import { logOut } from '../../../src/utils/logger.js';
import { ConversationRelaySession } from '../../../src/services/ConversationRelaySession.js';

const URL_ = 'https://example.test/media/hold.wav';
const match = { filler: { id: 'x', say: 'Let me look into that.' }, score: 0.9, mode: 'embedding', ms: 20 } as any;
const matchMock = vi.mocked(matchFiller);

function makeSession(listenMode = false) {
    const sent: any[] = [];
    const rs = { handler: null as any, createResponseHandler(h: any) { this.handler = h; }, handleEvent: vi.fn(async () => {}), cleanup: vi.fn() };
    const session = new ConversationRelaySession({
        responseService: rs as any,
        sessionData: { parameterData: {}, setupData: { callSid: 'CAtest' } } as any,
        silenceConfig: { enabled: false, secondsThreshold: 20, messages: [] },
        initialListenMode: listenMode,
        send: (f: any) => sent.push(f),
    });
    return { session, sent, rs };
}

const prompt = (s: ConversationRelaySession, text = 'check my balance') =>
    s.handleIncoming({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true } as any);
const plays = (sent: any[]) => sent.filter(f => f.type === 'play');
const texts = (sent: any[]) => sent.filter(f => f.type === 'text');
const settle = () => new Promise(r => setTimeout(r, 20));
const preempted = () => vi.mocked(logOut).mock.calls.filter(c => String(c[1]).includes('hold preempted'));

describe('ConversationRelaySession hold media', () => {
    beforeEach(() => {
        matchMock.mockReset();
        vi.mocked(logOut).mockClear();
        setMode('embedding');
        process.env.LATENCY_HOLD_URL = URL_;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        delete process.env.LATENCY_HOLD_URL;
        delete process.env.LATENCY_FILLER_BUDGET_MS;
        setMode('none');
        setHandlerEnabled(true);
        setLlmDelayMs(0);
    });

    it('sends exactly one play after the filler, with the configured options', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(plays(sent)).toHaveLength(1));
        await settle();
        expect(plays(sent)).toEqual([{ type: 'play', source: URL_, loop: 1, preemptible: true, interruptible: true }]);
        expect(sent.map(f => f.type)).toEqual(['text', 'play']);
    });

    it('sends no play when the LLM token arrives before the filler emits', async () => {
        let resolve!: (v: any) => void;
        matchMock.mockReturnValue(new Promise(r => (resolve = r)));
        const { session, sent, rs } = makeSession();
        await prompt(session);
        rs.handler.content({ token: 'Sure', last: false });
        resolve(match);
        await settle();
        expect(plays(sent)).toHaveLength(0);
    });

    it('sends no play when an interrupt comes before the filler emits', async () => {
        let resolve!: (v: any) => void;
        matchMock.mockReturnValue(new Promise(r => (resolve = r)));
        const { session, sent } = makeSession();
        await prompt(session);
        await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'x' } as any);
        resolve(match);
        await settle();
        expect(plays(sent)).toHaveLength(0);
    });

    it('sends no play in listen mode', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession(true);
        await prompt(session);
        await settle();
        expect(plays(sent)).toHaveLength(0);
    });

    it('sends no play when LATENCY_HOLD_URL is empty, but still sends the filler', async () => {
        process.env.LATENCY_HOLD_URL = '';
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(texts(sent)).toHaveLength(1));
        await settle();
        expect(plays(sent)).toHaveLength(0);
    });

    it('sends no play when the handler is off, but still sends the filler', async () => {
        setHandlerEnabled(false);
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(texts(sent)).toHaveLength(1));
        await settle();
        expect(plays(sent)).toHaveLength(0);
        expect(vi.mocked(logOut).mock.calls.some(c => String(c[1]).includes('hold skipped reason=handler-off'))).toBe(true);
    });

    it('delays the LLM call by the runtime-set delay', async () => {
        vi.useFakeTimers();
        setLlmDelayMs(500);
        matchMock.mockResolvedValue(match);
        const { session, rs } = makeSession();
        void prompt(session);
        await vi.advanceTimersByTimeAsync(499);
        expect(rs.handleEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(rs.handleEvent).toHaveBeenCalledTimes(1);
    });

    it('mode none sends no filler and no play', async () => {
        setMode('none');
        const { session, sent } = makeSession();
        await prompt(session);
        await settle();
        expect(sent).toHaveLength(0);
    });

    it('keeps wire order text(ack) -> play -> text(llm token)', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent, rs } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(plays(sent)).toHaveLength(1));
        rs.handler.content({ token: 'Your balance', last: false });
        expect(sent.map(f => f.type)).toEqual(['text', 'play', 'text']);
        expect(sent[0].token).toBe('Let me look into that. ');
        expect(sent[2].token).toBe('Your balance');
    });

    it('logs "hold preempted" only on the first non-whitespace token', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent, rs } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(plays(sent)).toHaveLength(1));
        rs.handler.content({ token: ' ', last: false });
        expect(preempted()).toHaveLength(0);
        rs.handler.content({ token: 'Hello', last: false });
        expect(preempted()).toHaveLength(1);
        expect(String(preempted()[0][1])).toMatch(/hold preempted \d+ms after hold sent/);
        rs.handler.content({ token: ' there', last: false });
        expect(preempted()).toHaveLength(1);
    });

    it('also sends one play after the fallback acknowledgement (budget timeout)', async () => {
        vi.useFakeTimers();
        process.env.LATENCY_FILLER_BUDGET_MS = '100';
        matchMock.mockImplementation(() => new Promise(r => setTimeout(() => r(match), 1000)));
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.advanceTimersByTimeAsync(101);
        expect(plays(sent)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(plays(sent)).toHaveLength(1);
        expect(sent.map(f => f.type)).toEqual(['text', 'play']);
    });

    it('sends only one play per turn even if the hold start runs twice', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(plays(sent)).toHaveLength(1));
        (session as any).maybeStartHold(1);
        (session as any).maybeStartHold(1);
        expect(plays(sent)).toHaveLength(1);
    });
});
