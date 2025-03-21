const { logOut, logError } = require('../utils/logger');

/**
 * This is a CR specific tool type. It CR specific messages sent back via the Websocket.
 * 
 * @param {*} functionArguments 
 * @returns 
 */
module.exports = function (functionArguments) {
    logOut('LiveAgentHandoff', `LiveAgentHandoff function called with arguments: ${JSON.stringify(functionArguments)}`);
    const response = {
        toolType: "crelay",
        toolData: {
            type: "end",
            handoffData: JSON.stringify({   // TODO: Why does this have to be stringified?
                reasonCode: "live-agent-handoff",
                reason: functionArguments.summary
            })
        }
    };
    logOut('LiveAgentHandoff', `Transfer to agent response: ${JSON.stringify(response, null, 4)}`);
    return response;
}
