import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/latency/matchFiller.js', () => ({ matchFiller: vi.fn() }));

import { matchFiller } from '../../../src/latency/matchFiller.js';
import { setMode } from '../../../src/latency/mode.js';
import { FALLBACK_FILLERS } from '../../../src/latency/fallbackFillers.js';
import { ConversationRelaySession } from '../../../src/services/ConversationRelaySession.js';

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
const fillers = (sent: any[]) => sent.filter(f => f.type === 'text' && f.token === 'Let me look into that. ');

describe('ConversationRelaySession filler', () => {
    beforeEach(() => { matchMock.mockReset(); setMode('embedding'); });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); delete process.env.LATENCY_FILLER_BUDGET_MS; setMode('none'); });

    it('sends the filler (with trailing space, last:false) when it arrives in time', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(fillers(sent)).toHaveLength(1));
        expect(fillers(sent)[0].last).toBe(false);
    });

    it('drops the filler when the LLM already produced a token', async () => {
        let resolve!: (v: any) => void;
        matchMock.mockReturnValue(new Promise(r => (resolve = r)));
        const { session, sent, rs } = makeSession();
        await prompt(session);
        rs.handler.content({ token: 'Sure', last: false });
        resolve(match);
        await new Promise(r => setTimeout(r, 10));
        expect(fillers(sent)).toHaveLength(0);
    });

    it('drops the filler after an interrupt', async () => {
        let resolve!: (v: any) => void;
        matchMock.mockReturnValue(new Promise(r => (resolve = r)));
        const { session, sent } = makeSession();
        await prompt(session);
        await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'x' } as any);
        resolve(match);
        await new Promise(r => setTimeout(r, 10));
        expect(fillers(sent)).toHaveLength(0);
    });

    it('drops the filler from a stale turn', async () => {
        let resolveFirst!: (v: any) => void;
        matchMock.mockReturnValueOnce(new Promise(r => (resolveFirst = r)));
        matchMock.mockResolvedValueOnce(null);
        const { session, sent } = makeSession();
        await prompt(session, 'first');
        await prompt(session, 'second');
        resolveFirst(match);
        await new Promise(r => setTimeout(r, 10));
        expect(fillers(sent)).toHaveLength(0);
    });

    it('drops the filler in listen mode', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession(true);
        await prompt(session);
        await new Promise(r => setTimeout(r, 10));
        expect(fillers(sent)).toHaveLength(0);
    });

    const fallbacks = (sent: any[]) => sent.filter(f => f.type === 'text' && FALLBACK_FILLERS.some(x => f.token === x + ' '));
    const missWith = (reason: string) => (async (_t: string, _s: unknown, onMiss?: (r: string) => void) => { onMiss?.(reason); return null; }) as any;

    it.each(['below-threshold', 'catch-all'])('sends a fallback when the matcher misses (%s)', async (reason) => {
        matchMock.mockImplementation(missWith(reason));
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(fallbacks(sent)).toHaveLength(1));
        expect(fallbacks(sent)[0].last).toBe(false);
        expect(sent.filter(f => f.type === 'text')).toHaveLength(1);
    });

    it('sends a fallback when the matcher errors', async () => {
        matchMock.mockImplementation(missWith('error'));
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.waitFor(() => expect(fallbacks(sent)).toHaveLength(1));
    });

    it('sends the fallback at the budget without waiting, and drops the late match', async () => {
        vi.useFakeTimers();
        process.env.LATENCY_FILLER_BUDGET_MS = '100';
        matchMock.mockImplementation(() => new Promise(r => setTimeout(() => r(match), 1000)));
        const { session, sent } = makeSession();
        await prompt(session);
        await vi.advanceTimersByTimeAsync(99);
        expect(sent.filter(f => f.type === 'text')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(2);
        expect(fallbacks(sent)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(fillers(sent)).toHaveLength(0);
        expect(sent.filter(f => f.type === 'text')).toHaveLength(1);
    });

    it('sends only one acknowledgement when the match is in time', async () => {
        matchMock.mockResolvedValue(match);
        const { session, sent } = makeSession();
        await prompt(session);
        await new Promise(r => setTimeout(r, 30));
        expect(sent.filter(f => f.type === 'text')).toHaveLength(1);
    });

    it('rotates fallbacks without an immediate repeat', async () => {
        matchMock.mockImplementation(missWith('no-match'));
        const { session, sent } = makeSession();
        for (let i = 0; i < FALLBACK_FILLERS.length + 2; i++) {
            await prompt(session);
            await vi.waitFor(() => expect(sent.filter(f => f.type === 'text')).toHaveLength(i + 1));
        }
        const toks = sent.filter(f => f.type === 'text').map(f => f.token);
        toks.slice(1).forEach((t, i) => expect(t).not.toBe(toks[i]));
    });

    it('drops the fallback when the LLM spoke first', async () => {
        let resolve!: (v: any) => void;
        matchMock.mockImplementation(((_t: string, _s: unknown, onMiss?: (r: string) => void) => new Promise(r => (resolve = () => { onMiss?.('no-match'); r(null); }))) as any);
        const { session, sent, rs } = makeSession();
        await prompt(session);
        rs.handler.content({ token: 'Sure', last: false });
        resolve(null);
        await new Promise(r => setTimeout(r, 10));
        expect(fallbacks(sent)).toHaveLength(0);
    });

    it('drops the fallback at the budget after an interrupt', async () => {
        vi.useFakeTimers();
        process.env.LATENCY_FILLER_BUDGET_MS = '100';
        matchMock.mockImplementation(() => new Promise(() => {}));
        const { session, sent } = makeSession();
        await prompt(session);
        await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'x' } as any);
        await prompt(session, 'again');
        await vi.advanceTimersByTimeAsync(200);
        expect(fallbacks(sent)).toHaveLength(1); // only the second (current) turn
    });

    it('mode none sends nothing and never calls the matcher', async () => {
        setMode('none');
        const { session, sent } = makeSession();
        await prompt(session);
        await new Promise(r => setTimeout(r, 20));
        expect(sent.filter(f => f.type === 'text')).toHaveLength(0);
        expect(matchMock).not.toHaveBeenCalled();
    });
});
