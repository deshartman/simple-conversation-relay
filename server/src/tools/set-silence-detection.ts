import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';

interface SetSilenceDetectionArgs {
    enabled: boolean;
}

interface SetSilenceDetectionResult {
    success: boolean;
    message: string;
    silenceEnabled: boolean;
    [key: string]: unknown;
}

export const setSilenceDetectionTool = defineTool<
    SetSilenceDetectionArgs,
    SetSilenceDetectionResult
>({
    name: 'set-silence-detection',
    description:
        'Enables or disables silence detection monitoring during the call. When enabled, the system monitors for periods of silence and sends reminder messages. When disabled, no silence monitoring occurs. Use this to temporarily disable silence detection during activities where the caller may not speak for extended periods (e.g., entering payment information, looking up documents).',
    parameters: {
        type: 'object',
        properties: {
            enabled: {
                type: 'boolean',
                description: 'Set to true to enable silence detection, false to disable it',
            },
        },
        required: ['enabled'],
        additionalProperties: false,
    },
    handler: args => {
        logOut('SetSilenceDetection', `Called with: ${JSON.stringify(args)}`);

        if (typeof args.enabled !== 'boolean') {
            return {
                success: false,
                message: 'enabled parameter is required and must be boolean',
                silenceEnabled: false,
            };
        }

        const modeDescription = args.enabled
            ? 'enabled (will monitor for silence and send reminders)'
            : 'disabled (no silence monitoring)';

        return {
            success: true,
            message: `Silence detection ${modeDescription}`,
            silenceEnabled: args.enabled,
        };
    },
});
