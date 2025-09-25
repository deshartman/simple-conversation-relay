import { logOut } from '../utils/logger.js';

/**
 * Interface for the function arguments
 */
interface LiveAgentHandoffFunctionArguments {
    summary: string;
    [key: string]: any;
}

import type { ToolEvent } from '../interfaces/ConversationRelay.js';

/**
 * Interface for the response object - simple response for conversation
 */
interface LiveAgentHandoffResponse {
    success: boolean;
    message: string;
    summary: string;
}

/**
 * Initiates handoff to a live agent and triggers call transfer via WebSocket
 * 
 * @param functionArguments - The arguments for the live agent handoff function
 * @param toolEvent - Tool event for emitting events (provided by ResponseService)
 * @returns Simple response for conversation context
 */
export default function (functionArguments: LiveAgentHandoffFunctionArguments, toolEvent?: ToolEvent): LiveAgentHandoffResponse {
    logOut('LiveAgentHandoff', `LiveAgentHandoff function called with arguments: ${JSON.stringify(functionArguments)}`);

    // If toolEvent is available, emit the handoff event for WebSocket transmission
    if (toolEvent) {
        const handoffData = {
            type: "end",
            handoffData: JSON.stringify({
                reasonCode: "live-agent-handoff",
                reason: functionArguments.summary
            })
        };

        // Emit using "crelay" type so ConversationRelay handles it
        toolEvent.emit('crelay', handoffData);
        toolEvent.log(`Emitted live agent handoff event: ${JSON.stringify(handoffData)}`);
    }

    // Return simple response for conversation context
    const response: LiveAgentHandoffResponse = {
        success: true,
        message: `Live agent handoff initiated`,
        summary: functionArguments.summary
    };

    logOut('LiveAgentHandoff', `Live agent handoff response: ${JSON.stringify(response)}`);
    return response;
}