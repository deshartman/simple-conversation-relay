/**
 * MiniTacResponseService — HTTP adapter to a MINI-TAC agent.
 *
 * fetch is stubbed so the tests pin the wire contract: lazy session
 * creation, NDJSON token mapping, interrupt semantics and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MiniTacResponseService } from '../../../src/services/MiniTacResponseService.js';

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
        if (url.endsWith('/sessions')) return Response.json({ key: 'CA1', isNew: true, name: null });
        if (url.endsWith('/respond')) return ndjson(respondLines);
        if (init.method === 'DELETE') return new Response(null, { status: 202 });
        return Response.json({ ok: true });
    }));

    const service = new MiniTacResponseService({
        baseUrl: 'http://localhost:8000/',
        apiKey: 'secret',
        key: 'CA1',
        phone: '+61491570156',
        instructions: 'ctx',
    });
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

const flush = () => new Promise(r => setTimeout(r, 0));

describe('MiniTacResponseService', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.unstubAllGlobals());

    it('creates the session before the first message, with bearer auth', async () => {
        const { service, calls } = setup();
        await service.insertMessage('system', 'call details');

        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
            'POST http://localhost:8000/sessions',
            'POST http://localhost:8000/sessions/CA1/messages',
        ]);
        expect(calls[0].body).toEqual({ key: 'CA1', phone: '+61491570156', channel: 'voice', instructions: 'ctx' });
        expect(calls[1].body).toEqual({ role: 'system', content: 'call details' });
        expect(calls.every(c => c.auth === 'Bearer secret')).toBe(true);
    });

    it('maps NDJSON tokens to content and ends with last:true', async () => {
        const { service, content } = setup();
        await service.generateResponse('user', 'hello');

        expect(content).toEqual([
            { token: 'Hi', last: false },
            { token: ' there', last: false },
            { token: '', last: true },
        ]);
    });

    it('does not emit last:true when MINI-TAC reports the turn interrupted', async () => {
        const { service, content } = setup([{ token: 'Hi' }, { last: true, interrupted: true }]);
        await service.generateResponse('user', 'hello');

        expect(content).toEqual([{ token: 'Hi', last: false }]);
    });

    it('routes a {"frame"} line through toolResult, before last:true', async () => {
        const end = { type: 'end', handoffData: '{"reasonCode":"live-agent-handoff"}' };
        const order: string[] = [];
        const { service, content, toolResults } = setup([
            { token: 'Transferring you' },
            { frame: end, tool: 'handoff' },
            { last: true, text: 'Transferring you' },
        ]);
        const handler = (service as any).responseHandler;
        const content0 = handler.content, tool0 = handler.toolResult;
        handler.content = (r: any) => { order.push(r.last ? 'last' : 'token'); content0(r); };
        handler.toolResult = (e: any) => { order.push('frame'); tool0(e); };

        await service.generateResponse('user', 'agent please');

        expect(toolResults).toEqual([{
            toolType: 'handoff',
            toolData: { success: true, message: 'from MINI-TAC', outgoingMessage: end },
        }]);
        expect(order).toEqual(['token', 'frame', 'last']);
        expect(content).toHaveLength(2);
    });

    it('forwards what the caller heard on interrupt', async () => {
        const { service, calls } = setup();
        service.interrupt('Hi th');
        await flush();

        const interrupt = calls.find(c => c.url.endsWith('/interrupt'))!;
        expect(interrupt.body).toEqual({ heard: 'Hi th' });
    });

    it('deletes the session on cleanup so MINI-TAC can consolidate memory', async () => {
        const { service, calls } = setup();
        service.cleanup();
        await flush();

        expect(calls[calls.length - 1]).toMatchObject({ method: 'DELETE', url: 'http://localhost:8000/sessions/CA1' });
    });
});
