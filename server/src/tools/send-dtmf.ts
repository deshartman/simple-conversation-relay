import { logOut } from '../utils/logger.js';

/**
 * Interface for the function arguments
 */
interface SendDTMFFunctionArguments {
    dtmfDigit: string;
    [key: string]: any;
}

import type { ToolEvent } from '../interfaces/ConversationRelay.js';

/**
 * Interface for the response object - simple response for conversation
 */
interface SendDTMFResponse {
    success: boolean;
    message: string;
    digits: string;
}

/**
 * Sends DTMF digits via WebSocket and returns conversation context
 * 
 * @param functionArguments - The arguments for the send DTMF function
 * @param toolEvent - Tool event for emitting events (provided by ResponseService)
 * @returns Simple response for conversation context
 */
export default function (functionArguments: SendDTMFFunctionArguments, toolEvent?: ToolEvent): SendDTMFResponse {
    logOut('SendDTMF', `Send dtmf function called with arguments: ${JSON.stringify(functionArguments)}`);

    // If toolEvent is available, emit the DTMF event for WebSocket transmission
    if (toolEvent) {
        const dtmfData = {
            type: "sendDigits",
            digits: functionArguments.dtmfDigit
        };

        // Emit using "crelay" type so ConversationRelay handles it
        toolEvent.emit('crelay', dtmfData);
        toolEvent.log(`Emitted DTMF event: ${JSON.stringify(dtmfData)}`);
    }

    // Return simple response for conversation context
    const response: SendDTMFResponse = {
        success: true,
        message: `DTMF digits sent successfully`,
        digits: functionArguments.dtmfDigit
    };

    logOut('SendDTMF', `Send DTMF response: ${JSON.stringify(response)}`);
    return response;
}