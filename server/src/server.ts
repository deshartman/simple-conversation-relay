/**
 * Main server — Express + WebSocket for Twilio ConversationRelay.
 *
 * v4.12 architecture:
 *   - One ConversationRelaySession per WebSocket, owning all per-call state.
 *   - ToolRegistry built once at startup (all tools registered up front).
 *   - Incoming frames validated via Zod at the WS boundary.
 *   - Tool schema lives in code alongside handlers (see server/src/tools/).
 */

import dotenv from 'dotenv';
import express from 'express';
import expressWs, { Application as ExpressWSApplication } from 'express-ws';
import twilio from 'twilio';
import { logOut, logError } from './utils/logger.js';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import path from 'path';

import { ConversationRelaySession } from './services/ConversationRelaySession.js';
import { OpenAIResponseService } from './services/OpenAIResponseService.js';
import { TwilioService } from './services/TwilioService.js';
import { CachedAssetsService } from './services/CachedAssetsService.js';
import { ServerConfig } from './config/ServerConfig.js';
import type { SessionData } from './interfaces/ConversationRelay.js';
import { buildDefaultRegistry, ToolRegistry } from './tools/index.js';
import { IncomingFrameSchema, type OutgoingFrame } from './types/crelay.js';
import {
    createOutboundAuth,
    createDestinationValidator,
    createRateLimiter,
} from './middleware/outbound-guards.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WSSession {
    session: ConversationRelaySession;
    sessionData: SessionData;
}

interface RequestData {
    callSid?: string;
    contextKey?: string;
    manifestKey?: string; // deprecated in v4.12 — kept for back-compat; ignored
    properties?: {
        phoneNumber: string;
        callReference: string;
        firstname?: string;
        lastname?: string;
        [key: string]: any;
    };
}

/**
 * Kept for reference — ServerConfig.fromEnv() handles env loading now.
 */
function loadEnvironmentConfig(): void {
    const nodeEnv = process.env.NODE_ENV;
    const serverRoot = path.resolve(__dirname, '..');

    let envPath: string;
    let envName: string;

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

function validateRequiredEnvVars(): void {
    const required = ['PORT', 'SERVER_BASE_URL', 'OPENAI_API_KEY', 'ACCOUNT_SID', 'AUTH_TOKEN', 'FROM_NUMBER'];
    const missing = required.filter(varName => !process.env[varName]);
    if (missing.length > 0) {
        const errorMsg = `Missing required environment variables: ${missing.join(', ')}`;
        logError('Server', errorMsg);
        throw new Error(errorMsg);
    }
    logOut('Server', 'All required environment variables validated');
}

const app = express() as unknown as ExpressWSApplication;
const wsInstance = expressWs(app);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ----------------------------------------------------------------------------
// Module-level maps / service instances
// ----------------------------------------------------------------------------

let wsSessionsMap = new Map<string, WSSession>();
let parameterDataMap = new Map<string, { requestData: any; createdAt: number }>();

/**
 * How long an unclaimed `parameterDataMap` entry survives. Entries are
 * normally deleted when the call's WebSocket closes; this bounds the map for
 * outbound calls that are never answered and so never open a WebSocket.
 */
const PARAMETER_DATA_TTL_MS = 60 * 60 * 1000;
let conversationSessionMap = new Map<string, OpenAIResponseService>();
let twilioService: TwilioService;
let cachedAssetsService: CachedAssetsService | null = null;
let serverConfig: ServerConfig;
let toolRegistry: ToolRegistry;

/**
 * Verify `X-Twilio-Signature` on the endpoints Twilio actually calls.
 *
 * Host and protocol are pinned to SERVER_BASE_URL rather than inferred from the
 * request, because behind a tunnel Express sees `http://localhost:3007` while
 * Twilio signed `https://<public-host>` — inferring would fail every time.
 *
 * NOTE: this does not protect `/outboundCall`. That endpoint is called by your
 * own code, not by Twilio, so there is no Twilio signature on it. It still
 * needs its own authentication.
 */
let outboundGuards: express.RequestHandler[] | null = null;

/**
 * Build the `/outboundCall` guard chain on first use. Routes are registered at
 * module scope but `serverConfig` is only assigned in `main()`, so the guards
 * cannot be constructed eagerly.
 *
 * Order matters: authenticate first so unauthenticated traffic cannot exhaust
 * the rate-limit quota (that would be a denial-of-service against your own
 * campaign), then validate, so malformed requests do not consume quota either.
 */
const guardOutboundCall: express.RequestHandler = (req, res, next) => {
    if (!outboundGuards) {
        outboundGuards = [
            createOutboundAuth(serverConfig.outboundApiKey),
            createDestinationValidator(),
            createRateLimiter(serverConfig.outboundRateLimitPerMinute),
        ];
    }
    // Run the chain in order, short-circuiting on the first responder.
    let i = 0;
    const run = (err?: any): void => {
        if (err) return next(err);
        const guard = outboundGuards![i++];
        if (!guard) return next();
        guard(req, res, run);
    };
    run();
};

const validateTwilioSignature: express.RequestHandler = (req, res, next) => {
    if (!serverConfig.validateTwilioWebhooks) return next();

    return twilio.webhook({
        validate: true,
        authToken: serverConfig.twilioAuthToken,
        protocol: 'https',
        host: serverConfig.serverBaseUrl,
    })(req, res, next);
};

async function initializeServices(): Promise<void> {
    try {
        cachedAssetsService = new CachedAssetsService(serverConfig);
        await cachedAssetsService.initialize();
        logOut('Server', 'CachedAssetsService initialized');

        twilioService = new TwilioService(serverConfig);
        await twilioService.initialize();
        logOut('Server', 'TwilioService initialized');

        toolRegistry = buildDefaultRegistry(serverConfig, cachedAssetsService);
        logOut('Server', `ToolRegistry built with ${toolRegistry.size()} tools`);

        logOut('Server', 'All services initialized');
    } catch (error) {
        logError(
            'Server',
            `Failed to initialize services: ${error instanceof Error ? error.message : String(error)}`
        );
        throw error;
    }
}

// ----------------------------------------------------------------------------
// WebSocket — /conversation-relay
// ----------------------------------------------------------------------------

app.ws('/conversation-relay', (ws: any, _req: express.Request) => {
    let session: ConversationRelaySession | null = null;
    let sessionData: SessionData = {
        parameterData: {},
        setupData: { callSid: '' },
    };
    let registeredCallSid: string | null = null;
    let registeredCallReference: string | null = null;

    const send = (frame: OutgoingFrame) => ws.send(JSON.stringify(frame));

    ws.on('message', async (data: string) => {
        let rawMessage: unknown;
        try {
            rawMessage = JSON.parse(data);
        } catch (error) {
            logError(
                'WS',
                `Malformed JSON frame dropped: ${error instanceof Error ? error.message : String(error)}`
            );
            return;
        }

        const parsed = IncomingFrameSchema.safeParse(rawMessage);
        if (!parsed.success) {
            logError(
                'WS',
                `Incoming frame failed Zod validation: ${JSON.stringify(
                    parsed.error.issues
                )} — frame: ${JSON.stringify(rawMessage)}`
            );
            return;
        }
        const message = parsed.data;

        try {
            // First frame must be `setup`. If we haven't constructed the
            // session yet, do so now.
            if (!session) {
                if (message.type !== 'setup') {
                    logError(
                        'WS',
                        `First frame was '${message.type}', expected 'setup' — dropping`
                    );
                    return;
                }

                logOut(
                    'WS',
                    `Session initialising. callReference=${message.customParameters?.callReference ?? '(none)'}`
                );

                sessionData.setupData = message as SessionData['setupData'];

                if (message.customParameters?.callReference) {
                    registeredCallReference = message.customParameters.callReference;
                    const entry = parameterDataMap.get(registeredCallReference);
                    sessionData.parameterData = entry
                        ? { requestData: entry.requestData }
                        : { requestData: {} };
                }

                if (!cachedAssetsService) {
                    throw new Error('CachedAssetsService not initialized');
                }

                const activeAssets = cachedAssetsService.getActiveAssets();

                // Listen mode is per-call, not global: outbound calls start
                // silent while inbound callers must be greeted, which a single
                // config flag cannot express. The `listenMode` <Parameter> set
                // at dial time wins; otherwise fall back to server config.
                const listenModeParam = message.customParameters?.listenMode;
                const initialListenMode =
                    listenModeParam === 'true'
                        ? true
                        : listenModeParam === 'false'
                          ? false
                          : activeAssets.listenMode.enabled;
                logOut(
                    'WS',
                    `Initial listen mode: ${initialListenMode} (parameter=${listenModeParam ?? '(none)'}, config=${activeAssets.listenMode.enabled})`
                );

                // Per-call context selection. Without this the active context is
                // global, so an outbound campaign prompt would also be served to
                // inbound callers. `contextKey` was previously honoured only by
                // POST /updateResponseService, i.e. after the call had started.
                let context = activeAssets.context;
                const contextKeyParam = message.customParameters?.contextKey;
                if (contextKeyParam) {
                    const override = cachedAssetsService.getContext(contextKeyParam);
                    if (override) {
                        context = override;
                        logOut('WS', `Using context '${contextKeyParam}' for this call`);
                    } else {
                        logError(
                            'WS',
                            `contextKey '${contextKeyParam}' not found — falling back to the active context`
                        );
                    }
                }

                const responseService = new OpenAIResponseService(
                    context,
                    toolRegistry,
                    serverConfig
                );

                session = new ConversationRelaySession({
                    responseService,
                    sessionData,
                    silenceConfig: activeAssets.silenceDetection,
                    initialListenMode,
                    registry: toolRegistry,
                    send,
                });

                if (message.callSid) {
                    registeredCallSid = message.callSid;
                    wsSessionsMap.set(message.callSid, { session, sessionData });
                }

                await session.setup();

                // The setup frame is fully consumed above. Passing it to
                // handleIncoming() as well only logged "Duplicate setup
                // ignored" on every single call.
                return;
            }

            await session.handleIncoming(message as any);
        } catch (error) {
            logError(
                'WS',
                `Error handling frame: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    });

    ws.on('close', () => {
        logOut('WS', 'Client ws disconnected');
        if (session) {
            session.cleanup();
            session = null;
        }
        if (registeredCallSid) {
            wsSessionsMap.delete(registeredCallSid);
        }
        if (registeredCallReference) {
            parameterDataMap.delete(registeredCallReference);
            registeredCallReference = null;
        }
    });

    ws.on('error', (error: Error) => {
        logError('WS', `WebSocket error: ${error.message}`);
        if (session) {
            session.cleanup();
            session = null;
        }
        if (registeredCallSid) {
            wsSessionsMap.delete(registeredCallSid);
        }
        if (registeredCallReference) {
            parameterDataMap.delete(registeredCallReference);
            registeredCallReference = null;
        }
    });
});

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------

app.get('/', (_req: express.Request, res: express.Response) => {
    res.send('WebSocket Server Running');
});

app.post('/outboundCall', guardOutboundCall, async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;

    try {
        logOut('Server', `/outboundCall: Initiating outbound call`);
        if (!requestData.properties?.phoneNumber) {
            throw new Error('Phone number is required');
        }
        const { phoneNumber, ...parameters } = requestData.properties;
        if (parameters.callReference) {
            // Prune entries whose call never opened a WebSocket.
            const cutoff = Date.now() - PARAMETER_DATA_TTL_MS;
            for (const [key, value] of parameterDataMap) {
                if (value.createdAt < cutoff) {
                    parameterDataMap.delete(key);
                }
            }
            parameterDataMap.set(parameters.callReference, {
                requestData: requestData.properties,
                createdAt: Date.now(),
            });
        }
        const response = await twilioService.makeOutboundCall(
            serverConfig.serverBaseUrl,
            phoneNumber,
            cachedAssetsService!,
            parameters
        );
        logOut('Server', `/outboundCall: Call SID: ${response.sid}`);
        res.json({ success: true, response });
    } catch (error) {
        logError(
            'Server',
            `Error initiating outbound call: ${error instanceof Error ? error.message : String(error)}`
        );
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

app.post('/connectConversationRelay', validateTwilioSignature, async (req: express.Request, res: express.Response) => {
    logOut('Server', `Received request to connect to Conversation Relay`);
    const parameters = req.body.parameters || {};
    const voiceResponse = await twilioService.connectConversationRelay(
        serverConfig.serverBaseUrl,
        cachedAssetsService!,
        parameters
    );
    if (voiceResponse) {
        res.send(voiceResponse.toString());
    } else {
        res.status(500).send('Failed to generate voice response to connect Conversation Relay');
    }
});

app.post('/handoff', validateTwilioSignature, (req: express.Request, res: express.Response) => {
    const handoffData = req.body.HandoffData;
    logOut('Server', `/handoff: Conversation Relay ended. HandoffData=${handoffData}`);

    const twiml = new twilio.twiml.VoiceResponse();

    let reasonCode: string | undefined;
    try {
        reasonCode = handoffData ? JSON.parse(handoffData).reasonCode : undefined;
    } catch {
        // Malformed HandoffData — fall through to empty TwiML (clean hangup).
    }

    if (reasonCode === 'live-agent-handoff') {
        twiml.play({ loop: 3 }, 'https://demo.twilio.com/docs/classic.mp3');
    }

    res.type('text/xml').send(twiml.toString());
});

app.post('/twilioStatusCallback', validateTwilioSignature, async (req: express.Request, res: express.Response) => {
    const statusCallBack = req.body;
    const callSid = statusCallBack.CallSid;
    logOut(
        'Server',
        `Received Twilio status callback for call SID ${callSid}: ${JSON.stringify(statusCallBack)}`
    );

    const wsSession = wsSessionsMap.get(callSid);
    if (wsSession) {
        const evaluated = await twilioService.evaluateStatusCallback(statusCallBack);
        if (evaluated) {
            await wsSession.session.insertMessage('system', JSON.stringify(evaluated));
        }
    }
    res.json({ success: true });
});

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

        if (sessionId && conversationSessionMap.has(sessionId)) {
            currentSessionId = sessionId;
            responseService = conversationSessionMap.get(sessionId)!;
            logOut('Server', `/conversation: Using existing session ${currentSessionId}`);
        } else {
            currentSessionId = crypto.randomUUID();
            const activeAssets = cachedAssetsService.getActiveAssets();
            responseService = new OpenAIResponseService(
                activeAssets.context,
                toolRegistry,
                serverConfig
            );
            conversationSessionMap.set(currentSessionId, responseService);
            logOut('Server', `/conversation: Created new session ${currentSessionId}`);
        }

        let accumulatedResponse = '';
        responseService.createResponseHandler({
            content: contentResponse => {
                if (contentResponse.type === 'text' && contentResponse.token) {
                    accumulatedResponse += contentResponse.token;
                }
            },
            toolResult: toolResultEvent => {
                logOut('Server', `/conversation: Tool executed: ${toolResultEvent.toolType}`);
            },
            error: error => {
                logError('Server', `/conversation: Error: ${error.message}`);
            },
            callSid: () => {
                /* unused here */
            },
        });

        await responseService.generateResponse(role, message);

        res.json({ success: true, sessionId: currentSessionId, response: accumulatedResponse });
    } catch (error) {
        logError(
            'Server',
            `/conversation: Error: ${error instanceof Error ? error.message : String(error)}`
        );
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

app.post('/updateResponseService', async (req: express.Request, res: express.Response) => {
    const requestData: RequestData = req.body;
    logOut(
        'Server',
        `Received request to update Response Service: ${JSON.stringify(requestData)}`
    );

    try {
        if (!cachedAssetsService) {
            res.status(500).json({ success: false, error: 'CachedAssetsService not initialized' });
            return;
        }

        const { callSid, contextKey, manifestKey } = requestData;

        if (manifestKey) {
            logOut(
                'Server',
                `/updateResponseService: 'manifestKey' is deprecated in v4.12 — tools are registered in code and no longer per-leg. Ignoring.`
            );
        }

        if (!callSid || !contextKey) {
            res.status(400).json({
                success: false,
                error: 'callSid and contextKey are required',
            });
            return;
        }

        const wsSession = wsSessionsMap.get(callSid);
        if (!wsSession) {
            res.status(404).json({ success: false, error: `Session not found for call SID: ${callSid}` });
            return;
        }

        const cachedContext = cachedAssetsService.getContext(contextKey);
        if (!cachedContext) {
            res.status(400).json({ success: false, error: `Context not found for key: ${contextKey}` });
            return;
        }

        await wsSession.session.updateContext(cachedContext);
        res.json({ success: true });
    } catch (error) {
        logError(
            'Server',
            `Error updating response service: ${error instanceof Error ? error.message : String(error)}`
        );
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

// ----------------------------------------------------------------------------
// Startup
// ----------------------------------------------------------------------------

const startServer = (port: number): void => {
    let currentPort = port;
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

    const server = app
        .listen(currentPort)
        .on('error', (error: NodeJS.ErrnoException) => {
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
        serverConfig = ServerConfig.fromEnv();
        logOut('Server', `Configuration loaded for ${serverConfig.nodeEnv} environment`);
        await initializeServices();
        startServer(serverConfig.port);
    } catch (error) {
        logError(
            'Server',
            `Fatal error during startup: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
    }
})();
