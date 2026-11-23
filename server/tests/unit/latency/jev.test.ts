import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('node:https', () => ({ Agent: class {}, request: (...a: unknown[]) => requestMock(...a) }));
vi.mock('../../../src/utils/logger.js', () => ({ logOut: vi.fn(), logError: vi.fn() }));

import { warmJev } from '../../../src/latency/jev.js';
import { logOut, logError } from '../../../src/utils/logger.js';

describe('warmJev', () => {
    beforeEach(() => { requestMock.mockReset(); vi.mocked(logOut).mockClear(); vi.mocked(logError).mockClear(); });

    it('logs jev warm ms on a response', async () => {
        requestMock.mockImplementation((_o: unknown, cb: (r: any) => void) => {
            const res = { statusCode: 404, resume() {}, on(ev: string, f: () => void) { if (ev === 'end') setTimeout(f, 0); } };
            return { setTimeout() {}, on() {}, end() { cb(res); } };
        });
        await warmJev();
        expect(vi.mocked(logOut).mock.calls.some(c => /jev warm ms=\d+/.test(String(c[1])))).toBe(true);
        expect(requestMock.mock.calls[0][0].method).toBe('HEAD');
    });

    it('swallows a connection error', async () => {
        requestMock.mockImplementation(() => {
            const h: Record<string, (e: Error) => void> = {};
            return { setTimeout() {}, on(ev: string, f: (e: Error) => void) { h[ev] = f; }, end() { h.error(new Error('ECONNRESET')); } };
        });
        await expect(warmJev()).resolves.toBeUndefined();
        expect(vi.mocked(logError)).toHaveBeenCalled();
    });

    it('swallows a synchronous throw', async () => {
        requestMock.mockImplementation(() => { throw new Error('boom'); });
        await expect(warmJev()).resolves.toBeUndefined();
        expect(vi.mocked(logError)).toHaveBeenCalled();
    });
});
