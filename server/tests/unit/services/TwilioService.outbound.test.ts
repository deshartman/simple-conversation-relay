/**
 * TwilioService — outbound call TwiML
 *
 * Covers the outbound start-state contract:
 *
 *   Outbound calls begin in listen mode so the LLM can work out whether it
 *   reached a human, an IVR tree or voicemail before speaking. `welcomeGreeting`
 *   is spoken by Twilio TTS *before* our WebSocket receives anything, so listen
 *   mode cannot suppress it — it must be absent from the TwiML entirely, or
 *   Twilio talks over the IVR menu we are trying to hear.
 *
 * This file keeps the real `twilio.twiml` builder (so the generated XML is
 * asserted for real) and stubs only the REST client. It is separate from
 * TwilioService.test.ts, which mocks the module wholesale for constructor tests.
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
    // Keep the genuine TwiML builder — the XML is the thing under test.
    factory.twiml = actual.default.twiml;
    return { default: factory };
});

const GREETING = 'Hello there! How can I assist you with Conversation Relay today?';

function makeCachedAssets() {
    // Mirrors the real service, which hands back the CACHED object by
    // reference — mutating it would corrupt config for every later call.
    const conversationRelayConfig: Record<string, any> = {
        welcomeGreeting: GREETING,
        welcomeGreetingInterruptible: 'any',
        language: 'en-AU',
        ttsProvider: 'ElevenLabs',
        voice: 'IKne3meq5aSn9XLyUdCD',
    };
    return {
        conversationRelayConfig,
        service: {
            getConversationRelayConfig: () => conversationRelayConfig,
            getLanguages: () => ({}),
        } as any,
    };
}

describe('TwilioService — outbound TwiML', () => {
    let service: TwilioService;
    let assets: ReturnType<typeof makeCachedAssets>;

    beforeEach(() => {
        service = new TwilioService(ServerConfig.forTesting({ twilioFromNumber: '+61400000000' }));
        assets = makeCachedAssets();
    });

    describe('welcomeGreeting suppression', () => {
        it('omits welcomeGreeting when listen mode is requested', async () => {
            const twiml = await service.connectConversationRelay('example.test', assets.service, {
                listenMode: 'true',
            });

            const xml = twiml!.toString();
            expect(xml).not.toContain('welcomeGreeting');
            expect(xml).not.toContain(GREETING);
        });

        it('keeps welcomeGreeting when listen mode is not requested', async () => {
            const twiml = await service.connectConversationRelay('example.test', assets.service, {});

            expect(twiml!.toString()).toContain(GREETING);
        });

        it('keeps welcomeGreeting when listen mode is explicitly false', async () => {
            const twiml = await service.connectConversationRelay('example.test', assets.service, {
                listenMode: 'false',
            });

            expect(twiml!.toString()).toContain(GREETING);
        });

        /**
         * Regression guard: getConversationRelayConfig() returns the cached
         * object by reference. Blanking the greeting in place would silently
         * strip it from every later call — including inbound ones, which must
         * still greet the caller.
         */
        it('does not mutate the cached config when suppressing the greeting', async () => {
            await service.connectConversationRelay('example.test', assets.service, {
                listenMode: 'true',
            });

            expect(assets.conversationRelayConfig.welcomeGreeting).toBe(GREETING);
            expect(assets.conversationRelayConfig.welcomeGreetingInterruptible).toBe('any');
        });

        it('still greets a later inbound call after an outbound one suppressed it', async () => {
            await service.connectConversationRelay('example.test', assets.service, {
                listenMode: 'true',
            });
            const inbound = await service.connectConversationRelay(
                'example.test',
                assets.service,
                {}
            );

            expect(inbound!.toString()).toContain(GREETING);
        });
    });

    describe('makeOutboundCall', () => {
        it('starts outbound calls in listen mode by default', async () => {
            const create = (service as any).twilioClient.calls.create;

            await service.makeOutboundCall('example.test', '+61411111111', assets.service);

            expect(create).toHaveBeenCalledTimes(1);
            const twiml = create.mock.calls[0][0].twiml.toString();
            // The parameter rides along so the session starts in the matching
            // state — one input driving both TwiML and setup.
            expect(twiml).toContain('name="listenMode"');
            expect(twiml).toContain('value="true"');
            expect(twiml).not.toContain('welcomeGreeting');
        });

        it('lets an explicit listenMode parameter override the default', async () => {
            const create = (service as any).twilioClient.calls.create;

            await service.makeOutboundCall('example.test', '+61411111111', assets.service, {
                listenMode: 'false',
            });

            const twiml = create.mock.calls[0][0].twiml.toString();
            expect(twiml).toContain(GREETING);
            expect(twiml).toContain('value="false"');
        });

        it('dials the requested number from the configured number', async () => {
            const create = (service as any).twilioClient.calls.create;

            await service.makeOutboundCall('example.test', '+61411111111', assets.service);

            expect(create.mock.calls[0][0]).toMatchObject({
                to: '+61411111111',
                from: '+61400000000',
            });
        });

        it('passes caller parameters through as CR parameters', async () => {
            const create = (service as any).twilioClient.calls.create;

            await service.makeOutboundCall('example.test', '+61411111111', assets.service, {
                callReference: 'ref-123',
            });

            const twiml = create.mock.calls[0][0].twiml.toString();
            expect(twiml).toContain('name="callReference"');
            expect(twiml).toContain('value="ref-123"');
        });
    });
});
