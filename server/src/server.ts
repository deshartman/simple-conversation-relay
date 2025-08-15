/**
 * Main server file that sets up Express with WebSocket support and defines API endpoints.
 * @module server
 * @requires dotenv
 * @requires express
 * @requires express-ws
 */

import dotenv from "dotenv";
import express from "express";
import expressWs, { Application as ExpressWSApplication } from "express-ws";
import { logOut, logError } from "./utils/logger.js";

// Import the services
import { ConversationRelayService } from "./services/ConversationRelayService.js";
import { OpenAIService } from "./services/OpenAIService.js";
import { DeepSeekService } from "./services/DeepSeekService.js";
import { TwilioService } from "./services/TwilioService.js";

// Define interfaces for session data
interface SessionData {
  parameterData: Record<string, any>;
  setupData: {
    callSid: string;
    customParameters?: {
      callReference?: string;
      contextFile?: string;
      toolManifestFile?: string;
    };
    [key: string]: any;
  };
}

// Define interface for incoming message
interface IncomingMessage {
  type: "setup" | "prompt" | "dtmf" | "interrupt" | "info" | "error";
  callSid?: string;
  customParameters?: {
    callReference?: string;
    contextFile?: string;
    toolManifestFile?: string;
  };
  voicePrompt?: string;
  utteranceUntilInterrupt?: string;
  digit?: string;
  description?: string;
  [key: string]: any;
}

// Define interface for WebSocket session
interface WSSession {
  sessionConversationRelay: ConversationRelayService;
  sessionResponseService: OpenAIService | DeepSeekService;
  sessionData: SessionData;
}

// Define interface for request data
interface RequestData {
  callSid?: string;
  contextFile?: string;
  toolManifestFile?: string;
  properties?: {
    phoneNumber: string;
    callReference: string;
    firstname?: string;
    lastname?: string;
    [key: string]: any;
  };
}

dotenv.config();
const app = express() as unknown as ExpressWSApplication;
const PORT = process.env.PORT || 3000;
let serverBaseUrl = process.env.SERVER_BASE_URL || "localhost"; // Store server URL
const wsInstance = expressWs(app); // Initialize express-ws

app.use(express.urlencoded({ extended: true })); // For Twilio url encoded body
app.use(express.json()); // For JSON payloads

/**
 * This parameterDataMap illustrates how you would pass data via Conversation Relay Parameters.
 * The intention is to store and get data via this map per WS session
 * TODO: Can this be per WS session?
 */
let wsSessionsMap = new Map<string, WSSession>();
let parameterDataMap = new Map<string, { requestData: any }>();
const twilioService = new TwilioService();

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
app.ws("/conversation-relay", (ws: any, req: express.Request) => {
  let sessionConversationRelay: ConversationRelayService | null = null;
  let sessionData: SessionData = {
    parameterData: {},
    setupData: {
      callSid: "",
    },
  };

  // Handle incoming messages for this WS session.
  ws.on("message", async (data: string) => {
    try {
      const message: IncomingMessage = JSON.parse(data);
      // logOut('WS', `Received message of type: ${message.type}`);
      // If the sessionConversationRelay does not exist, initialise it else handle the incoming message
      if (!sessionConversationRelay) {
        logOut("WS", `Session Conversation Relay being initialised`);

        // Since this is the first message from CR, it will be a setup message, so add the Conversation Relay "setup" message data to the session.
        logOut(
          "WS",
          `Adding setup CR setup message data to sessionData. Message type: ${message.type} and callReference: ${message.customParameters?.callReference}`
        );

        sessionData.setupData = message as any;

        // This extracts the parameter data from the parameterDataMap and add it to the sessionData
        if (message.customParameters?.callReference) {
          sessionData.parameterData = parameterDataMap.get(
            message.customParameters.callReference
          ) || { requestData: {} };
        }

        // This loads the initial context and manifest of Conversation Relay setup message
        let contextFile = message.customParameters?.contextFile;
        let toolManifestFile = message.customParameters?.toolManifestFile;

        // Create new response Service.
        logOut("WS", `Creating Response Service`);
        const sessionResponseService = new OpenAIService();
        // const sessionResponseService = new DeepSeekService();
        // const sessionResponseService = new MCPResponseService();

        // Add an event listener for the response service for this particular session based on the call SID. This allows any endpoint to send a message to Session Response Service.
        if (message.callSid) {
          sessionResponseService.on(
            `responseService.${message.callSid}`,
            (responseMessage: any) => {
              logOut(
                "WS",
                `Got a call SID event for the session response service: ${JSON.stringify(
                  responseMessage
                )}`
              );
              // Send the message to the Session Response Service
              // sessionResponseService.incomingMessage(responseMessage);
            }
          );
        }

        logOut("WS", `Creating ConversationRelayService`);
        sessionConversationRelay = new ConversationRelayService(
          sessionResponseService,
          sessionData
        );

        // Attach the Event listener to send event messages from the Conversation Relay back to the WS client
        sessionConversationRelay.on(
          "conversationRelay.outgoingMessage",
          (outgoingMessage: any) => {
            // logOut('WS', `Sending message out: ${JSON.stringify(outgoingMessage)}`);
            ws.send(JSON.stringify(outgoingMessage));
          }
        );

        // Add the session to the wsSessionsMap, so it can be referenced using a particular call SID.
        if (message.callSid) {
          wsSessionsMap.set(message.callSid, {
            sessionConversationRelay,
            sessionResponseService,
            sessionData,
          });
        }
      }

      if (sessionConversationRelay) {
        sessionConversationRelay.incomingMessage(message);
      }
    } catch (error) {
      logError(
        "WS",
        `Error in websocket message handling: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  // Handle client disconnection
  ws.on("close", () => {
    logOut("WS", "Client ws disconnected");
    // Clean up ConversationRelay and its listeners
    if (sessionConversationRelay) {
      sessionConversationRelay.cleanup();
    }
  });

  // Handle errors
  ws.on("error", (error: Error) => {
    logError(
      "WS",
      `WebSocket error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    // Clean up ConversationRelay and its listeners
    if (sessionConversationRelay) {
      sessionConversationRelay.cleanup();
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
app.get("/", (req: express.Request, res: express.Response) => {
  res.send("WebSocket Server Running");
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
 *  'https://server-des.ngrok.dev/outboundCall' \
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
app.post(
  "/outboundCall",
  async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;

    if (requestData.properties?.callReference) {
      parameterDataMap.set(requestData.properties.callReference, {
        requestData: requestData.properties,
      });
    }

    try {
      logOut("Server", `/outboundCall: Initiating outbound call`);
      // const twilioService = new TwilioService();

      if (!requestData.properties?.phoneNumber) {
        throw new Error("Phone number is required");
      }

      const response = await twilioService.makeOutboundCall(
        serverBaseUrl,
        requestData.properties.phoneNumber,
        requestData.properties.callReference || ""
      );

      logOut(
        "Server",
        `/outboundCall: Call initiated with call SID: ${response}`
      );

      res.json({ success: true, response: response });
    } catch (error) {
      logError(
        "Server",
        `Error initiating outbound call: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

/**
 * Initiates a connection to the Conversation Relay service.
 *
 * @name POST /connectConversationRelay
 * @function
 * @async
 * @param {express.Request} req - Express request object
 * @param {express.Response} res - Express response object
 * @param {Object} req.body - Request body
 * @param {string} req.body.callReference - Call reference identifier
 * @param {string} req.body.serverBaseUrl - Base URL of the server
 * @returns {string} TwiML response for establishing the connection
 */
app.post(
  "/connectConversationRelay",
  async (req: express.Request, res: express.Response) => {
    logOut("Server", `Received request to connect to Conversation Relay`);
    // const twilioService = new TwilioService();

    const twiml = twilioService.connectConversationRelay(serverBaseUrl);
    if (twiml) {
      res.send(twiml.toString());
    } else {
      res.status(500).send("Failed to generate TwiML");
    }
  }
);

/**
 * Endpoint to receive Twilio status callbacks and pass them to the Response Service if needed. The Twilio Service will decide what to do with the status callback.
 */
app.post(
  "/twilioStatusCallback",
  async (req: express.Request, res: express.Response) => {
    const statusCallBack = req.body;
    // Extract the call SID from the statusCallBack and insert the content into the sessionMap overwriting the existing content.
    const callSid = statusCallBack.CallSid;
    logOut(
      "Server",
      `Received a Twilio status call back for call SID: ${callSid}: ${JSON.stringify(
        statusCallBack
      )}`
    );

    // Get the session objects from the wsSessionsMap
    let wsSession = wsSessionsMap.get(callSid);

    if (wsSession) {
      let sessionResponseService = wsSession.sessionResponseService;

      // Let the Twilio Service decide what to give back to the Response Service.
      // const twilioService = new TwilioService();
      const evaluatedStatusCallback =
        await twilioService.evaluateStatusCallback(statusCallBack);

      // Now Send the message to the Session Response Service directly if needed. NOTE: It is assumed that Twilio Service will manipulate the content based on it's understanding of the message and if no action is required, null it.
      if (evaluatedStatusCallback) {
        sessionResponseService.insertMessageIntoContext(
          "system",
          JSON.stringify(evaluatedStatusCallback)
        );
      }
    }

    res.json({ success: true });
  }
);

app.post(
  "/updateResponseService",
  async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;
    logOut(
      "Server",
      `Received request to update Response Service with data: ${JSON.stringify(
        requestData
      )}`
    );

    // This loads the initial context and manifest of Conversation Relay setup message
    let callSid = requestData.callSid;
    let contextFile = requestData.contextFile;
    let toolManifestFile = requestData.toolManifestFile;

    if (callSid && contextFile && toolManifestFile) {
      logOut(
        "Server",
        `Changing context and manifest files for call SID: ${callSid} to: ${contextFile} and ${toolManifestFile}`
      );

      // Get the session objects from the wsSessionsMap
      let wsSession = wsSessionsMap.get(callSid);

      if (wsSession) {
        let sessionResponseService = wsSession.sessionResponseService;
        // Now update the context and manifest files for the sessionResponseService.
        sessionResponseService.updateContextAndManifest(
          contextFile,
          toolManifestFile
        );
      }
    }

    res.json({ success: true });
  }
);

/****************************************************
 *
 * Web Server
 *
 ****************************************************/

/**
 * Server initialization and port management.
 * Attempts to start the server on the configured port (from environment or default 3000).
 * If the port is in use, incrementally tries the next port number.
 *
 * @function startServer
 * @returns {http.Server} Express server instance
 * @throws {Error} If server fails to start for reasons other than port in use
 */
let currentPort = Number(PORT);

const startServer = (port: number): void => {
  // logOut('Server', `Starting server on port ${port}`);
  const server = app.listen(port);

  server.on("error", (error: NodeJS.ErrnoException) => {
    // Server emits events for errors
    if (error.code === "EADDRINUSE") {
      server.close();
      logOut("Server", `Port ${port} is in use, trying ${port + 1}`);
      startServer(port + 1);
    } else {
      logError("Server", `Failed to start server: ${error.message}`);
      throw error;
    }
  });

  server.on("listening", () => {
    logOut("Server", `Server started on port ${port}`);
  });
};

startServer(currentPort);
