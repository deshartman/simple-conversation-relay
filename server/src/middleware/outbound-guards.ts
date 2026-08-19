/**
 * Guards for `POST /outboundCall`.
 *
 * Twilio signature validation cannot protect this route: Twilio never calls it,
 * so there is no `X-Twilio-Signature` to verify. It is our own API, reachable
 * from the internet only because the whole app is tunnelled for Twilio's sake —
 * and it places calls billed to the account. The exposure is toll fraud, not
 * data leakage, so the guards are an authenticator plus a damage cap.
 *
 * Kept out of `server.ts` so each guard can be unit-tested directly.
 */

import type { RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { logOut, logError } from '../utils/logger.js';

/**
 * Canonical E.164: `+`, a non-zero leading digit, then up to 14 more digits.
 * Deliberately permissive about country — Twilio rejects genuinely bad numbers.
 */
const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Bearer-token authentication.
 *
 * Fails **closed**: with no key configured the route reports 503 rather than
 * running unauthenticated, so a forgotten secret cannot silently reopen a
 * billable endpoint. That is the failure mode this guard exists to prevent.
 */
export function createOutboundAuth(apiKey: string | undefined): RequestHandler {
    return (req, res, next) => {
        if (!apiKey) {
            logError(
                'OutboundGuard',
                'Refusing /outboundCall: OUTBOUND_API_KEY is not configured'
            );
            res.status(503).json({
                success: false,
                error: 'Outbound calling is not configured',
            });
            return;
        }

        const header = req.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

        // Compare SHA-256 digests rather than raw strings: digests are always
        // equal length (timingSafeEqual throws otherwise) and the comparison
        // stays constant-time, so neither the token nor its length leaks.
        const presentedDigest = createHash('sha256').update(presented).digest();
        const expectedDigest = createHash('sha256').update(apiKey).digest();

        if (!presented || !timingSafeEqual(presentedDigest, expectedDigest)) {
            logError(
                'OutboundGuard',
                `Rejected /outboundCall: ${presented ? 'invalid' : 'missing'} bearer token (ip=${req.ip})`
            );
            res.status(401).json({ success: false, error: 'Unauthorized' });
            return;
        }

        next();
    };
}

/**
 * Reject a missing or malformed destination with 400 rather than letting it
 * become an opaque 500 from the Twilio API.
 */
export function createDestinationValidator(): RequestHandler {
    return (req, res, next) => {
        const phoneNumber = req.body?.properties?.phoneNumber;

        if (typeof phoneNumber !== 'string' || phoneNumber.length === 0) {
            res.status(400).json({
                success: false,
                error: 'properties.phoneNumber is required',
            });
            return;
        }

        if (!E164.test(phoneNumber)) {
            logError('OutboundGuard', `Rejected /outboundCall: '${phoneNumber}' is not E.164`);
            res.status(400).json({
                success: false,
                error: `phoneNumber must be E.164, e.g. +61400000000 (got '${phoneNumber}')`,
            });
            return;
        }

        next();
    };
}

/**
 * Cap calls per rolling minute.
 *
 * Intentionally a **global** counter, not per-IP: the resource being protected
 * is Twilio spend, which is shared, and a per-IP limit is trivially bypassed by
 * rotating source addresses. With no destination allowlist configured this is
 * the only thing standing between a leaked token and an unbounded bill.
 *
 * In-memory, so the effective limit multiplies by the number of instances —
 * fine for a single process, worth revisiting if this is ever scaled out.
 */
export function createRateLimiter(maxPerMinute: number): RequestHandler {
    const hits: number[] = [];

    return (_req, res, next) => {
        const now = Date.now();
        const windowStart = now - 60_000;

        while (hits.length > 0 && hits[0]! <= windowStart) {
            hits.shift();
        }

        if (hits.length >= maxPerMinute) {
            logError(
                'OutboundGuard',
                `Rate limited /outboundCall: ${hits.length}/${maxPerMinute} calls in the last minute`
            );
            res.status(429).json({
                success: false,
                error: `Rate limit exceeded: at most ${maxPerMinute} calls per minute`,
            });
            return;
        }

        hits.push(now);
        logOut('OutboundGuard', `Outbound call allowed (${hits.length}/${maxPerMinute} this minute)`);
        next();
    };
}
