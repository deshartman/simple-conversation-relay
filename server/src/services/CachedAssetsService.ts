/**
 * CachedAssetsService — in-memory cache of the transport's server config.
 *
 * Holds only ConversationRelay-side configuration:
 *  - Server config + language config (for TwilioService TwiML generation and
 *    the session's TTS auto-switch allow-list).
 *  - Silence detection + listen-mode defaults (for session construction).
 *
 * LLM contexts are not loaded here: a ResponseService that owns its prompt
 * reads them from `ContextStore`.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';
import type { AssetLoader, ServerConfig as AssetServerConfig, AssetLoaderConfig } from '../interfaces/AssetLoader.js';
import type { SilenceDetectionConfig } from './SilenceHandler.js';
import { FileAssetLoader } from './FileAssetLoader.js';
import { ServerConfig } from '../config/ServerConfig.js';

interface CachedAssets {
    serverConfig: AssetServerConfig;
    conversationRelayConfig: any;
    languages: Map<string, any>;
}

export interface ActiveAssets {
    silenceDetection: SilenceDetectionConfig;
    listenMode: { enabled: boolean };
}

export interface CacheStats {
    initialized: boolean;
}

class CachedAssetsService {
    private cache: CachedAssets | null = null;
    private isInitialized = false;
    private assetLoader: AssetLoader | null = null;
    private config: ServerConfig;

    constructor(config: ServerConfig) {
        this.config = config;
    }

    async initialize(): Promise<void> {
        try {
            logOut('CachedAssetsService', 'Initializing cache...');

            this.assetLoader = await this.createAssetLoader();
            if (this.assetLoader.initialize) {
                await this.assetLoader.initialize();
                logOut('CachedAssetsService', 'Asset loader initialized');
            }

            const serverConfig = await this.assetLoader.loadServerConfig();

            const conversationRelayConfig =
                serverConfig.ConversationRelay?.Configuration || {};

            const languages = new Map<string, any>();
            const langArray = serverConfig.ConversationRelay?.Configuration?.languages;
            if (langArray && Array.isArray(langArray)) {
                langArray.forEach((langConfig: any) => {
                    if (langConfig.code) languages.set(langConfig.code, langConfig);
                });
            }

            this.cache = { serverConfig, conversationRelayConfig, languages };
            this.isInitialized = true;

            logOut(
                'CachedAssetsService',
                `Cache initialized: ${languages.size} languages`
            );
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /** Transport defaults for session construction. */
    getActiveAssets(): ActiveAssets {
        this.ensureInitialized();

        const defaultSilenceConfig: SilenceDetectionConfig = {
            enabled: true,
            secondsThreshold: 20,
            messages: ['Still there?', 'Just checking you are still there?'],
        };
        const defaultListenMode = { enabled: false };

        return {
            silenceDetection:
                this.cache!.serverConfig.ConversationRelay.SilenceDetection ??
                defaultSilenceConfig,
            listenMode: this.cache!.serverConfig.Server.ListenMode ?? defaultListenMode,
        };
    }

    getConversationRelayConfig(): any {
        this.ensureInitialized();
        return this.cache!.conversationRelayConfig;
    }

    getLanguages(key?: string): any {
        this.ensureInitialized();
        if (key) return this.cache!.languages.get(key) || null;
        const languages: any = {};
        this.cache!.languages.forEach((value, langKey) => {
            languages[langKey] = value;
        });
        return languages;
    }

    getServerConfig(key?: string): any {
        this.ensureInitialized();
        if (key) return (this.cache!.serverConfig as any)[key] || null;
        return this.cache!.serverConfig;
    }

    async refresh(): Promise<void> {
        logOut('CachedAssetsService', 'Refreshing cache...');
        this.isInitialized = false;
        await this.initialize();
    }

    getCacheStats(): CacheStats {
        if (!this.isInitialized || !this.cache) {
            return { initialized: false };
        }
        return { initialized: this.isInitialized };
    }

    private async createAssetLoader(): Promise<AssetLoader> {
        try {
            const assetLoaderType = await this.readAssetLoaderConfig();
            logOut('CachedAssetsService', `Creating ${assetLoaderType} asset loader`);

            if (assetLoaderType !== 'file') {
                throw new Error(
                    `Unsupported asset loader type '${assetLoaderType}' — only 'file' is supported (Twilio Sync loading was removed)`
                );
            }
            return new FileAssetLoader();
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to create asset loader: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    private async readAssetLoaderConfig(): Promise<AssetLoaderConfig> {
        try {
            const currentModuleFile = fileURLToPath(import.meta.url);
            const serverSrcDir = dirname(dirname(currentModuleFile));
            const serverDir = dirname(serverSrcDir);
            const configPath = join(serverDir, 'assets', 'serverConfig.json');
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);
            return config.AssetLoader?.assetLoaderType || 'file';
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to read asset loader config: ${error instanceof Error ? error.message : String(error)}, defaulting to file`
            );
            return 'file';
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized || !this.cache || !this.assetLoader) {
            throw new Error('CachedAssetsService not initialized. Call initialize() first.');
        }
    }
}

export { CachedAssetsService };
