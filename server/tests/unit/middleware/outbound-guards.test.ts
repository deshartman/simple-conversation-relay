/**
 * Guards for POST /outboundCall.
 *
 * The endpoint places calls billed to the Twilio account and is reachable from
 * the internet, so the exposure is toll fraud. Twilio signature validation
 * cannot help — Twilio never calls this route.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    createOutboundAuth,
    createDestinationValidator,
    createRateLimiter,
} from '../../../src/middleware/outbound-guards.js';

const KEY = 'sk-test-outbound-key';

function fakeReq(opts: { auth?: string; phoneNumber?: unknown } = {}) {
    return {
        get: (name: string) =>
            name.toLowerCase() === 'authorization' ? opts.auth : undefined,
        ip: '203.0.113.7',
        body: { properties: { phoneNumber: opts.phoneNumber } },
    } as any;
}

function fakeRes() {
    const res: any = { statusCode: undefined, body: undefined };
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body: any) => {
        res.body = body;
        return res;
    };
    return res;
}

describe('createOutboundAuth', () => {
    it('accepts a correct bearer token', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth(KEY)(fakeReq({ auth: `Bearer ${KEY}` }), res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeUndefined();
    });

    it('rejects a wrong token with 401', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth(KEY)(fakeReq({ auth: 'Bearer wrong-key' }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('rejects a missing Authorization header with 401', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth(KEY)(fakeReq(), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
    });

    it('rejects a token supplied without the Bearer scheme', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth(KEY)(fakeReq({ auth: KEY }), res, next);

        expect(res.statusCode).toBe(401);
    });

    /**
     * The failure mode this guard exists to prevent: an unset secret must not
     * leave a billable endpoint running unauthenticated.
     */
    it('fails CLOSED with 503 when no key is configured', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth(undefined)(fakeReq({ auth: 'Bearer anything' }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });

    it('does not accept an empty token against an empty key', () => {
        const next = vi.fn();
        const res = fakeRes();

        createOutboundAuth('')(fakeReq({ auth: 'Bearer ' }), res, next);

        // An empty configured key counts as unconfigured, not as a valid match.
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
    });
});

describe('createDestinationValidator', () => {
    const cases: Array<[string, unknown, boolean]> = [
        ['a valid AU mobile', '+61401277115', true],
        ['a valid US number', '+14155551234', true],
        ['no plus prefix', '61401277115', false],
        ['a leading zero after +', '+0401277115', false],
        ['letters', '+61abc', false],
        ['too long for E.164', '+1234567890123456', false],
        ['an empty string', '', false],
        ['a missing value', undefined, false],
        ['a non-string', 61401277115, false],
    ];

    for (const [label, phoneNumber, shouldPass] of cases) {
        it(`${shouldPass ? 'accepts' : 'rejects'} ${label}`, () => {
            const next = vi.fn();
            const res = fakeRes();

            createDestinationValidator()(fakeReq({ phoneNumber }), res, next);

            if (shouldPass) {
                expect(next).toHaveBeenCalledOnce();
                expect(res.statusCode).toBeUndefined();
            } else {
                expect(next).not.toHaveBeenCalled();
                expect(res.statusCode).toBe(400);
            }
        });
    }
});

describe('createRateLimiter', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('allows calls up to the limit and rejects the next with 429', () => {
        const limiter = createRateLimiter(3);

        for (let i = 0; i < 3; i += 1) {
            const next = vi.fn();
            limiter(fakeReq(), fakeRes(), next);
            expect(next).toHaveBeenCalledOnce();
        }

        const next = vi.fn();
        const res = fakeRes();
        limiter(fakeReq(), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
    });

    it('frees capacity once the calls age out of the rolling minute', () => {
        const limiter = createRateLimiter(2);
        limiter(fakeReq(), fakeRes(), vi.fn());
        limiter(fakeReq(), fakeRes(), vi.fn());

        const blocked = fakeRes();
        limiter(fakeReq(), blocked, vi.fn());
        expect(blocked.statusCode).toBe(429);

        vi.advanceTimersByTime(60_001);

        const allowed = vi.fn();
        const res = fakeRes();
        limiter(fakeReq(), res, allowed);
        expect(allowed).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeUndefined();
    });

    it('counts globally rather than per client address', () => {
        // Twilio spend is shared, and a per-IP limit is bypassed by rotating
        // source addresses — so two different IPs must share one quota.
        const limiter = createRateLimiter(1);

        limiter({ ...fakeReq(), ip: '198.51.100.1' }, fakeRes(), vi.fn());

        const next = vi.fn();
        const res = fakeRes();
        limiter({ ...fakeReq(), ip: '198.51.100.2' }, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(429);
    });
});
