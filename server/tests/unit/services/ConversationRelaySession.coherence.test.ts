import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/latency/matchFiller.js', () => ({ matchFiller: vi.fn() }));
vi.mock('../../../src/latency/coherence.js', () => ({ classifyCoherence: vi.fn() }));
vi.mock('../../../src/utils/logger.js', async (orig) => ({ ...(await orig<any>()), logOut: vi.fn(), logError: vi.fn() }));

import { matchFiller } from '../../../src/latency/matchFiller.js';
import { classifyCoherence } from '../../../src/latency/coherence.js';
import { setMode, setQuestionWaitMs, setLlmDelayMs, setHandlerEnabled } from '../../../src/latency/mode.js';
import { logOut } from '../../../src/utils/logger.js';
import { ConversationRelaySession } from '../../../src/services/ConversationRelaySession.js';

const match = { filler: { id: 'x', say: 'Okay.' }, score: 0.9, mode: 'embedding', ms: 20 } as any;
const classify = vi.mocked(classifyCoherence);
const answer = (cls: string) => classify.mockResolvedValueOnce({ cls, source: 'embedding', ms: 5, score: 0.9 } as any);

function makeSession() {
    const sent: any[] = [];
    const rs = { handler: null as any, createResponseHandler(h: any) { this.handler = h; }, handleEvent: vi.fn(async () => {}), cleanup: vi.fn() };
    const session = new ConversationRelaySession({
        responseService: rs as any,
        sessionData: { parameterData: {}, setupData: { callSid: 'CAtest' } } as any,
        silenceConfig: { enabled: false, secondsThreshold: 20, messages: [] },
        initialListenMode: false,
        send: (f: any) => sent.push(f),
    });
    return { session, sent, rs };
}
const prompt = (s: ConversationRelaySession, text: string) =>
    s.handleIncoming({ type: 'prompt', voicePrompt: text, lang: 'en-US', last: true } as any);
const prompts = (rs: any) => rs.handleEvent.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === 'prompt');
const texts = (sent: any[]) => sent.filter(f => f.type === 'text');

describe('ConversationRelaySession coherence', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        classify.mockReset();
        vi.mocked(matchFiller).mockReset();
        vi.mocked(matchFiller).mockResolvedValue(match);
        vi.mocked(logOut).mockClear();
        setMode('embedding');
        setQuestionWaitMs(2000);
        process.env.LATENCY_HOLD_URL = '';
    });
    afterEach(() => {
        vi.useRealTimers();
        delete process.env.LATENCY_HOLD_URL;
        setMode('none');
        setQuestionWaitMs(0);
        setLlmDelayMs(0);
        setHandlerEnabled(true);
    });

    it('question_wait 0 sends at once without classifying', async () => {
        setQuestionWaitMs(0);
        const { session, rs } = makeSession();
        await prompt(session, 'hello there');
        expect(classify).not.toHaveBeenCalled();
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'hello there', lang: 'en-US' }]);
    });

    it('Handler off sends at once without classifying (coherence is part of the Handler)', async () => {
        setHandlerEnabled(false);
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill yesterday');
        expect(classify).not.toHaveBeenCalled();
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'I got my bill yesterday', lang: 'en-US' }]);
    });

    it('mode none sends at once without classifying', async () => {
        setMode('none');
        const { session, rs } = makeSession();
        await prompt(session, 'hello there');
        expect(classify).not.toHaveBeenCalled();
        expect(prompts(rs)).toHaveLength(1);
    });

    it('a question is sent at once', async () => {
        answer('question');
        const { session, rs } = makeSession();
        await prompt(session, 'why is my bill so high?');
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'why is my bill so high?', lang: 'en-US' }]);
        expect(classify).toHaveBeenCalledWith('embedding', 'why is my bill so high?', []);
    });

    it('a statement waits for question_wait, then is sent', async () => {
        answer('statement');
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill yesterday');
        await vi.advanceTimersByTimeAsync(1999);
        expect(prompts(rs)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(2);
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'I got my bill yesterday', lang: 'en-US' }]);
        expect(vi.mocked(logOut).mock.calls.some(c => String(c[1]).includes('coherence flush reason=timeout pieces=1'))).toBe(true);
    });

    it('a second prompt inside the wait is joined into one handleEvent, with the first as context', async () => {
        answer('statement');
        answer('question');
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill yesterday');
        await vi.advanceTimersByTimeAsync(1000);
        await prompt(session, 'why is it so high?');
        expect(classify).toHaveBeenLastCalledWith('embedding', 'why is it so high?', ['I got my bill yesterday']);
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'I got my bill yesterday why is it so high?', lang: 'en-US' }]);
        await vi.advanceTimersByTimeAsync(5000);
        expect(prompts(rs)).toHaveLength(1);
    });

    it('a new statement inside the wait restarts the timer', async () => {
        answer('statement');
        answer('filler');
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill');
        await vi.advanceTimersByTimeAsync(1500);
        await prompt(session, 'um');
        await vi.advanceTimersByTimeAsync(1500);
        expect(prompts(rs)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(600);
        expect(prompts(rs)[0].text).toBe('I got my bill um');
    });

    it('changed-mind sends the whole buffer at once', async () => {
        answer('statement');
        answer('changed-mind');
        const { session, rs } = makeSession();
        await prompt(session, 'cancel my order');
        await prompt(session, 'actually, no');
        expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'cancel my order actually, no', lang: 'en-US' }]);
    });

    it('a classifier error sends at once', async () => {
        classify.mockRejectedValueOnce(new Error('boom'));
        const { session, rs } = makeSession();
        await prompt(session, 'so');
        expect(prompts(rs)).toHaveLength(1);
        expect(vi.mocked(logOut).mock.calls.some(c => String(c[1]).includes('coherence flush reason=error pieces=1'))).toBe(true);
    });

    it('an interrupt during the wait restarts the timer and is still forwarded', async () => {
        answer('statement');
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill');
        await vi.advanceTimersByTimeAsync(1500);
        await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'Okay' } as any);
        expect(rs.handleEvent).toHaveBeenCalledWith({ type: 'interrupt', heard: 'Okay' });
        await vi.advanceTimersByTimeAsync(1500);
        expect(prompts(rs)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(600);
        expect(prompts(rs)).toHaveLength(1);
    });

    it('every prompt still gets its acknowledgement', async () => {
        answer('statement');
        answer('question');
        const { session, sent } = makeSession();
        await prompt(session, 'I got my bill');
        await prompt(session, 'why is it high?');
        await vi.advanceTimersByTimeAsync(10);
        expect(texts(sent).map(f => f.token)).toEqual(['Okay. ', 'Okay. ']);
    });

    it('cleanup clears the timer and drops the buffer', async () => {
        answer('statement');
        const { session, rs } = makeSession();
        await prompt(session, 'I got my bill');
        session.cleanup();
        await vi.advanceTimersByTimeAsync(5000);
        expect(prompts(rs)).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a prompt after a flush is a new turn with no old buffer', async () => {
        answer('question');
        answer('question');
        const { session, rs } = makeSession();
        await prompt(session, 'first?');
        rs.handler.content({ type: 'text', token: 'Answer.', last: true }); // answered, so the window is closed
        await prompt(session, 'second?');
        expect(prompts(rs).map((e: any) => e.text)).toEqual(['first?', 'second?']);
    });

    it('the LLM delay counts from the flush, not from the prompt', async () => {
        setLlmDelayMs(500);
        answer('statement');
        const { session, rs } = makeSession();
        void prompt(session, 'I got my bill');
        await vi.advanceTimersByTimeAsync(1999);
        expect(rs.handleEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2); // flush at 2000
        expect(rs.handleEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(498);
        expect(rs.handleEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5);
        expect(prompts(rs)).toHaveLength(1);
    });

    describe('merge before answer', () => {
        const logged = (text: string) => vi.mocked(logOut).mock.calls.some(c => String(c[1]).includes(text));
        const events = (rs: any, type: string) => rs.handleEvent.mock.calls.map((c: any[]) => c[0]).filter((e: any) => e.type === type);

        it('merges in the LLM delay: one send with the joined text, the stale send skipped', async () => {
            setLlmDelayMs(500);
            answer('question');
            answer('question');
            const { session, rs } = makeSession();
            void prompt(session, 'Do you do voice?');
            await vi.advanceTimersByTimeAsync(100);
            void prompt(session, 'And what kind of voice?');
            await vi.advanceTimersByTimeAsync(2000);
            expect(prompts(rs)).toEqual([{ type: 'prompt', text: 'Do you do voice? And what kind of voice?', lang: 'en-US' }]);
            expect(events(rs, 'retract')).toHaveLength(0);
            expect(logged('coherence merge state=delay pieces=2')).toBe(true);
        });

        it('merges in flight: retract, then one merged prompt', async () => {
            answer('question');
            answer('question');
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            await prompt(session, 'And voice?');
            expect(rs.handleEvent.mock.calls.map((c: any[]) => c[0].type)).toEqual(['prompt', 'retract', 'prompt']);
            expect(prompts(rs)[1].text).toBe('Do you do SMS? And voice?');
            expect(logged('coherence merge state=in-flight pieces=2')).toBe(true);
        });

        it('keeps arrival order when two pieces arrive together during a retract (call CAdb229c)', async () => {
            answer('question');
            answer('question');
            answer('question');
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            const p2 = prompt(session, 'Actually, do you do voice?');
            const p3 = prompt(session, 'And what kind of voice?');
            await Promise.all([p2, p3]);
            await vi.advanceTimersByTimeAsync(10);
            const last = prompts(rs).at(-1);
            expect(last.text).toBe('Do you do SMS? Actually, do you do voice? And what kind of voice?');
        });

        it('does not merge after the first LLM token', async () => {
            answer('question');
            answer('question');
            const { session, rs } = makeSession();
            await prompt(session, 'first?');
            rs.handler.content({ type: 'text', token: 'Yes', last: false });
            await prompt(session, 'second?');
            expect(events(rs, 'retract')).toHaveLength(0);
            expect(prompts(rs).map((e: any) => e.text)).toEqual(['first?', 'second?']);
        });

        it('does not merge after a tool started', async () => {
            answer('question');
            answer('question');
            const { session, rs } = makeSession();
            await prompt(session, 'first?');
            rs.handler.toolCallStart(new Promise(() => {}));
            await prompt(session, 'second?');
            expect(events(rs, 'retract')).toHaveLength(0);
            expect(prompts(rs).map((e: any) => e.text)).toEqual(['first?', 'second?']);
        });

        it('an interrupt before the answer is not forwarded and restarts the wait', async () => {
            answer('question');
            answer('statement');
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            await prompt(session, 'um also'); // merged, now waiting
            expect(prompts(rs)).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1500);
            await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: '' } as any);
            expect(events(rs, 'interrupt')).toHaveLength(0);
            expect(logged('interrupt before answer: treated as caller still talking')).toBe(true);
            await vi.advanceTimersByTimeAsync(1500);
            expect(prompts(rs)).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(600);
            expect(prompts(rs)).toHaveLength(2);
        });

        it('an interrupt after the first token is forwarded', async () => {
            answer('question');
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            rs.handler.content({ type: 'text', token: 'Yes', last: false });
            await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: 'Yes' } as any);
            expect(rs.handleEvent).toHaveBeenCalledWith({ type: 'interrupt', heard: 'Yes' });
        });

        it('merges with question_wait 0 when the Handler is on', async () => {
            setQuestionWaitMs(0);
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            await prompt(session, 'And voice?');
            expect(events(rs, 'retract')).toHaveLength(1);
            expect(prompts(rs)[1].text).toBe('Do you do SMS? And voice?');
        });

        it('Handler off: no merge and every interrupt is forwarded', async () => {
            setHandlerEnabled(false);
            const { session, rs } = makeSession();
            await prompt(session, 'Do you do SMS?');
            await session.handleIncoming({ type: 'interrupt', utteranceUntilInterrupt: '' } as any);
            expect(rs.handleEvent).toHaveBeenCalledWith({ type: 'interrupt', heard: '' });
            await prompt(session, 'And voice?');
            expect(events(rs, 'retract')).toHaveLength(0);
            expect(prompts(rs).map((e: any) => e.text)).toEqual(['Do you do SMS?', 'And voice?']);
        });

        it('Handler off: two prompts inside the LLM delay are both sent', async () => {
            setHandlerEnabled(false);
            setLlmDelayMs(500);
            const { session, rs } = makeSession();
            void prompt(session, 'one');
            await vi.advanceTimersByTimeAsync(100);
            void prompt(session, 'two');
            await vi.advanceTimersByTimeAsync(1000);
            expect(prompts(rs).map((e: any) => e.text)).toEqual(['one', 'two']);
        });
    });
});
