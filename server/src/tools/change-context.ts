/**
 * change-context tool — swaps the LLM's system prompt mid-call.
 *
 * Factory captures a `CachedAssetsService` reference for looking up cached
 * context content. The handler uses the session parameter to update the
 * live conversation — `session.insertMessage` adds a handoff summary to
 * conversation history, `session.updateContext` replaces the system
 * instructions.
 *
 * Tool registry is unchanged by context switches (all-tools-all-legs in
 * v4.12). If per-leg tool scoping is ever needed again, it belongs here.
 */

import { logOut, logError } from '../utils/logger.js';
import type { CachedAssetsService } from '../services/CachedAssetsService.js';
import { defineTool, type ConversationRelayTool } from './define-tool.js';

interface ChangeContextArgs {
    newContext: string;
    handoffSummary: string;
}

interface ChangeContextResult {
    success: boolean;
    message: string;
    newContext: string;
    handoffSummary: string;
    [key: string]: unknown;
}

export function createChangeContextTool(
    cache: CachedAssetsService
): ConversationRelayTool<ChangeContextArgs, ChangeContextResult> {
    return defineTool<ChangeContextArgs, ChangeContextResult>({
        name: 'change-context',
        description:
            'Changes the conversation context to a different prompt template while preserving conversation continuity through a handoff summary. Use this when the conversation needs to switch to a different specialized context (e.g., from intent detection to account balance, from account balance to payment processing).',
        parameters: {
            type: 'object',
            properties: {
                newContext: {
                    type: 'string',
                    description:
                        'The name of the new context to switch to. Available contexts: intent, account_balance, classification, concession, confirm_concession, make_payment, payment_reversal, pre_auth, account_selector',
                    enum: [
                        'intent',
                        'account_balance',
                        'classification',
                        'concession',
                        'confirm_concession',
                        'make_payment',
                        'payment_reversal',
                        'pre_auth',
                        'account_selector',
                    ],
                },
                handoffSummary: {
                    type: 'string',
                    description:
                        "A brief summary of the conversation so far and what the customer needs. This will be prepended to the new context to maintain conversation continuity. Include relevant details like customer intent, account information discovered, and next steps needed.",
                },
            },
            required: ['newContext', 'handoffSummary'],
            additionalProperties: false,
        },
        handler: async (args, session) => {
            logOut('ChangeContext', `Called with: ${JSON.stringify(args)}`);

            if (!args.newContext) {
                return {
                    success: false,
                    message: 'newContext parameter is required',
                    newContext: '',
                    handoffSummary: '',
                };
            }
            if (!args.handoffSummary) {
                return {
                    success: false,
                    message: 'handoffSummary parameter is required',
                    newContext: args.newContext,
                    handoffSummary: '',
                };
            }

            try {
                const assets = cache.getAssetsForContextSwitch(args.newContext);
                if (!assets) {
                    throw new Error(`Context '${args.newContext}' not found in cache`);
                }

                await session.insertMessage('system', `Context handoff summary: ${args.handoffSummary}`);
                await session.updateContext(assets.context);
                // Registry is not per-leg in v4.12 — all tools stay available.

                logOut('ChangeContext', `Switched to context: ${args.newContext}`);

                return {
                    success: true,
                    message: `Successfully switched to context: ${args.newContext}`,
                    newContext: args.newContext,
                    handoffSummary: args.handoffSummary,
                };
            } catch (error) {
                const errorMessage = `Context switch failed: ${
                    error instanceof Error ? error.message : String(error)
                }`;
                logError('ChangeContext', errorMessage);
                return {
                    success: false,
                    message: errorMessage,
                    newContext: args.newContext,
                    handoffSummary: args.handoffSummary,
                };
            }
        },
    });
}
