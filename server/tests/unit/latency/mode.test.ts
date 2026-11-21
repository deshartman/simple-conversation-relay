import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

async function freshMode() {
    vi.resetModules();
    return import('../../../src/latency/mode.js');
}
import { vi } from 'vitest';

describe('mode.ts', () => {
    const saved = process.env.LATENCY_MODE;
    afterEach(() => {
        if (saved === undefined) delete process.env.LATENCY_MODE;
        else process.env.LATENCY_MODE = saved;
    });

    it('defaults to none when env unset', async () => {
        delete process.env.LATENCY_MODE;
        expect((await freshMode()).getMode()).toBe('none');
    });
    it('uses a valid LATENCY_MODE from env', async () => {
        process.env.LATENCY_MODE = 'jev';
        expect((await freshMode()).getMode()).toBe('jev');
    });
    it('falls back to none for an invalid env value', async () => {
        process.env.LATENCY_MODE = 'bogus';
        expect((await freshMode()).getMode()).toBe('none');
    });
    it('setMode/getMode round-trips every valid mode', async () => {
        const m = await freshMode();
        for (const mode of m.LATENCY_MODES) {
            m.setMode(mode);
            expect(m.getMode()).toBe(mode);
        }
    });
    it('isLatencyMode accepts only the valid set', async () => {
        const { isLatencyMode } = await freshMode();
        expect(isLatencyMode('embedding')).toBe(true);
        for (const bad of ['', 'JEV', 'other', null, undefined, 1, {}]) {
            expect(isLatencyMode(bad)).toBe(false);
        }
    });
});

describe('/latency/mode route', () => {
    let server: Server;
    let base: string;
    let setMode: (m: any) => void;

    beforeEach(async () => {
        delete process.env.LATENCY_MODE;
        vi.resetModules();
        const mode = await import('../../../src/latency/mode.js');
        const { createLatencyModeRouter } = await import('../../../src/latency/modeRoute.js');
        setMode = mode.setMode;
        const app = express();
        app.use(express.json());
        app.use('/latency', createLatencyModeRouter());
        await new Promise<void>((r) => { server = app.listen(0, () => r()); });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latency/mode`;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    const send = (method: string, body?: unknown) =>
        fetch(base, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it('GET /latency/ serves the page with the mode switch', async () => {
        const res = await fetch(base.replace(/mode$/, ''));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('id="sw"');
    });
    it('GET returns mode and available', async () => {
        const res = await send('GET');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ mode: 'none', available: ['none', 'jev', 'embedding'] });
    });
    it.each(['PUT', 'POST'])('%s sets a valid mode and GET reflects it', async (method) => {
        const res = await send(method, { mode: 'embedding' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ mode: 'embedding', previous: 'none' });
        expect((await (await send('GET')).json()).mode).toBe('embedding');
    });
    it('rejects an invalid mode with 400 and leaves state unchanged', async () => {
        setMode('jev');
        for (const body of [{ mode: 'bogus' }, {}, { mode: 5 }]) {
            const res = await send('PUT', body);
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/none, jev, embedding/);
        }
        expect((await (await send('GET')).json()).mode).toBe('jev');
    });
});
