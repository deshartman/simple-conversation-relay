import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';
import type { EndFrame } from '../types/crelay.js';

interface EndCallArgs {
    conversationSummary: string;
}

interface EndCallResult {
    success: boolean;
    message: string;
    summary: string;
    outgoingMessage: EndFrame;
    [key: string]: unknown;
}

export const endCallTool = defineTool<EndCallArgs, EndCallResult>({
    name: 'end-call',
    description: 'end this call now',
    parameters: {
        type: 'object',
        properties: {
            conversationSummary: {
                type: 'string',
                description: 'A summary of the call',
            },
        },
        required: ['conversationSummary'],
    },
    handler: args => {
        logOut('EndCall', `End call function called with arguments: ${JSON.stringify(args)}`);

        return {
            success: true,
            message: 'Call ended successfully',
            summary: args.conversationSummary,
            outgoingMessage: {
                type: 'end',
                handoffData: JSON.stringify({
                    reasonCode: 'end-call',
                    reason: 'Ending the call',
                    conversationSummary: args.conversationSummary,
                }),
            },
        };
    },
});
