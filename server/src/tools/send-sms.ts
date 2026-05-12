/**
 * send-sms tool — factory that captures Twilio credentials from ServerConfig.
 *
 * Phase 1 IoC pattern (v4.11): dependencies are injected at registration
 * time rather than read from process.env inside the handler. The v4.12
 * port keeps this pattern — the factory now returns a `defineTool` record
 * instead of a raw handler function.
 */

import twilio from 'twilio';
import type { ServerConfig } from '../config/ServerConfig.js';
import { logOut, logError } from '../utils/logger.js';
import { defineTool, type ConversationRelayTool } from './define-tool.js';

interface SendSMSArgs {
    to: string;
    message: string;
}

interface SendSMSResult {
    success: boolean;
    message: string;
    recipient?: string;
    [key: string]: unknown;
}

export function createSendSMSTool(
    config: ServerConfig
): ConversationRelayTool<SendSMSArgs, SendSMSResult> {
    return defineTool<SendSMSArgs, SendSMSResult>({
        name: 'send-sms',
        description: 'This sends an SMS message to the number provided',
        parameters: {
            type: 'object',
            properties: {
                to: {
                    type: 'string',
                    description:
                        'The number to send the SMS to. This HAS to be in +1234567890 format',
                },
                message: {
                    type: 'string',
                    description: 'The message to be sent',
                },
            },
            required: ['to', 'message'],
        },
        handler: async args => {
            logOut('SendSMS', `Called with: ${JSON.stringify(args)}`);

            try {
                const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

                const result = await client.messages.create({
                    body: args.message,
                    from: config.twilioFromNumber,
                    to: args.to,
                });

                logOut('SendSMS', `SMS sent successfully: SID=${result.sid}`);
                return {
                    success: true,
                    message: 'SMS sent successfully',
                    recipient: args.to,
                };
            } catch (error) {
                const errorMessage = `SMS send failed: ${
                    error instanceof Error ? error.message : String(error)
                }`;
                logError('SendSMS', errorMessage);
                return { success: false, message: errorMessage };
            }
        },
    });
}
