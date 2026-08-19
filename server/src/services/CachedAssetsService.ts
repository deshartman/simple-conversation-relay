/**
 * CachedAssetsService — in-memory cache for contexts and server config.
 *
 * v4.12 slims this down. Previously it also loaded `defaultToolManifest.json`
 * and dynamically imported tool modules. Tools are now defined in code via
 * `defineTool` + `ToolRegistry` (see `server/src/tools/`) and registered
 * once at startup — the cache no longer touches them.
 *
 * What's left:
 *  - Context caching from `.md` files (for `change-context` and the
 *    `/updateResponseService` endpoint).
 *  - Server config + language config (for TwilioService TwiML generation).
 *  - Silence detection + listen-mode defaults (for session construction).
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';
import type { AssetLoader, ServerConfig as AssetServerConfig, AssetLoaderConfig } from '../interfaces/AssetLoader.js';
import type { SilenceDetectionConfig } from './SilenceHandler.js';
import { SyncAssetLoader } from './SyncAssetLoader.js';
import { FileAssetLoader } from './FileAssetLoader.js';
import { ServerConfig } from '../config/ServerConfig.js';

interface CachedAssets {
    contexts: Map<string, string>;
    serverConfig: AssetServerConfig;
    conversationRelayConfig: any;
    languages: Map<string, any>;
}

export interface ActiveAssets {
    context: string;
    silenceDetection: SilenceDetectionConfig;
    listenMode: { enabled: boolean };
}

export interface CacheStats {
    contexts: number;
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

            const contextKeys =
                (this.assetLoader as any).scanContextFiles?.() ||
                (this.assetLoader as any).scanContextKeys?.() ||
                [];
            const resolvedContextKeys = await Promise.resolve(contextKeys);

            logOut(
                'CachedAssetsService',
                `Found ${resolvedContextKeys.length} contexts to load`
            );

            const [serverConfig, contexts] = await Promise.all([
                this.assetLoader.loadServerConfig(),
                this.assetLoader.loadContexts(resolvedContextKeys),
            ]);

            const conversationRelayConfig =
                serverConfig.ConversationRelay?.Configuration || {};

            const languages = new Map<string, any>();
            const langArray = serverConfig.ConversationRelay?.Configuration?.languages;
            if (langArray && Array.isArray(langArray)) {
                langArray.forEach((langConfig: any) => {
                    if (langConfig.code) languages.set(langConfig.code, langConfig);
                });
            }

            this.cache = { contexts, serverConfig, conversationRelayConfig, languages };
            this.isInitialized = true;

            logOut(
                'CachedAssetsService',
                `Cache initialized: ${contexts.size} contexts, ${languages.size} languages`
            );
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    /**
     * Get the currently active context + non-context defaults for session
     * construction. (Tools now come from the ToolRegistry, not this cache.)
     */
    getActiveAssets(): ActiveAssets {
        this.ensureInitialized();

        const activeContextKey = this.cache!.serverConfig.AssetLoader.activeContextKey;
        const context = this.cache!.contexts.get(activeContextKey);

        const defaultSilenceConfig: SilenceDetectionConfig = {
            enabled: true,
            secondsThreshold: 20,
            messages: ['Still there?', 'Just checking you are still there?'],
        };
        const defaultListenMode = { enabled: false };

        return {
            context: context || '',
            silenceDetection:
                this.cache!.serverConfig.ConversationRelay.SilenceDetection ??
                defaultSilenceConfig,
            listenMode: this.cache!.serverConfig.Server.ListenMode ?? defaultListenMode,
        };
    }

    getContext(contextKey: string): string | null {
        this.ensureInitialized();
        const context = this.cache!.contexts.get(contextKey);
        return context !== undefined ? context : null;
    }

    /**
     * Assets for a `change-context` tool invocation. Returns just the
     * context string now (manifest is no longer per-leg in v4.12).
     */
    getAssetsForContextSwitch(contextKey: string): { context: string } | null {
        this.ensureInitialized();
        const context = this.getContext(contextKey);
        if (!context) {
            logError('CachedAssetsService', `Context '${contextKey}' not found in cache`);
            return null;
        }
        return { context };
    }

    getAvailableContexts(): string[] {
        this.ensureInitialized();
        return Array.from(this.cache!.contexts.keys());
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
            return { contexts: 0, initialized: false };
        }
        return { contexts: this.cache.contexts.size, initialized: this.isInitialized };
    }

    async loadAndCacheContexts(contextKeys: string[]): Promise<void> {
        this.ensureInitialized();
        try {
            const newContexts = await this.assetLoader!.loadContexts(contextKeys);
            newContexts.forEach((content, key) => {
                this.cache!.contexts.set(key, content);
            });
            logOut(
                'CachedAssetsService',
                `Loaded ${newContexts.size} additional contexts into cache`
            );
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to load and cache contexts: ${error instanceof Error ? error.message : String(error)}`
            );
            throw error;
        }
    }

    private async createAssetLoader(): Promise<AssetLoader> {
        try {
            const assetLoaderType = await this.readAssetLoaderConfig();
            logOut('CachedAssetsService', `Creating ${assetLoaderType} asset loader`);

            switch (assetLoaderType) {
                case 'sync':
                    return new SyncAssetLoader();
                case 'file':
                    return new FileAssetLoader();
                case 'j2':
                    throw new Error('J2 asset loader not yet implemented');
                default:
                    logError(
                        'CachedAssetsService',
                        `Unknown asset loader type: ${assetLoaderType}, defaulting to sync`
                    );
                    return new SyncAssetLoader();
            }
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
            return config.AssetLoader?.assetLoaderType || 'sync';
        } catch (error) {
            logError(
                'CachedAssetsService',
                `Failed to read asset loader config: ${error instanceof Error ? error.message : String(error)}, defaulting to sync`
            );
            return 'sync';
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized || !this.cache || !this.assetLoader) {
            throw new Error('CachedAssetsService not initialized. Call initialize() first.');
        }
    }
}

export { CachedAssetsService };
