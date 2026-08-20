/**
 * X-Twilio-Signature validation.
 *
 * Signatures here are built with the SDK's own getExpectedTwilioSignature, so
 * these tests exercise the real crypto path rather than a stub. That matters:
 * the first version of this middleware passed the auth token inside the options
 * object, which twilio.webhook() silently discards, so every Twilio webhook was
 * rejected in production while unit tests said nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio';
import { createTwilioSignatureValidator } from '../../../src/middleware/twilio-signature.js';

const TOKEN = 'test-auth-token-0123456789';
const HOST = 'example.ngrok.dev';

/**
 * A request that deliberately reports the WRONG protocol and host — http and
 * localhost, as Express sees it behind a tunnel — while carrying a signature
 * computed for https://<public-host>. It can only validate if the middleware
 * pins protocol/host instead of inferring them from the request.
 */
function fakeReq(path: string, body: Record<string, string>, signature?: string) {
    return {
        originalUrl: path,
        protocol: 'http',
        headers: { host: 'localhost:3007' },
        body,
        header: (name: string) =>
            name.toLowerCase() === 'x-twilio-signature' ? signature : undefined,
    } as any;
}

function fakeRes() {
    const res: any = { statusCode: undefined, body: undefined };
    res.type = () => res;
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.send = (body: any) => {
        res.body = body;
        return res;
    };
    res.json = (body: any) => {
        res.body = body;
        return res;
    };
    return res;
}

function sign(path: string, body: Record<string, string>) {
    return getExpectedTwilioSignature(TOKEN, `https://${HOST}${path}`, body);
}

const validator = () =>
    createTwilioSignatureValidator({ validate: true, authToken: TOKEN, host: HOST });

describe('createTwilioSignatureValidator', () => {
    it('accepts a genuinely signed request', () => {
        const body = { CallSid: 'CA123', CallStatus: 'completed' };
        const next = vi.fn();
        const res = fakeRes();

        validator()(fakeReq('/twilioStatusCallback', body, sign('/twilioStatusCallback', body)), res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeUndefined();
    });

    it('accepts a signed /handoff payload', () => {
        const body = { HandoffData: '{"reasonCode":"end-call"}' };
        const next = vi.fn();

        validator()(fakeReq('/handoff', body, sign('/handoff', body)), fakeRes(), next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('rejects a forged signature with 403', () => {
        const body = { CallSid: 'CA123' };
        const next = vi.fn();
        const res = fakeRes();

        validator()(fakeReq('/handoff', body, 'not-a-real-signature'), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
    });

    it('rejects a signature valid for a different body', () => {
        const next = vi.fn();
        const res = fakeRes();
        // Signed for one payload, presented with another — replay of a stale body.
        const stale = sign('/handoff', { CallSid: 'CA-original' });

        validator()(fakeReq('/handoff', { CallSid: 'CA-tampered' }, stale), res, next);

        expect(res.statusCode).toBe(403);
    });

    it('rejects a signature valid for a different path', () => {
        const body = { CallSid: 'CA123' };
        const next = vi.fn();
        const res = fakeRes();

        validator()(fakeReq('/handoff', body, sign('/twilioStatusCallback', body)), res, next);

        expect(res.statusCode).toBe(403);
    });

    it('rejects a missing signature header with 400', () => {
        const next = vi.fn();
        const res = fakeRes();

        validator()(fakeReq('/handoff', { CallSid: 'CA123' }), res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
    });

    it('passes everything through when validation is disabled', () => {
        const next = vi.fn();
        const res = fakeRes();
        const off = createTwilioSignatureValidator({
            validate: false,
            authToken: TOKEN,
            host: HOST,
        });

        off(fakeReq('/handoff', { CallSid: 'CA123' }), res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeUndefined();
    });

    it('refuses to construct with validation on but no auth token', () => {
        // Better to fail at startup than to reject every Twilio webhook at
        // runtime with an unexplained 500, which is what the SDK does.
        expect(() =>
            createTwilioSignatureValidator({ validate: true, authToken: '', host: HOST })
        ).toThrow(/auth token/i);
    });
});
