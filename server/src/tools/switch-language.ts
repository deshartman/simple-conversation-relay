import { logOut } from '../utils/logger.js';
import { defineTool } from './define-tool.js';
import type { LanguageFrame } from '../types/crelay.js';

interface SwitchLanguageArgs {
    ttsLanguage?: string;
    transcriptionLanguage?: string;
}

interface SwitchLanguageResult {
    success: boolean;
    message: string;
    ttsLanguage?: string;
    transcriptionLanguage?: string;
    outgoingMessage?: LanguageFrame;
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
            // Pre-validation guard: an empty `language` frame is not useful
            // and would fail Zod refinement on the outgoing path. Return a
            // loud failure to the LLM instead of shipping nothing.
            return {
                success: false,
                message:
                    'At least one language parameter (ttsLanguage or transcriptionLanguage) must be provided',
            };
        }

        const frame: LanguageFrame = { type: 'language' };
        if (args.ttsLanguage) frame.ttsLanguage = args.ttsLanguage;
        if (args.transcriptionLanguage) frame.transcriptionLanguage = args.transcriptionLanguage;

        const result: SwitchLanguageResult = {
            success: true,
            message: 'Language switched successfully',
            outgoingMessage: frame,
        };
        if (args.ttsLanguage) result.ttsLanguage = args.ttsLanguage;
        if (args.transcriptionLanguage) result.transcriptionLanguage = args.transcriptionLanguage;
        return result;
    },
});
