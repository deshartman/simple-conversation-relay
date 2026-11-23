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
        expect(isLatencyMode('laya')).toBe(true);
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
        expect(await res.json()).toEqual({ mode: 'none', available: ['none', 'jev', 'embedding', 'laya'] });
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
            expect((await res.json()).error).toMatch(/none, jev, embedding, laya/);
        }
        expect((await (await send('GET')).json()).mode).toBe('jev');
    });
});

describe('delay and handler settings', () => {
    const saved = { d: process.env.LATENCY_TEST_LLM_DELAY_MS, h: process.env.LATENCY_HANDLER };
    afterEach(() => {
        if (saved.d === undefined) delete process.env.LATENCY_TEST_LLM_DELAY_MS;
        else process.env.LATENCY_TEST_LLM_DELAY_MS = saved.d;
        if (saved.h === undefined) delete process.env.LATENCY_HANDLER;
        else process.env.LATENCY_HANDLER = saved.h;
    });

    it('delay defaults to 0, reads env, ignores invalid env', async () => {
        delete process.env.LATENCY_TEST_LLM_DELAY_MS;
        expect((await freshMode()).getLlmDelayMs()).toBe(0);
        process.env.LATENCY_TEST_LLM_DELAY_MS = '1500';
        expect((await freshMode()).getLlmDelayMs()).toBe(1500);
        for (const bad of ['abc', '-5', '30000', '1.5']) {
            process.env.LATENCY_TEST_LLM_DELAY_MS = bad;
            expect((await freshMode()).getLlmDelayMs()).toBe(0);
        }
    });
    it('handler is on by default and only off/false/0 turn it off', async () => {
        delete process.env.LATENCY_HANDLER;
        expect((await freshMode()).isHandlerEnabled()).toBe(true);
        for (const v of ['off', 'false', '0', 'OFF']) {
            process.env.LATENCY_HANDLER = v;
            expect((await freshMode()).isHandlerEnabled()).toBe(false);
        }
        for (const v of ['on', 'true', '1', 'whatever', '']) {
            process.env.LATENCY_HANDLER = v;
            expect((await freshMode()).isHandlerEnabled()).toBe(true);
        }
    });
});

describe('/latency/delay and /latency/handler routes', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
        delete process.env.LATENCY_TEST_LLM_DELAY_MS;
        delete process.env.LATENCY_HANDLER;
        vi.resetModules();
        const { createLatencyModeRouter } = await import('../../../src/latency/modeRoute.js');
        const app = express();
        app.use(express.json());
        app.use('/latency', createLatencyModeRouter());
        await new Promise<void>((r) => { server = app.listen(0, () => r()); });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latency`;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    const send = (path: string, method: string, body?: unknown) =>
        fetch(base + path, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    it('GET /delay returns ms', async () => {
        expect(await (await send('/delay', 'GET')).json()).toEqual({ ms: 0 });
    });
    it.each(['PUT', 'POST'])('%s /delay sets a valid ms and GET reflects it', async (method) => {
        const res = await send('/delay', method, { ms: 2500 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ms: 2500, previous: 0 });
        expect(await (await send('/delay', 'GET')).json()).toEqual({ ms: 2500 });
        expect((await (await send('/delay', method, { ms: 20000 })).json()).ms).toBe(20000);
        expect((await (await send('/delay', method, { ms: 0 })).json()).ms).toBe(0);
    });
    it('rejects an invalid ms with 400 and leaves state unchanged', async () => {
        await send('/delay', 'PUT', { ms: 100 });
        for (const body of [{ ms: -1 }, { ms: 20001 }, { ms: 1.5 }, { ms: '100' }, {}]) {
            const res = await send('/delay', 'PUT', body);
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/0 to 20000/);
        }
        expect(await (await send('/delay', 'GET')).json()).toEqual({ ms: 100 });
    });

    it('GET /handler returns enabled (default true)', async () => {
        expect(await (await send('/handler', 'GET')).json()).toEqual({ enabled: true });
    });
    it.each(['PUT', 'POST'])('%s /handler sets a boolean and GET reflects it', async (method) => {
        const res = await send('/handler', method, { enabled: false });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ enabled: false, previous: true });
        expect(await (await send('/handler', 'GET')).json()).toEqual({ enabled: false });
    });
    it('rejects a non-boolean enabled with 400 and leaves state unchanged', async () => {
        for (const body of [{ enabled: 'off' }, { enabled: 0 }, {}]) {
            const res = await send('/handler', 'PUT', body);
            expect(res.status).toBe(400);
            expect((await res.json()).error).toMatch(/boolean/);
        }
        expect(await (await send('/handler', 'GET')).json()).toEqual({ enabled: true });
    });
});

describe('question wait setting and route', () => {
    let server: Server;
    let base: string;
    const saved = process.env.LATENCY_QUESTION_WAIT_MS;
    afterEach(() => {
        if (saved === undefined) delete process.env.LATENCY_QUESTION_WAIT_MS;
        else process.env.LATENCY_QUESTION_WAIT_MS = saved;
    });

    it('defaults to 0, reads env, ignores invalid env', async () => {
        delete process.env.LATENCY_QUESTION_WAIT_MS;
        expect((await freshMode()).getQuestionWaitMs()).toBe(0);
        process.env.LATENCY_QUESTION_WAIT_MS = '1500';
        expect((await freshMode()).getQuestionWaitMs()).toBe(1500);
        for (const bad of ['abc', '-5', '10001', '1.5']) {
            process.env.LATENCY_QUESTION_WAIT_MS = bad;
            expect((await freshMode()).getQuestionWaitMs()).toBe(0);
        }
    });

    describe('routes', () => {
        beforeEach(async () => {
            delete process.env.LATENCY_QUESTION_WAIT_MS;
            vi.resetModules();
            const { createLatencyModeRouter } = await import('../../../src/latency/modeRoute.js');
            const app = express();
            app.use(express.json());
            app.use('/latency', createLatencyModeRouter());
            await new Promise<void>((r) => { server = app.listen(0, () => r()); });
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latency/question-wait`;
        });
        afterEach(() => new Promise<void>((r) => server.close(() => r())));

        const send = (method: string, body?: unknown) =>
            fetch(base, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

        it('GET returns ms (default 0)', async () => {
            expect(await (await send('GET')).json()).toEqual({ ms: 0 });
        });
        it.each(['PUT', 'POST'])('%s sets a valid ms and GET reflects it', async (method) => {
            const res = await send(method, { ms: 2500 });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ms: 2500, previous: 0 });
            expect(await (await send('GET')).json()).toEqual({ ms: 2500 });
            expect((await (await send(method, { ms: 10000 })).json()).ms).toBe(10000);
            expect((await (await send(method, { ms: 0 })).json()).ms).toBe(0);
        });
        it('rejects an invalid ms with 400 and leaves state unchanged', async () => {
            await send('PUT', { ms: 100 });
            for (const body of [{ ms: -1 }, { ms: 10001 }, { ms: 1.5 }, { ms: '100' }, {}]) {
                const res = await send('PUT', body);
                expect(res.status).toBe(400);
                expect((await res.json()).error).toMatch(/0 to 10000/);
            }
            expect(await (await send('GET')).json()).toEqual({ ms: 100 });
        });
    });
});
