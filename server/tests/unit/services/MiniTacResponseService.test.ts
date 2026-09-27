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
    service.createResponseHandler({
        content: r => content.push({ token: r.token, last: r.last }),
        toolResult: () => {},
        error: () => {},
        callSid: () => {},
    });
    return { service, calls, content };
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
