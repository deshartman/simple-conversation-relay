import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';
import type { EndFrame } from '../types/crelay.js';

interface LiveAgentHandoffArgs {
    summary: string;
}

interface LiveAgentHandoffResult {
    success: boolean;
    message: string;
    summary: string;
    outgoingMessage: EndFrame;
    [key: string]: unknown;
}

export const liveAgentHandoffTool = defineTool<LiveAgentHandoffArgs, LiveAgentHandoffResult>({
    name: 'live-agent-handoff',
    description: 'Transfers the call to a human agent',
    parameters: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A summary of the call',
            },
        },
        required: ['summary'],
    },
    handler: args => {
        logOut('LiveAgentHandoff', `Called with: ${JSON.stringify(args)}`);

        return {
            success: true,
            message: 'Live agent handoff initiated',
            summary: args.summary,
            outgoingMessage: {
                type: 'end',
                handoffData: JSON.stringify({
                    reasonCode: 'live-agent-handoff',
                    reason: args.summary,
                }),
            },
        };
    },
});
