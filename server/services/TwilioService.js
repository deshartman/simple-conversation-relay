const twilio = require('twilio');
const EventEmitter = require('events');
const { logOut, logError } = require('../utils/logger');

/**
 * Service class for handling Twilio-related operations including making calls, sending SMS and generating TwiML for the Conversation Relay service.
 * 
 * @class
 * @property {string} accountSid - Twilio account SID from environment variables
 * @property {string} authToken - Twilio authentication token from environment variables
 * @property {string} fromNumber - Twilio phone number to use as the sender
 * @property {twilio.Twilio} twilioClient - Initialized Twilio client instance
 */
class TwilioService extends EventEmitter {
    constructor() {
        super();
        this.accountSid = process.env.ACCOUNT_SID;
        this.authToken = process.env.AUTH_TOKEN;
        this.fromNumber = process.env.FROM_NUMBER;
        this.twilioClient = twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);
    }

    /**
     * Makes an outbound call and connects it to the Conversation Relay service.
     * The call is automatically recorded and uses TwiML generated by connectConversationRelay.
     * 
     * @param {string} toNumber - The destination phone number in E.164 format
     * @param {string} customerReference - Unique reference ID for the customer
     * @param {string} serverBaseUrl - Base URL for the Conversation Relay WebSocket server (without wss:// prefix)
     * @returns {Promise<string>} The Twilio call SID if successful
     * @throws {Error} If the call cannot be initiated or other Twilio API errors occur
     */
    async makeOutboundCall(serverBaseUrl, toNumber, customerReference = "") {
        try {
            const conversationRelay = this.connectConversationRelay(serverBaseUrl, customerReference);

            const call = await this.twilioClient.calls.create({
                to: toNumber,
                from: this.fromNumber,
                twiml: conversationRelay,
                // record: true,
            });

            logOut('TwilioService', `Made a call from: ${this.fromNumber} to: ${toNumber}`);
            return call;

        } catch (error) {
            logError('TwilioService', `Make Outbound call error: ${error}`);
            throw error;
        }
    }

    /**
     * Sends an SMS message using the configured Twilio number.
     * 
     * @param {string} to - The destination phone number in E.164 format
     * @param {string} message - The message content to send
     * @returns {Promise<string|null>} The Twilio message SID if successful, null if sending fails
     */
    async sendSMS(to, message) {
        try {
            logOut('TwilioService', `Sending SMS to: ${to} with message: ${message}`);

            const response = await this.twilioClient.messages.create({
                body: message,
                from: this.fromNumber,
                to: to
            });
            return response.sid;
        } catch (error) {
            logError('TwilioService', `Error sending SMS: ${error}`);
            return null;
        }
    }

    /**
     * Generates TwiML to connect a call to the Conversation Relay service.
     * Configures the connection with Deepgram transcription, text-to-speech settings,
     * and DTMF detection. Can be used for both inbound and outbound calls.
     * 
     * @param {string} customerReference - Unique reference ID for the customer
     * @param {string} serverBaseUrl - Base URL for the Conversation Relay WebSocket server (without wss:// prefix)
     * @returns {twilio.twiml.VoiceResponse|null} The TwiML response object if successful, null if generation fails
     */
    connectConversationRelay(serverBaseUrl, customerReference = "") {
        try {
            logOut('TwilioService', `Generating TwiML for call with CustomerReference: ${customerReference}`);

            // Generate the Twiml we will need once the call is connected. Note, this could be done in two steps via the server, were we set a url: instead of twiml:, but this just seemed overly complicated.
            const response = new twilio.twiml.VoiceResponse();
            const connect = response.connect();
            const conversationRelay = connect.conversationRelay({
                url: `wss://${serverBaseUrl}/conversation-relay`,
                welcomeGreeting: "Hi! How can I help you today?",
                transcriptionProvider: "deepgram",
                interruptible: "true",
                // voice: "en-AU-Journey-D",
                ttsProvider: "Elevenlabs",
                // voice: "Jessica-flash_v2_5",
                voice: "Charlie-flash_v2_5",
                dtmfDetection: "true",
                interruptByDtmf: "true",
                debug: "true"
            });

            // Which Context to use for this call (or the default)
            conversationRelay.parameter(
                {
                    name: 'contextFile',
                    value: process.env.LLM_CONTEXT || 'defaultContext.md'
                });

            // Which Manifest to use for this call (or the default)
            conversationRelay.parameter(
                {
                    name: 'toolManifestFile',
                    value: process.env.LLM_MANIFEST || 'defaultToolManifest.json'
                });


            conversationRelay.parameter(
                {
                    name: 'customerReference',
                    value: customerReference
                });

            // logOut('TwilioService', `Generated TwiML using Helper for call: ${response.toString()}`);

            return response;

        } catch (error) {
            logError('TwilioService', `Error generating call TwiML: ${error}`);
            return null;
        }
    }

    /**
     * Evaluate the status callback received. This will be used in the LLM to determine the next steps.
     * If there is nothing to be done, just null the response.
     * 
     */
    async evaluateStatusCallback(statusCallback) {
        logOut('TwilioService', `Evaluating status callback: ${JSON.stringify(statusCallback)}`);
        // Do something and then emit the event type
        const callSid = statusCallback.CallSid;
        logOut('TwilioService', `Returning evaluated status callback for callSid: ${callSid}`);
        return statusCallback;
    }
}

module.exports = { TwilioService };
