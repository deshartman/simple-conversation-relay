import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/latency/matchFiller.js', () => ({ matchFiller: vi.fn() }));

import { matchFiller } from '../../../src/latency/matchFiller.js';
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
    beforeEach(() => { matchMock.mockReset(); });
    afterEach(() => vi.restoreAllMocks());

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

    it('drops the filler when matching exceeded the budget', async () => {
        process.env.LATENCY_FILLER_BUDGET_MS = '5';
        matchMock.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); return match; });
        const { session, sent } = makeSession();
        await prompt(session);
        await new Promise(r => setTimeout(r, 60));
        delete process.env.LATENCY_FILLER_BUDGET_MS;
        expect(fillers(sent)).toHaveLength(0);
    });
});
