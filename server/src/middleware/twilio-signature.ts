/**
 * Verify `X-Twilio-Signature` on the endpoints Twilio calls:
 * `/handoff`, `/twilioStatusCallback` and `/connectConversationRelay`.
 *
 * Kept in its own module so it can be unit-tested against a genuine signature
 * built with the SDK's own `getExpectedTwilioSignature`.
 */

import type { RequestHandler } from 'express';
import twilio from 'twilio';
import { logOut } from '../utils/logger.js';

export interface TwilioSignatureOptions {
    /** When false the middleware is a pass-through. */
    validate: boolean;
    authToken: string;
    /** Public host Twilio was configured with, e.g. `example.ngrok.dev`. */
    host: string;
}

/**
 * Behaviour comes from `twilio.webhook()`: `next()` when the signature matches,
 * 403 when it does not, 400 when the header is absent.
 */
export function createTwilioSignatureValidator(opts: TwilioSignatureOptions): RequestHandler {
    if (!opts.validate) {
        logOut(
            'TwilioSignature',
            'Signature validation DISABLED (TWILIO_VALIDATE_WEBHOOKS=false) — Twilio webhooks are unauthenticated'
        );
        return (_req, _res, next) => next();
    }

    if (!opts.authToken) {
        throw new Error(
            'Cannot validate Twilio signatures without an auth token. Set AUTH_TOKEN, or TWILIO_VALIDATE_WEBHOOKS=false to disable validation.'
        );
    }

    logOut('TwilioSignature', `Validating Twilio signatures against https://${opts.host}`);

    // The token MUST be passed positionally.
    //
    // twilio.webhook() ends with:
    //     options.authToken = tokenString ? tokenString : process.env.TWILIO_AUTH_TOKEN;
    //
    // so an `authToken` supplied inside the options object is overwritten and
    // discarded — even though the SDK's own WebhookOptions type declares it as a
    // valid field. This project reads AUTH_TOKEN, not TWILIO_AUTH_TOKEN, so the
    // fallback resolves to undefined and every request is rejected with
    // "Twilio auth token is required for webhook request validation."
    return twilio.webhook(opts.authToken, {
        validate: true,
        // Pin protocol and host rather than inferring from the request: behind a
        // tunnel Express sees http://localhost:<port> while Twilio signed
        // https://<public-host>, so inference fails every time.
        protocol: 'https',
        host: opts.host,
    }) as RequestHandler;
}
