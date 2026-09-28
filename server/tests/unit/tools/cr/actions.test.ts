/**
 * CR tools only ask for a call action; the transport builds the frame.
 */
import { describe, it, expect } from 'vitest';
import { endCallTool } from '../../../../src/tools/cr/end-call.js';
import { liveAgentHandoffTool } from '../../../../src/tools/cr/live-agent-handoff.js';
import { sendDtmfTool } from '../../../../src/tools/cr/send-dtmf.js';
import { playMediaTool } from '../../../../src/tools/cr/play-media.js';
import { switchLanguageTool } from '../../../../src/tools/cr/switch-language.js';
import { setListenModeTool } from '../../../../src/tools/cr/set-listen-mode.js';
import { setSilenceDetectionTool } from '../../../../src/tools/cr/set-silence-detection.js';

const ctx = { changeContext: async () => {} };

describe('CR tools return actions, not frames', () => {
    it('maps each tool to its action', async () => {
        const results = await Promise.all([
            endCallTool.handler({ conversationSummary: 's' }, ctx),
            liveAgentHandoffTool.handler({ summary: 's' }, ctx),
            sendDtmfTool.handler({ dtmfDigit: '6' }, ctx),
            playMediaTool.handler({ source: 'https://x/a.mp3', loop: 2 }, ctx),
            switchLanguageTool.handler({ ttsLanguage: 'fr-FR' }, ctx),
            setListenModeTool.handler({ enabled: true }, ctx),
            setSilenceDetectionTool.handler({ enabled: false }, ctx),
        ]);

        expect(results.map(r => r.action)).toEqual([
            {
                type: 'endCall',
                handoffData: JSON.stringify({ reasonCode: 'end-call', reason: 'Ending the call', conversationSummary: 's' }),
            },
            { type: 'endCall', handoffData: JSON.stringify({ reasonCode: 'live-agent-handoff', reason: 's' }) },
            { type: 'sendDigits', digits: '6' },
            { type: 'play', source: 'https://x/a.mp3', loop: 2 },
            { type: 'language', ttsLanguage: 'fr-FR' },
            { type: 'listenMode', enabled: true },
            { type: 'silence', enabled: false },
        ]);
        for (const r of results) expect(r).not.toHaveProperty('outgoingMessage');
    });

    it('requests no action when switch-language has no language', async () => {
        const r = await switchLanguageTool.handler({}, ctx);
        expect(r.success).toBe(false);
        expect(r.action).toBeUndefined();
    });
});
