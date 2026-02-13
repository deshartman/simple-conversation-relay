/**
 * Send SMS function - returns standard responses for conversation context.
 * This is a generic LLM tool that OpenAI processes normally.
 */
import twilio from 'twilio';
import { ServerConfig } from '../config/ServerConfig.js';
import { logOut, logError } from '../utils/logger.js';

/**
 * Interface for the function arguments
 */
interface SendSMSArgs {
    to: string;
    message: string;
    [key: string]: any;
}

/**
 * Interface for the response object - simplified
 */
interface SendSMSResponse {
    success: boolean;
    message: string;
    recipient?: string;
}

/**
 * Factory function that creates send-sms tool with config
 * Tool creates its own Twilio client (self-contained, doesn't depend on TwilioService)
 *
 * Sends an SMS message using the Twilio API
 * This tool is self-contained and creates its own Twilio client for execution
 *
 * @param config - Server configuration with Twilio credentials
 * @returns Tool function with proper signature
 */
export function createSendSMSTool(config: ServerConfig) {
    // Return tool function with captured config
    // Accepts optional responseService for consistency with other tools
    return async (args: SendSMSArgs, _responseService?: any): Promise<SendSMSResponse> => {
        const log = (msg: string) => logOut('SendSMS', msg);
        const logError_ = (msg: string) => logError('SendSMS', msg);

        log(`Send SMS function called with arguments: ${JSON.stringify(args)}`);

        try {
            // Use config from closure (not process.env)
            const client = twilio(config.twilioAccountSid, config.twilioAuthToken);

            // Send SMS via Twilio API
            const result = await client.messages.create({
                body: args.message,
                from: config.twilioFromNumber,
                to: args.to
            });

            const response: SendSMSResponse = {
                success: true,
                message: `SMS sent successfully`,
                recipient: args.to
            };

            log(`SMS sent successfully: SID=${result.sid}`);
            return response;

        } catch (error) {
            const errorMessage = `SMS send failed: ${error instanceof Error ? error.message : String(error)}`;
            logError_(errorMessage);

            return {
                success: false,
                message: errorMessage
            };
        }
    };
}