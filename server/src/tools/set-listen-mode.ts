import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';

interface SetListenModeArgs {
    enabled: boolean;
}

interface SetListenModeResult {
    success: boolean;
    message: string;
    listenMode: boolean;
    [key: string]: unknown;
}

export const setListenModeTool = defineTool<SetListenModeArgs, SetListenModeResult>({
    name: 'set-listen-mode',
    description:
        'Enables or disables listen mode. When enabled, the agent listens but suppresses outgoing text/play/language frames (DTMF and end still ship). When disabled, normal outbound behavior resumes.',
    parameters: {
        type: 'object',
        properties: {
            enabled: {
                type: 'boolean',
                description: 'Set to true to enable listen-only mode, false to resume normal mode',
            },
        },
        required: ['enabled'],
        additionalProperties: false,
    },
    handler: args => {
        logOut('SetListenMode', `Called with: ${JSON.stringify(args)}`);

        if (typeof args.enabled !== 'boolean') {
            return {
                success: false,
                message: 'enabled parameter is required and must be boolean',
                listenMode: false,
            };
        }

        const modeDescription = args.enabled
            ? 'listen-only mode (text responses suppressed)'
            : 'normal mode (text responses enabled)';

        return {
            success: true,
            message: `Listen mode set to ${args.enabled ? 'enabled' : 'disabled'}. ${modeDescription}`,
            listenMode: args.enabled,
        };
    },
});
