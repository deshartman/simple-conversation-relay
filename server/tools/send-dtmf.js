const { logOut, logError } = require('../utils/logger');

module.exports = function (functionArguments) {
    logOut('SendDTMF', `Send dtmf function called with arguments: ${JSON.stringify(functionArguments)}`);
    const response = {
        type: "sendDigits",
        digits: functionArguments.dtmfDigit
    };
    logOut('LLM', `Send DTMF response: ${JSON.stringify(response, null, 4)}`);
    return response;
}
