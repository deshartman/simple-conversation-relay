/**
 * connectConversationRelay TwiML — uses the real SDK builder (unlike
 * TwilioService.test.ts, which mocks `twilio` wholesale).
 */

import { describe, it, expect } from 'vitest';
import { TwilioService } from '../../../src/services/TwilioService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

function fakeAssets(config: Record<string, unknown>, languages: Record<string, unknown>) {
    return {
        getConversationRelayConfig: () => config,
        getLanguages: () => languages,
    } as any;
}

describe('TwilioService.connectConversationRelay', () => {
    // The real SDK validates the SID shape at construction; no request is made.
    const service = new TwilioService(ServerConfig.forTesting({ twilioAccountSid: 'AC' + '0'.repeat(32) }));

    it("advertises its declared languages and opening ttsLanguage as <Parameter>s", async () => {
        const twiml = await service.connectConversationRelay(
            'example.ngrok.dev',
            fakeAssets(
                { ttsLanguage: 'multi', ttsProvider: 'ElevenLabs', voice: 'v1' },
                { 'en-AU': { voice: 'v1' }, 'fr-FR': { voice: 'v2' } }
            ),
            { callReference: 'ref1' }
        );
        const xml = twiml!.toString();

        expect(xml).toContain('<Parameter name="crLanguages" value="en-AU,fr-FR"/>');
        expect(xml).toContain('<Parameter name="crTtsLanguage" value="multi"/>');
        // Caller-supplied parameters are still emitted alongside.
        expect(xml).toContain('<Parameter name="callReference" value="ref1"/>');
    });

    it('omits the language parameters when none are configured', async () => {
        const twiml = await service.connectConversationRelay('example.ngrok.dev', fakeAssets({ voice: 'v1' }, {}));
        const xml = twiml!.toString();

        expect(xml).not.toContain('crLanguages');
        expect(xml).not.toContain('crTtsLanguage');
    });
});
