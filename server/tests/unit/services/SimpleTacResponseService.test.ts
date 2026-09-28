/**
 * SimpleTacResponseService — HTTP adapter to a SIMPLE-TAC agent.
 *
 * fetch is stubbed so the tests pin the wire contract: session creation on
 * the setup event, NDJSON token mapping, interrupt semantics, dtmf/status
 * events and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimpleTacResponseService } from '../../../src/services/SimpleTacResponseService.js';

type Call = { method: string; url: string; body: any; auth: string | null };

function ndjson(lines: object[]) {
    return new Response(lines.map(l => JSON.stringify(l)).join('\n') + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson' },
    });
}

function setup(respondLines: object[] = [{ token: 'Hi' }, { token: ' there' }, { last: true, text: 'Hi there' }]) {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
            method: init.method!,
            url,
            body: init.body ? JSON.parse(init.body as string) : undefined,
            auth: (init.headers as Record<string, string>).Authorization ?? null,
        });
        if (url.endsWith('/sessions')) return Response.json({ key: 'CA1' });
        if (url.endsWith('/respond')) return ndjson(respondLines);
        if (init.method === 'DELETE') return new Response(null, { status: 202 });
        return Response.json({ ok: true });
    }));

    const service = new SimpleTacResponseService({ baseUrl: 'http://localhost:8000/', apiKey: 'secret' });
    const content: { token: string; last: boolean }[] = [];
    const toolResults: any[] = [];
    service.createResponseHandler({
        content: r => content.push({ token: r.token, last: r.last }),
        toolResult: e => toolResults.push(e),
        error: () => {},
        callSid: () => {},
    });
    return { service, calls, content, toolResults };
}

const SETUP = { callSid: 'CA1', from: '+61491570156', to: '+61468160172', customParameters: { a: 'b' } };

/** setup() then the service, as the transport drives it. */
async function started(respondLines?: object[]) {
    const ctx = setup(respondLines);
    await ctx.service.handleEvent({ type: 'setup', setup: SETUP, parameters: { requestData: {} } });
    return ctx;
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('SimpleTacResponseService', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('creates the session from the setup event, without instructions', async () => {
        const { service, calls } = await started();
        await service.handleEvent({ type: 'dtmf', digit: '1' });

        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
            'POST http://localhost:8000/sessions',
            'POST http://localhost:8000/sessions/CA1/events',
        ]);
        expect(calls[0].body).toEqual({
            key: 'CA1',
            phone: '+61491570156',
            channel: 'voice',
            setup: SETUP,
            parameters: { requestData: {} },
        });
        expect(calls.every(c => c.auth === 'Bearer secret')).toBe(true);
    });

    it('maps a prompt event to /respond and NDJSON tokens to content', async () => {
        const { service, calls, content } = await started();
        await service.handleEvent({ type: 'prompt', text: 'hello', lang: 'en-US' });

        expect(calls[1].body).toEqual({ role: 'user', content: 'hello', lang: 'en-US' });
        expect(content).toEqual([
            { token: 'Hi', last: false },
            { token: ' there', last: false },
            { token: '', last: true },
        ]);
    });

    it('does not emit last:true when SIMPLE-TAC reports the turn interrupted', async () => {
        const { service, content } = await started([{ token: 'Hi' }, { last: true, interrupted: true }]);
        await service.handleEvent({ type: 'prompt', text: 'hello' });

        expect(content).toEqual([{ token: 'Hi', last: false }]);
    });

    it('posts dtmf and status events to /events', async () => {
        const { service, calls } = await started();
        await service.handleEvent({ type: 'dtmf', digit: '5' });
        await service.handleEvent({ type: 'status', status: { callStatus: 'completed' } });

        expect(calls.slice(1).map(c => [c.url, c.body])).toEqual([
            ['http://localhost:8000/sessions/CA1/events', { type: 'dtmf', digit: '5' }],
            ['http://localhost:8000/sessions/CA1/events', { type: 'status', status: { callStatus: 'completed' } }],
        ]);
    });

    describe('silenceReminder (wording only; SCR owns the policy)', () => {
        /** Replace the /events reply for silence lookups. */
        function eventsReply(reply: (init: RequestInit) => Promise<Response>) {
            const base = (globalThis.fetch as any).getMockImplementation();
            vi.mocked(globalThis.fetch).mockImplementation(async (url: any, init: any) =>
                String(url).endsWith('/events') ? reply(init) : base(url, init)
            );
        }

        it('asks /events for wording and returns SIMPLE-TAC text', async () => {
            const { service } = await started();
            let asked: unknown;
            eventsReply(async init => {
                asked = JSON.parse(init.body as string);
                return Response.json({ text: 'Are you still with me?' });
            });

            expect(await service.silenceReminder(1)).toBe('Are you still with me?');
            expect(asked).toEqual({ type: 'silence', count: 1 });
        });

        it('returns null when SIMPLE-TAC has no wording ({ok:true})', async () => {
            const { service } = await started();
            eventsReply(async () => Response.json({ ok: true }));

            expect(await service.silenceReminder(1)).toBeNull();
        });

        it('returns null on an error status', async () => {
            const { service } = await started();
            eventsReply(async () => new Response('nope', { status: 500 }));

            expect(await service.silenceReminder(2)).toBeNull();
        });

        it('gives up after 1.5s so a slow SIMPLE-TAC cannot delay the reminder', async () => {
            const { service } = await started();
            eventsReply(
                init =>
                    new Promise((_resolve, reject) => {
                        init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
                    })
            );

            const started_at = Date.now();
            expect(await service.silenceReminder(1)).toBeNull();
            const waited = Date.now() - started_at;
            expect(waited).toBeGreaterThanOrEqual(1400);
            expect(waited).toBeLessThan(3000);
        });
    });

    it('ignores a context event — SIMPLE-TAC owns its prompt', async () => {
        const { service, calls } = await started();
        await service.handleEvent({ type: 'context', key: 'campaign' });

        expect(calls).toHaveLength(1); // just /sessions
    });

    it('makes no SIMPLE-TAC calls before the setup event', async () => {
        const { service, calls } = setup();
        await service.handleEvent({ type: 'dtmf', digit: '1' });

        expect(calls).toEqual([]);
    });

    it('maps a {"handoff"} line to an endCall action, before last:true', async () => {
        const handoffData = '{"conversationId":"conv_1","storeId":"mem_1"}';
        const order: string[] = [];
        const { service, toolResults } = await started([
            { token: 'Transferring you' },
            { handoff: handoffData, tool: 'handoff' },
            { last: true, text: 'Transferring you' },
        ]);
        const handler = (service as any).responseHandler;
        const content0 = handler.content, tool0 = handler.toolResult;
        handler.content = (r: any) => { order.push(r.last ? 'last' : 'token'); content0(r); };
        handler.toolResult = (e: any) => { order.push('handoff'); tool0(e); };

        await service.handleEvent({ type: 'prompt', text: 'agent please' });

        expect(toolResults).toEqual([{
            toolType: 'handoff',
            toolData: { success: true, message: 'from SIMPLE-TAC', action: { type: 'endCall', handoffData } },
        }]);
        expect(order).toEqual(['token', 'handoff', 'last']);
    });

    it('forwards what the caller heard on interrupt', async () => {
        const { service, calls } = await started();
        await service.handleEvent({ type: 'interrupt', heard: 'Hi th' });
        await flush();

        const interrupt = calls.find(c => c.url.endsWith('/interrupt'))!;
        expect(interrupt.body).toEqual({ heard: 'Hi th' });
    });

    it('deletes the session on cleanup so SIMPLE-TAC can consolidate memory', async () => {
        const { service, calls } = await started();
        service.cleanup();
        await flush();

        expect(calls[calls.length - 1]).toMatchObject({ method: 'DELETE', url: 'http://localhost:8000/sessions/CA1' });
    });
});
