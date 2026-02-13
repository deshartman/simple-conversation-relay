import { logOut, logError } from '../utils/logger.js';
import type { OpenAIResponseService } from '../services/OpenAIResponseService.js';
import type { CachedAssetsService } from '../services/CachedAssetsService.js';

/**
 * Interface for the function arguments
 */
interface ChangeContextArgs {
    newContext: string;
    handoffSummary: string;
}

/**
 * Interface for the response object - simple response for conversation
 */
interface ChangeContextResponse {
    success: boolean;
    message: string;
    newContext: string;
    handoffSummary: string;
}

/**
 * Factory function that creates change-context tool with captured dependencies
 * Follows Twilio Agent Connect tool factory pattern
 *
 * Changes the conversation context by switching to a different prompt template.
 * This function performs the complete context switching workflow:
 * 1. Validates new context exists in cache
 * 2. Retrieves new context content from cache
 * 3. Updates OpenAI service with new context + handoff summary
 *
 * @param cachedAssetsService - Service for accessing cached contexts
 * @returns Tool function with proper signature
 */
export function createChangeContextTool(
    cachedAssetsService: CachedAssetsService
) {
    // Return tool function with proper signature
    return async (
        args: ChangeContextArgs,
        responseService: OpenAIResponseService
    ): Promise<ChangeContextResponse> => {
        logOut('ChangeContext', `Change context function called with arguments: ${JSON.stringify(args)}`);

        // Validate required parameters
        if (!args.newContext) {
            return {
                success: false,
                message: 'newContext parameter is required',
                newContext: '',
                handoffSummary: ''
            };
        }

        if (!args.handoffSummary) {
            return {
                success: false,
                message: 'handoffSummary parameter is required',
                newContext: args.newContext,
                handoffSummary: ''
            };
        }

        try {
            logOut('ChangeContext', `Context switch requested: ${args.newContext}`);
            logOut('ChangeContext', `Handoff summary: ${args.handoffSummary}`);

            // Use cachedAssetsService from closure
            const contextSwitchAssets = cachedAssetsService.getAssetsForContextSwitch(args.newContext);
            if (!contextSwitchAssets) {
                throw new Error(`Context '${args.newContext}' not found in cache`);
            }

            // Use responseService from parameter
            await responseService.insertMessage('system', `Context handoff summary: ${args.handoffSummary}`);
            await responseService.updateContext(contextSwitchAssets.context);
            await responseService.updateTools(contextSwitchAssets.manifest);

            logOut('ChangeContext', `Successfully switched to context: ${args.newContext}`);

            return {
                success: true,
                message: `Successfully switched to context: ${args.newContext}`,
                newContext: args.newContext,
                handoffSummary: args.handoffSummary
            };

        } catch (error) {
            const errorMessage = `Context switch failed: ${error instanceof Error ? error.message : String(error)}`;
            logError('ChangeContext', errorMessage);
            return {
                success: false,
                message: errorMessage,
                newContext: args.newContext,
                handoffSummary: args.handoffSummary
            };
        }
    };
}