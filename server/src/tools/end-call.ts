import { logOut } from '../utils/logger.js';

/**
 * Interface for the function arguments
 */
interface EndCallFunctionArguments {
    summary: string;
    [key: string]: any;
}

import type { ToolEvent } from '../interfaces/ConversationRelay.js';

/**
 * Interface for the response object - simple response for conversation
 */
interface EndCallResponse {
    success: boolean;
    message: string;
    summary: string;
}

/**
 * Ends the call with a summary and triggers call termination via WebSocket
 * 
 * @param functionArguments - The arguments for the end call function
 * @param toolEvent - Tool event for emitting events (provided by ResponseService)
 * @returns Simple response for conversation context
 */
export default function (functionArguments: EndCallFunctionArguments, toolEvent?: ToolEvent): EndCallResponse {
    logOut('EndCall', `End call function called with arguments: ${JSON.stringify(functionArguments)}`);

    // If toolEvent is available, emit the end call event for WebSocket transmission
    if (toolEvent) {
        const endCallData = {
            type: "end",
            handoffData: JSON.stringify({
                reasonCode: "end-call",
                reason: "Ending the call",
                conversationSummary: functionArguments.summary,
            })
        };

        // Emit using "crelay" type so ConversationRelay handles it
        toolEvent.emit('crelay', endCallData);
        toolEvent.log(`Emitted end call event: ${JSON.stringify(endCallData)}`);
    }

    // Return simple response for conversation context
    const response: EndCallResponse = {
        success: true,
        message: `Call ended successfully`,
        summary: functionArguments.summary
    };

    logOut('EndCall', `End call response: ${JSON.stringify(response)}`);
    return response;
}