/**
 * Main server file that sets up Express with WebSocket support and defines API endpoints.
 * @module server
 * @requires dotenv
 * @requires express
 * @requires express-ws
 */

import dotenv from 'dotenv';
import express from 'express';
import expressWs, { Application as ExpressWSApplication } from 'express-ws';
import { logOut, logError } from './utils/logger.js';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import path from 'path';

// Import the services
import { ConversationRelayService } from './services/ConversationRelayService.js'
import { OpenAIResponseService } from './services/OpenAIResponseService.js';
import { TwilioService } from './services/TwilioService.js';
import { CachedAssetsService } from './services/CachedAssetsService.js';
import { ServerConfig } from './config/ServerConfig.js';
import type { IncomingMessage, OutgoingMessage, SessionData } from './interfaces/ConversationRelay.js';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define interface for WebSocket session
interface WSSession {
    conversationRelaySession: ConversationRelayService;
    sessionData: SessionData;
}

// Define interface for request data
interface RequestData {
    callSid?: string;
    contextKey?: string;
    manifestKey?: string;
    properties?: {
        phoneNumber: string;
        callReference: string;
        firstname?: string;
        lastname?: string;
        [key: string]: any;
    };
}

/**
 * Loads environment variables from the appropriate .env file based on NODE_ENV
 */
function loadEnvironmentConfig(): void {
    const nodeEnv = process.env.NODE_ENV;
    const serverRoot = path.resolve(__dirname, '..');

    let envPath: string;
    let envName: string;

    // Determine which .env file to load based on NODE_ENV
    if (nodeEnv === 'dev') {
        envPath = path.join(serverRoot, '.env.dev');
        envName = '.env.dev';
    } else if (nodeEnv === 'prod') {
        envPath = path.join(serverRoot, '.env.prod');
        envName = '.env.prod';
    } else {
        envPath = path.join(serverRoot, '.env');
        envName = '.env';
    }

    // Check if the file exists
    if (existsSync(envPath)) {
        const result = dotenv.config({ path: envPath });

        if (result.error) {
            logError('Server', `Failed to load environment file ${envName}: ${result.error.message}`);
            throw result.error;
        }

        logOut('Server', `Environment loaded from: ${envName} (NODE_ENV: ${nodeEnv || 'not set'})`);
    } else {
        logError('Server', `Environment file not found: ${envPath}`);
        throw new Error(`Environment file not found: ${envName}`);
    }
}

/**
 * Validates that required environment variables are present
 */
function validateRequiredEnvVars(): void {
    const required = [
        'PORT',
        'SERVER_BASE_URL',
        'OPENAI_API_KEY',
        'ACCOUNT_SID',
        'AUTH_TOKEN',
        'FROM_NUMBER'
    ];

    const missing = required.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        const errorMsg = `Missing required environment variables: ${missing.join(', ')}`;
        logError('Server', errorMsg);
        throw new Error(errorMsg);
    }

    logOut('Server', 'All required environment variables validated');
}

// Note: Environment loading and validation now handled by ServerConfig.fromEnv() in startup
// The loadEnvironmentConfig() and validateRequiredEnvVars() functions are kept for reference
// but are no longer called at module load time

const app = express() as unknown as ExpressWSApplication;

// Initialize express-ws (adds app.ws() method and modifies app.listen())
const wsInstance = expressWs(app);

app.use(express.urlencoded({ extended: true }));    // For Twilio url encoded body
app.use(express.json());    // For JSON payloads


/**
 * This parameterDataMap illustrates how you would pass data via Conversation Relay Parameters.
 * The intention is to store and get data via this map per WS session
 * TODO: Can this be per WS session?
 */
let wsSessionsMap = new Map<string, WSSession>();
let parameterDataMap = new Map<string, { requestData: any }>();
let conversationSessionMap = new Map<string, OpenAIResponseService>();
let twilioService: TwilioService;
let cachedAssetsService: CachedAssetsService | null = null;
let serverConfig: ServerConfig;

/**
 * Initialize all required services before starting the server.
 * This ensures services are ready before accepting any connections.
 */
async function initializeServices(): Promise<void> {
    try {
        // Initialize CachedAssetsService first (self-contained, no dependencies)
        cachedAssetsService = new CachedAssetsService(serverConfig);
        await cachedAssetsService.initialize();
        logOut('Server', 'CachedAssetsService initialized successfully');

        // Initialize TwilioService (no dependencies)
        twilioService = new TwilioService(serverConfig);
        await twilioService.initialize();
        logOut('Server', 'TwilioService initialized successfully');

        logOut('Server', 'All services initialized with configuration');
    } catch (error) {
        logError('Server', `Failed to initialize services: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

/****************************************************
 *
 * Web Socket Endpoints
 *
 ****************************************************/

/**
 * WebSocket endpoint for real-time conversation relay.
 * Handles the lifecycle of a conversation session including setup, message processing, and cleanup.
 * 
 * @name ws/conversation-relay
 * @function
 * @param {WebSocket} ws - The WebSocket connection object
 * 
 * @listens message
 * Expects JSON messages with the following structure:
 * - First message must be a setup message containing initial configuration
 * - Subsequent messages should follow the conversation relay protocol
 * 
 * @listens close
 * Handles client disconnection by cleaning up resources
 * 
 * @listens error
 * Handles WebSocket errors and performs cleanup
 * 
 * @emits message
 * Sends JSON messages back to the client with conversation updates and responses
 */
app.ws('/conversation-relay', (ws: any, req: express.Request) => {

    let conversationRelaySession: ConversationRelayService | null = null;
    let sessionData: SessionData = {
        parameterData: {},
        setupData: {
            callSid: ''
        }
    };

    // Handle incoming messages for this WS session.
    ws.on('message', async (data: string) => {
        try {
            const message: IncomingMessage = JSON.parse(data);

            // If the conversationRelaySession does not exist, initialise it else handle the incoming message
            if (!conversationRelaySession) {
                logOut('WS', `Session Conversation Relay being initialised`);
                // Since this is the first message from CR, it will be a setup message, so add the Conversation Relay "setup" message data to the session.
                logOut('WS', `Adding setup CR setup message data to sessionData. Message type: ${message.type} and callReference: ${message.customParameters?.callReference}`);

                sessionData.setupData = message as any;

                // This extracts the parameter data from the parameterDataMap and add it to the sessionData
                if (message.customParameters?.callReference) {
                    sessionData.parameterData = parameterDataMap.get(message.customParameters.callReference) || { requestData: {} };
                }

                // Ensure CachedAssetsService is available
                if (!cachedAssetsService) {
                    throw new Error('CachedAssetsService not initialized');
                }

                // Log any custom parameters for debugging
                if (message.customParameters?.contextKey || message.customParameters?.manifestKey) {
                    logOut('WS', `Custom parameters provided: contextKey=${message.customParameters.contextKey}, manifestKey=${message.customParameters.manifestKey}`);
                    logOut('WS', `Note: Custom context/manifest selection will be available in future versions`);
                }

                logOut('WS', `Creating OpenAIResponseService and ConversationRelayService`);

                // Get pre-loaded assets from CachedAssetsService
                const activeAssets = cachedAssetsService.getActiveAssets();

                // Create OpenAI ResponseService with pre-loaded assets
                const responseService = new OpenAIResponseService(
                    activeAssets.context,
                    activeAssets.manifest,
                    activeAssets.loadedTools,
                    activeAssets.listenMode.enabled,
                    serverConfig
                );

                // Create ConversationRelayService - it will handle ResponseService setup internally
                conversationRelaySession = new ConversationRelayService(
                    responseService,
                    sessionData,
                    activeAssets.silenceDetection
                );

                // Set up unified conversation relay handler
                conversationRelaySession.createConversationRelayHandler({
                    outgoingMessage: (outgoingMessage: OutgoingMessage) => {
                        //logOut('WS', `Sending outgoing message to WebSocket: ${JSON.stringify(outgoingMessage)}`);
                        ws.send(JSON.stringify(outgoingMessage));
                    },
                    callSid: (callSid: string, responseMessage: any) => {
                        logOut('WS', `Got a call SID event for the conversation relay: ${JSON.stringify(responseMessage)}`);
                        // Handle the message as needed
                    }
                });

                // Add the session to the wsSessionsMap, so it can be referenced using a particular call SID.
                if (message.callSid) {
                    wsSessionsMap.set(message.callSid,
                        {
                            conversationRelaySession,
                            sessionData
                        }
                    );
                }
            }

            if (conversationRelaySession) {
                conversationRelaySession.incomingMessage(message);
            }

        } catch (error) {
            logError('WS', `Error in websocket message handling: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

    // Handle client disconnection
    ws.on('close', () => {
        logOut('WS', 'Client ws disconnected');
        // Clean up ConversationRelay and its listeners
        if (conversationRelaySession) {
            conversationRelaySession.cleanup();
        }
    });

    // Handle errors
    ws.on('error', (error: Error) => {
        logError('WS', `WebSocket error: ${error instanceof Error ? error.message : String(error)}`);
        // Clean up ConversationRelay and its listeners
        if (conversationRelaySession) {
            conversationRelaySession.cleanup();
        }
    });
});

/****************************************************
 * 
 * Web Server Endpoints
 * 
 ****************************************************/

/**
 * Basic health check endpoint to verify server status.
 * 
 * @name GET /
 * @function
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {string} Simple text response indicating server is running
 */
app.get('/', (req: express.Request, res: express.Response) => {
    res.send('WebSocket Server Running');
});

/**
 * Initiates an outbound call and connects it to the Conversation Relay via the Twilio Service service. The intention is to provide any amount of data in this request, but
 * that only the reference will be used to connect to the Conversation Relay. Once the reference is connected via Conversation Relay, it can be used to look up the full data set
 * stored here again. This illustrates how to pass parameters via the Conversation Relay Parameter field.
 * 
 * Call this endpoint with some sample data.
 * 
 * ``` terminal
 * curl  -X POST \
 *  'https://crelay-des.ngrok.dev/outboundCall' \
 *  --header 'Content-Type: application/json' \
 *  --data-raw '{
 *      "properties": {
 *          "phoneNumber": "+1234567890",
 *          "callReference": "abc123",
 *          "firstname": "Bob",
 *          "lastname": "Jones"
 *      }
 *   }'
 * ```
 * This data will be stored in a local Map and can be retrieved via the callReference.
 * 
 * @endpoint POST /outboundCall
 * 
 * @param {Object} req.body.properties - API request data properties
 * @param {string} req.body.properties.phoneNumber - [REQUIRED] Call's outbound phone number to call
 * @param {string} req.body.properties.callReference - [OPTIONAL] Unique reference to pass along with the call
 * 
 * @returns {Object} response
 * @returns {string} [response.error] - Error message if the call failed
 * 
 */
app.post('/outboundCall', async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;

    try {
        logOut('Server', `/outboundCall: Initiating outbound call`);

        if (!requestData.properties?.phoneNumber) {
            throw new Error('Phone number is required');
        }

        // Extract phoneNumber, pass rest as parameters
        const { phoneNumber, ...parameters } = requestData.properties;

        // Store in parameterDataMap if callReference provided
        if (parameters.callReference) {
            parameterDataMap.set(parameters.callReference, { requestData: requestData.properties });
        }

        const response = await twilioService.makeOutboundCall(
            serverConfig.serverBaseUrl,
            phoneNumber,
            cachedAssetsService!,
            parameters
        );

        logOut('Server', `/outboundCall: Call initiated with call SID: ${response}`);

        res.json({ success: true, response: response });
    } catch (error) {
        logError('Server', `Error initiating outbound call: ${error instanceof Error ? error.message : String(error)}`);
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
});

/**
 * Initiates a connection to the Conversation Relay service.
 *
 * @name POST /connectConversationRelay
 * @function
 * @async
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @returns {string} TwiML response for establishing the connection
 */
app.post('/connectConversationRelay', async (req: express.Request, res: express.Response) => {
    logOut('Server', `Received request to connect to Conversation Relay`);

    // Accept optional parameters from request body
    const parameters = req.body.parameters || {};

    const voiceResponse = await twilioService.connectConversationRelay(serverConfig.serverBaseUrl, cachedAssetsService!, parameters);
    if (voiceResponse) {
        res.send(voiceResponse.toString());
    } else {
        res.status(500).send('Failed to generate voice response to connect Conversation Relay');
    }
});

/**
 * Endpoint to receive Twilio status callbacks and pass them to the Response Service if needed. The Twilio Service will decide what to do with the status callback.
 */
app.post('/twilioStatusCallback', async (req: express.Request, res: express.Response) => {
    const statusCallBack = req.body;
    // Extract the call SID from the statusCallBack and insert the content into the sessionMap overwriting the existing content.
    const callSid = statusCallBack.callSid;
    logOut('Server', `Received a Twilio status call back for call SID: ${callSid}: ${JSON.stringify(statusCallBack)}`);

    // Get the session objects from the wsSessionsMap
    let wsSession = wsSessionsMap.get(callSid);

    if (wsSession) {
        let conversationRelaySession = wsSession.conversationRelaySession;

        // Let the Twilio Service decide what to give back to the Response Service.
        const evaluatedStatusCallback = await twilioService.evaluateStatusCallback(statusCallBack);

        // Now Send the message to the Session Response Service directly if needed. NOTE: It is assumed that Twilio Service will manipulate the content based on it's understanding of the message and if no action is required, null it.
        if (evaluatedStatusCallback) {
            await conversationRelaySession.insertMessage('system', JSON.stringify(evaluatedStatusCallback));
        }
    }

    res.json({ success: true });
});

/**
 * Endpoint for direct conversation with OpenAI without Conversation Relay.
 * Supports multi-turn conversations through session management.
 *
 * @name POST /conversation
 * @function
 * @async
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 *
 * Request body:
 * @param {string} [req.body.sessionId] - Optional session ID for continuing conversation
 * @param {string} req.body.message - Message to send to OpenAI
 * @param {string} [req.body.role='user'] - Message role ('user' or 'system')
 *
 * @returns {Object} response
 * @returns {boolean} response.success - Whether the request succeeded
 * @returns {string} response.sessionId - Session ID for conversation continuity
 * @returns {string} response.response - OpenAI's response text
 * @returns {string} [response.error] - Error message if request failed
 */
app.post('/conversation', async (req: express.Request, res: express.Response) => {
    try {
        const { sessionId, message, role = 'user' } = req.body;

        if (!message) {
            res.status(400).json({ success: false, error: 'Message is required' });
            return;
        }

        if (!cachedAssetsService) {
            res.status(500).json({ success: false, error: 'CachedAssetsService not initialized' });
            return;
        }

        let responseService: OpenAIResponseService;
        let currentSessionId: string;

        // Check if session exists
        if (sessionId && conversationSessionMap.has(sessionId)) {
            // Use existing session
            currentSessionId = sessionId;
            responseService = conversationSessionMap.get(sessionId)!;
            logOut('Server', `/conversation: Using existing session ${currentSessionId}`);
        } else {
            // Create new session
            currentSessionId = crypto.randomUUID();

            const activeAssets = cachedAssetsService.getActiveAssets();

            responseService = new OpenAIResponseService(
                activeAssets.context,
                activeAssets.manifest,
                activeAssets.loadedTools,
                activeAssets.listenMode.enabled,
                serverConfig
            );

            conversationSessionMap.set(currentSessionId, responseService);
            logOut('Server', `/conversation: Created new session ${currentSessionId}`);
        }

        // Accumulate response content
        let accumulatedResponse = '';

        // Set up response handler to collect content
        responseService.createResponseHandler({
            content: (contentResponse) => {
                if (contentResponse.type === 'text' && contentResponse.token) {
                    accumulatedResponse += contentResponse.token;
                }
            },
            toolResult: (toolResultEvent) => {
                logOut('Server', `/conversation: Tool executed: ${toolResultEvent.toolType}`);
            },
            error: (error) => {
                logError('Server', `/conversation: Error in response generation: ${error.message}`);
            },
            callSid: (callSid: string, responseMessage: any) => {
                // Not used in this endpoint, but required by interface
            }
        });

        // Generate response
        await responseService.generateResponse(role, message);

        res.json({
            success: true,
            sessionId: currentSessionId,
            response: accumulatedResponse
        });

    } catch (error) {
        logError('Server', `/conversation: Error processing request: ${error instanceof Error ? error.message : String(error)}`);
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
});

app.post('/updateResponseService', async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;
    logOut('Server', `Received request to update Response Service with data: ${JSON.stringify(requestData)}`);

    try {
        if (!cachedAssetsService) {
            res.status(500).json({ success: false, error: 'CachedAssetsService not initialized' });
            return;
        }

        const callSid = requestData.callSid;
        const contextKey = requestData.contextKey;
        const manifestKey = requestData.manifestKey;

        if (callSid && (contextKey || manifestKey)) {
            logOut('Server', `Updating context and/or manifest for call SID: ${callSid} to keys: ${contextKey} and ${manifestKey}`);

            // Get the session objects from the wsSessionsMap
            const wsSession = wsSessionsMap.get(callSid);

            if (wsSession) {
                const conversationRelaySession = wsSession.conversationRelaySession;

                // Get content from CachedAssetsService
                let context: string;
                let toolManifest: object;

                if (contextKey) {
                    const cachedContext = cachedAssetsService.getContext(contextKey);
                    if (!cachedContext) {
                        res.status(400).json({ success: false, error: `Context not found for key: ${contextKey}` });
                        return;
                    }
                    context = cachedContext;
                } else {
                    context = cachedAssetsService.getActiveAssets().context;
                }

                if (manifestKey) {
                    const cachedManifest = cachedAssetsService.getManifest(manifestKey);
                    if (!cachedManifest) {
                        res.status(400).json({ success: false, error: `Tool manifest not found for key: ${manifestKey}` });
                        return;
                    }
                    toolManifest = cachedManifest;
                } else {
                    toolManifest = cachedAssetsService.getActiveAssets().manifest;
                }

                // Update the context and manifest content for the sessionResponseService
                await conversationRelaySession.updateContext(context);
                await conversationRelaySession.updateTools(toolManifest);
            } else {
                res.status(404).json({ success: false, error: `Session not found for call SID: ${callSid}` });
                return;
            }
        } else {
            res.status(400).json({ success: false, error: 'callSid and at least one of contextKey or manifestKey are required' });
            return;
        }

        res.json({ success: true });
    } catch (error) {
        logError('Server', `Error updating response service: ${error instanceof Error ? error.message : String(error)}`);
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
});

/****************************************************
 *
 * Web Server
 *
 ****************************************************/

/**
 * Server port binding with automatic retry on next port if in use.
 * If the port is in use, incrementally tries the next port number.
 *
 * @function startServer
 * @param {number} port - The port number to attempt binding to
 * @throws {Error} If server fails to start for reasons other than port in use
 */
const startServer = (port: number): void => {
    let currentPort = port;

    // Get the WebSocketServer instance and attach error handler for port retry
    const wss = wsInstance.getWss();
    wss.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
            currentPort++;
            logOut('Server', `Port ${currentPort - 1} is in use, trying ${currentPort}`);
            server.listen(currentPort);
        } else {
            logError('Server', `WebSocket server error: ${error.message}`);
            throw error;
        }
    });

    // HTTP server error handler for non-EADDRINUSE errors only
    const server = app.listen(currentPort)
        .on('error', (error: NodeJS.ErrnoException) => {
            // Only handle errors that are NOT EADDRINUSE (those are handled by wss)
            if (error.code !== 'EADDRINUSE') {
                logError('Server', `HTTP server error: ${error.message}`);
                throw error;
            }
        })
        .on('listening', () => {
            logOut('Server', `Server started on port ${currentPort}`);
        });
};

(async () => {
    try {
        // Load and validate configuration first
        serverConfig = ServerConfig.fromEnv();
        logOut('Server', `Configuration loaded for ${serverConfig.nodeEnv} environment`);

        // Initialize services with configuration
        await initializeServices();

        // Start the server with configured port
        startServer(serverConfig.port);
    } catch (error) {
        logError('Server', `Fatal error during startup: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
})();
