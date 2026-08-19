/**
 * TwilioService — outbound status callbacks
 *
 * Without statusCallback on calls.create() there is no visibility into an
 * outbound call that rings out, is busy, or fails: the only signal would be a
 * WebSocket that never opens. The /twilioStatusCallback route existed but
 * nothing ever pointed at it.
 *
 * Keeps the real twilio.twiml builder and stubs only the REST client.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TwilioService } from '../../../src/services/TwilioService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

vi.mock('twilio', async () => {
    const actual = await vi.importActual<any>('twilio');
    const factory: any = vi.fn(() => ({
        calls: { create: vi.fn(async (opts: any) => ({ sid: 'CA-test-sid', ...opts })) },
        messages: { create: vi.fn() },
    }));
    factory.twiml = actual.default.twiml;
    return { default: factory };
});

const cachedAssets = {
    getConversationRelayConfig: () => ({ welcomeGreeting: 'hi', language: 'en-AU' }),
    getLanguages: () => ({}),
} as any;

describe('TwilioService — outbound status callbacks', () => {
    let service: TwilioService;

    beforeEach(() => {
        service = new TwilioService(ServerConfig.forTesting({ twilioFromNumber: '+61400000000' }));
    });

    it('registers a status callback pointing at /twilioStatusCallback', async () => {
        const create = (service as any).twilioClient.calls.create;

        await service.makeOutboundCall('example.test', '+61411111111', cachedAssets);

        expect(create.mock.calls[0][0].statusCallback).toBe(
            'https://example.test/twilioStatusCallback'
        );
        expect(create.mock.calls[0][0].statusCallbackMethod).toBe('POST');
    });

    it('subscribes to the events needed to see an unanswered call', async () => {
        const create = (service as any).twilioClient.calls.create;

        await service.makeOutboundCall('example.test', '+61411111111', cachedAssets);

        const events = create.mock.calls[0][0].statusCallbackEvent;
        expect(events).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    });
});
