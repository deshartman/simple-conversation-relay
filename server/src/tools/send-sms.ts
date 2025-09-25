/**
 * Send SMS function - simplified to return standard responses without tool types
 * This tool doesn't need to emit events since it's a standard operation that just
 * returns results for the conversation context.
 */
import { logOut, logError } from '../utils/logger.js';
import { TwilioService } from '../services/TwilioService.js';

/**
 * Interface for the function arguments
 */
interface SendSMSFunctionArguments {
    to: string;
    message: string;
    [key: string]: any;
}

import type { ToolEvent } from '../interfaces/ConversationRelay.js';

/**
 * Interface for the response object - simplified
 */
interface SendSMSResponse {
    success: boolean;
    message: string;
    recipient?: string;
}

/**
 * Sends an SMS message using the Twilio service
 * Now returns a simple response that gets inserted into conversation context
 * 
 * @param functionArguments - The arguments for the send SMS function
 * @param toolEvent - Tool event for logging (provided by ResponseService)
 * @returns A simple response object for conversation context
 */
export default async function (functionArguments: SendSMSFunctionArguments, toolEvent?: ToolEvent): Promise<SendSMSResponse> {
    const log = toolEvent?.log || ((msg: string) => logOut('SendSMS', msg));
    const logError_ = toolEvent?.logError || ((msg: string) => logError('SendSMS', msg));

    log(`Send SMS function called with arguments: ${JSON.stringify(functionArguments)}`);

    const twilioService = new TwilioService();

    try {
        // Send the SMS
        const result = await twilioService.sendSMS(functionArguments.to, functionArguments.message);

        if (!result) {
            logError_(`Failed to send SMS to ${functionArguments.to}`);
            return {
                success: false,
                message: `Failed to send SMS to ${functionArguments.to}`
            };
        }

        const response: SendSMSResponse = {
            success: true,
            message: `SMS sent successfully`,
            recipient: functionArguments.to
        };

        log(`SMS sent successfully: ${JSON.stringify(response)}`);
        return response;

    } catch (error) {
        const errorMessage = `SMS send failed: ${error instanceof Error ? error.message : String(error)}`;
        logError_(errorMessage);

        return {
            success: false,
            message: errorMessage
        };
    }
}