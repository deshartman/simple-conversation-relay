import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';
import type { SendDigitsFrame } from '../types/crelay.js';

interface SendDTMFArgs {
    dtmfDigit: string;
}

interface SendDTMFResult {
    success: boolean;
    message: string;
    digits: string;
    outgoingMessage: SendDigitsFrame;
    [key: string]: unknown;
}

export const sendDtmfTool = defineTool<SendDTMFArgs, SendDTMFResult>({
    name: 'send-dtmf',
    description: 'This sends DTMF tones to the call',
    parameters: {
        type: 'object',
        properties: {
            dtmfDigit: {
                type: 'string',
                description: 'The DTMF digit value to send',
            },
        },
        required: ['dtmfDigit'],
    },
    handler: args => {
        logOut('SendDTMF', `Called with: ${JSON.stringify(args)}`);

        return {
            success: true,
            message: 'DTMF digits sent successfully',
            digits: args.dtmfDigit,
            outgoingMessage: {
                type: 'sendDigits',
                digits: args.dtmfDigit,
            },
        };
    },
});
