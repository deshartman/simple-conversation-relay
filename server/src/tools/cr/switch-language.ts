import { logOut } from '../../utils/logger.js';
import { defineTool } from '../define-tool.js';
import type { CallAction } from '../../interfaces/ResponseService.js';

interface SwitchLanguageArgs {
    ttsLanguage?: string;
    transcriptionLanguage?: string;
}

interface SwitchLanguageResult {
    success: boolean;
    message: string;
    ttsLanguage?: string;
    transcriptionLanguage?: string;
    action?: CallAction;
    [key: string]: unknown;
}

export const switchLanguageTool = defineTool<SwitchLanguageArgs, SwitchLanguageResult>({
    name: 'switch-language',
    description:
        'Switches the TTS and/or transcription language for the conversation. At least one of ttsLanguage or transcriptionLanguage must be provided.',
    parameters: {
        type: 'object',
        properties: {
            ttsLanguage: {
                type: 'string',
                description: "Language code for text-to-speech (e.g., 'en-GB', 'en-US')",
            },
            transcriptionLanguage: {
                type: 'string',
                description: "Language code for speech-to-text (e.g., 'en-GB', 'en-US')",
            },
        },
        required: [],
        additionalProperties: false,
    },
    handler: args => {
        logOut('SwitchLanguage', `Called with: ${JSON.stringify(args)}`);

        if (!args.ttsLanguage && !args.transcriptionLanguage) {
            // Pre-validation guard: an empty `language` action is not useful
            // and its frame would fail Zod refinement on the outgoing path. Return a
            // loud failure to the LLM instead of shipping nothing.
            return {
                success: false,
                message:
                    'At least one language parameter (ttsLanguage or transcriptionLanguage) must be provided',
            };
        }

        const action: CallAction & { type: 'language' } = { type: 'language' };
        if (args.ttsLanguage) action.ttsLanguage = args.ttsLanguage;
        if (args.transcriptionLanguage) action.transcriptionLanguage = args.transcriptionLanguage;

        const result: SwitchLanguageResult = {
            success: true,
            message: 'Language switched successfully',
            action,
        };
        if (args.ttsLanguage) result.ttsLanguage = args.ttsLanguage;
        if (args.transcriptionLanguage) result.transcriptionLanguage = args.transcriptionLanguage;
        return result;
    },
});
