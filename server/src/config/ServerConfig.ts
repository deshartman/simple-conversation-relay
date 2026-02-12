import { config as loadDotenv } from 'dotenv';
import { logOut } from '../utils/logger.js';

/**
 * Centralized server configuration
 * Loads and validates all environment variables at startup
 *
 * Provides two static factory methods:
 * - fromEnv(): Loads from environment variables with validation
 * - forTesting(): Creates test configuration with safe defaults
 */
export class ServerConfig {
    // Server
    public readonly port: number;
    public readonly serverBaseUrl: string;
    public readonly nodeEnv: string;

    // OpenAI
    public readonly openaiApiKey: string;
    public readonly openaiModel: string;

    // Twilio
    public readonly twilioAccountSid: string;
    public readonly twilioAuthToken: string;
    public readonly twilioFromNumber: string;
    public readonly twilioEdge?: string;
    public readonly twilioRegion?: string;

    // Asset Loader
    public readonly assetLoaderType: string;

    constructor(data: {
        port: number;
        serverBaseUrl: string;
        nodeEnv: string;
        openaiApiKey: string;
        openaiModel: string;
        twilioAccountSid: string;
        twilioAuthToken: string;
        twilioFromNumber: string;
        twilioEdge?: string;
        twilioRegion?: string;
        assetLoaderType: string;
    }) {
        this.port = data.port;
        this.serverBaseUrl = data.serverBaseUrl;
        this.nodeEnv = data.nodeEnv;
        this.openaiApiKey = data.openaiApiKey;
        this.openaiModel = data.openaiModel;
        this.twilioAccountSid = data.twilioAccountSid;
        this.twilioAuthToken = data.twilioAuthToken;
        this.twilioFromNumber = data.twilioFromNumber;
        this.twilioEdge = data.twilioEdge;
        this.twilioRegion = data.twilioRegion;
        this.assetLoaderType = data.assetLoaderType;
    }

    /**
     * Load configuration from environment variables
     * Validates required variables and fails fast at startup
     *
     * Environment file selection:
     * - production: .env.prod
     * - development: .env.dev
     * - default: .env
     */
    static fromEnv(): ServerConfig {
        // Determine which .env file to load
        const nodeEnv = process.env.NODE_ENV || 'development';
        const envFile = nodeEnv === 'production' || nodeEnv === 'prod' ? '.env.prod' :
                       nodeEnv === 'development' || nodeEnv === 'dev' ? '.env.dev' : '.env';

        // Load environment variables
        loadDotenv({ path: envFile });
        logOut('ServerConfig', `Loading configuration from ${envFile} (NODE_ENV=${nodeEnv})`);

        // Validate required variables
        const required = [
            'SERVER_BASE_URL',
            'OPENAI_API_KEY',
            'ACCOUNT_SID',
            'AUTH_TOKEN',
            'FROM_NUMBER'
        ];

        const missing = required.filter(key => !process.env[key]);
        if (missing.length > 0) {
            throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
        }

        // Create config object
        return new ServerConfig({
            port: parseInt(process.env.PORT || '3000', 10),
            serverBaseUrl: process.env.SERVER_BASE_URL!,
            nodeEnv,
            openaiApiKey: process.env.OPENAI_API_KEY!,
            openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
            twilioAccountSid: process.env.ACCOUNT_SID!,
            twilioAuthToken: process.env.AUTH_TOKEN!,
            twilioFromNumber: process.env.FROM_NUMBER!,
            twilioEdge: process.env.TWILIO_EDGE,
            twilioRegion: process.env.TWILIO_REGION,
            assetLoaderType: process.env.ASSET_LOADER_TYPE || 'file'
        });
    }

    /**
     * Create configuration for testing with safe defaults
     * Allows partial overrides for specific test scenarios
     */
    static forTesting(overrides: Partial<ServerConfig> = {}): ServerConfig {
        return new ServerConfig({
            port: 3000,
            serverBaseUrl: 'http://localhost:3000',
            nodeEnv: 'test',
            openaiApiKey: 'test-openai-key',
            openaiModel: 'gpt-4o',
            twilioAccountSid: 'test-twilio-sid',
            twilioAuthToken: 'test-twilio-token',
            twilioFromNumber: '+15555555555',
            assetLoaderType: 'file',
            ...overrides as any
        });
    }
}
