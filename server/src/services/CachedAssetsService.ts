/**
 * CachedAssetsService - High-performance in-memory cache for contexts and manifests
 *
 * This service provides fast access to conversation contexts and tool manifests
 * without runtime Sync API calls. It's designed to:
 *
 * 1. Cache Management:
 *    - Loads all contexts and manifests from Sync at startup
 *    - Maintains in-memory cache for instant access
 *    - Serves fresh copies for each ConversationRelay session
 *
 * 2. Performance Optimization:
 *    - Eliminates per-session service creation overhead
 *    - Avoids runtime Sync API latency
 *    - Provides stateless context switching
 *
 * 3. Session Independence:
 *    - Each CRelay session gets independent context/manifest copies
 *    - Context switching doesn't affect other sessions
 *    - Supports multiple simultaneous conversations
 *
 * 4. Default Configuration:
 *    - Uses UsedConfig to determine default context/manifest
 *    - Fallback to hardcoded defaults if UsedConfig unavailable
 *    - Maintains consistency with existing patterns
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';
import type { AssetLoader, ServerConfig as AssetServerConfig, AssetLoaderConfig } from '../interfaces/AssetLoader.js';
import type { SilenceDetectionConfig } from './SilenceHandler.js';
import { SyncAssetLoader } from './SyncAssetLoader.js';
import { FileAssetLoader } from './FileAssetLoader.js';
import type { ToolFunction, CachedAssets, ActiveAssets, CacheStats } from '../interfaces/CachedAssetsService.js';
import { ServerConfig } from '../config/ServerConfig.js';

class CachedAssetsService {
    private cache: CachedAssets | null = null;
    private isInitialized: boolean = false;

    private assetLoader: AssetLoader | null = null;
    private config: ServerConfig;

    constructor(config: ServerConfig) {
        // Store config for tool factories
        this.config = config;
    }

    /**
     * Initializes the cache by reading configuration and loading assets from the appropriate loader
     * Should be called once at server startup
     */
    async initialize(): Promise<void> {
        try {
            logOut('CachedAssetsService', 'Initializing cache...');

            // Create asset loader based on configuration
            this.assetLoader = await this.createAssetLoader();

            // Initialize asset loader if it has an initialize method (SyncAssetLoader)
            if (this.assetLoader.initialize) {
                await this.assetLoader.initialize();
                logOut('CachedAssetsService', 'Asset loader initialized');
            }

            // Scan for available context and manifest keys
            const [contextKeys, manifestKeys] = await Promise.all([
                (this.assetLoader as any).scanContextFiles?.() || (this.assetLoader as any).scanContextKeys?.() || [],
                (this.assetLoader as any).scanManifestFiles?.() || (this.assetLoader as any).scanManifestKeys?.() || []
            ]);

            logOut('CachedAssetsService', `Found ${contextKeys.length} contexts and ${manifestKeys.length} manifests to load`);

            // Load server config, contexts, and manifests from asset loader
            const [serverConfig, contexts, manifests] = await Promise.all([
                this.assetLoader.loadServerConfig(),
                this.assetLoader.loadContexts(contextKeys),
                this.assetLoader.loadManifests(manifestKeys)
            ]);

            // Extract ConversationRelay configuration and languages from serverConfig
            const conversationRelayConfig = serverConfig.ConversationRelay?.Configuration || {};

            const languages = new Map<string, any>();
            if (serverConfig.ConversationRelay?.Configuration?.languages && Array.isArray(serverConfig.ConversationRelay.Configuration.languages)) {
                serverConfig.ConversationRelay.Configuration.languages.forEach((langConfig: any) => {
                    if (langConfig.code) {
                        languages.set(langConfig.code, langConfig);
                    }
                });
            }

            // Load tools from manifests
            const loadedTools = await this.loadTools(manifests);

            this.cache = {
                contexts,
                manifests,
                serverConfig,
                conversationRelayConfig,
                languages,
                loadedTools
            };

            this.isInitialized = true;
            logOut('CachedAssetsService', `Cache initialized: ${contexts.size} contexts, ${manifests.size} manifests, 1 config loaded, ${languages.size} languages, ${Object.keys(loadedTools).length} tools`);

        } catch (error) {
            logError('CachedAssetsService', `Failed to initialize cache: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Gets the currently active context and manifest based on serverConfig
     * Returns fresh copies for each session
     */
    getActiveAssets(): ActiveAssets {
        this.ensureInitialized();

        const activeContextKey = this.cache!.serverConfig.AssetLoader.activeContextKey;
        const activeManifestKey = this.cache!.serverConfig.AssetLoader.activeManifestKey;

        const context = this.cache!.contexts.get(activeContextKey);
        const manifest = this.cache!.manifests.get(activeManifestKey);

        // Default silence detection config if not provided
        const defaultSilenceConfig: SilenceDetectionConfig = {
            enabled: true,
            secondsThreshold: 20,
            messages: ["Still there?", "Just checking you are still there?"]
        };

        // Default listen mode config if not provided
        const defaultListenMode = {
            enabled: false
        };

        // Return deep copies to ensure session independence
        return {
            context: context || '',
            manifest: JSON.parse(JSON.stringify(manifest || {})),
            silenceDetection: this.cache!.serverConfig.ConversationRelay.SilenceDetection ?? defaultSilenceConfig,
            listenMode: this.cache!.serverConfig.Server.ListenMode ?? defaultListenMode,
            loadedTools: this.cache!.loadedTools // Tools are functions, can be shared
        };
    }

    /**
     * Gets a specific context by key
     * Returns a fresh copy for the session
     */
    getContext(contextKey: string): string | null {
        this.ensureInitialized();

        const context = this.cache!.contexts.get(contextKey);
        return context !== undefined ? context : null;
    }

    /**
     * Gets a specific manifest by key
     * Returns a fresh copy for the session
     */
    getManifest(manifestKey: string): object | null {
        this.ensureInitialized();

        const manifest = this.cache!.manifests.get(manifestKey);
        return manifest !== undefined ? JSON.parse(JSON.stringify(manifest)) : null;
    }

    /**
     * Gets assets for context switching - validates context exists
     * Returns null if context doesn't exist to prevent invalid switches
     */
    getAssetsForContextSwitch(contextKey: string): { context: string; manifest: object } | null {
        this.ensureInitialized();

        const context = this.getContext(contextKey);
        if (!context) {
            logError('CachedAssetsService', `Context '${contextKey}' not found in cache`);
            return null;
        }

        // Use currently active manifest for context switches
        const activeManifest = this.cache!.manifests.get(this.cache!.serverConfig.AssetLoader.activeManifestKey) || {};

        return {
            context,
            manifest: JSON.parse(JSON.stringify(activeManifest))
        };
    }

    /**
     * Lists all available context keys
     */
    getAvailableContexts(): string[] {
        this.ensureInitialized();
        return Array.from(this.cache!.contexts.keys());
    }

    /**
     * Lists all available manifest keys
     */
    getAvailableManifests(): string[] {
        this.ensureInitialized();
        return Array.from(this.cache!.manifests.keys());
    }

    /**
     * Gets ConversationRelay configuration
     * @returns ConversationRelay configuration object
     */
    getConversationRelayConfig(): any {
        this.ensureInitialized();
        return this.cache!.conversationRelayConfig;
    }

    /**
     * Gets language configuration by key
     * @param key Optional specific language key
     * @returns Language configuration(s)
     */
    getLanguages(key?: string): any {
        this.ensureInitialized();

        if (key) {
            return this.cache!.languages.get(key) || null;
        }

        // Return all languages as an object
        const languages: any = {};
        this.cache!.languages.forEach((value, langKey) => {
            languages[langKey] = value;
        });
        return languages;
    }

    /**
     * Gets the server configuration
     * @param key Optional specific server config key
     * @returns Server configuration value(s)
     */
    getServerConfig(key?: string): any {
        this.ensureInitialized();

        if (key) {
            return (this.cache!.serverConfig as any)[key] || null;
        }
        return this.cache!.serverConfig;
    }

    /**
     * Refreshes the cache from the asset loader
     * Useful for updating cache when asset data changes
     */
    async refresh(): Promise<void> {
        logOut('CachedAssetsService', 'Refreshing cache...');
        this.isInitialized = false;
        await this.initialize();
    }

    /**
     * Gets the pre-loaded tools
     * @returns Record of tool name to tool function
     */
    getLoadedTools(): Record<string, ToolFunction> {
        this.ensureInitialized();
        return this.cache!.loadedTools;
    }

    /**
     * Gets cache statistics for monitoring
     */
    getCacheStats(): CacheStats {
        if (!this.isInitialized || !this.cache) {
            return { contexts: 0, manifests: 0, tools: 0, initialized: false };
        }

        return {
            contexts: this.cache.contexts.size,
            manifests: this.cache.manifests.size,
            tools: Object.keys(this.cache.loadedTools).length,
            initialized: this.isInitialized
        };
    }

    /**
     * Loads all tools from manifest files
     * Reads tool files from disk and stores them in memory
     * Calls factory functions with dependencies for tools that need them
     */
    private async loadTools(manifests: Map<string, object>): Promise<Record<string, ToolFunction>> {
        const loadedTools: Record<string, ToolFunction> = {};
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const toolsDir = join(__dirname, '..', 'tools');

        try {
            // Get all unique tool names from all manifests
            const allToolNames = new Set<string>();

            for (const manifest of manifests.values()) {
                const manifestObj = manifest as any;
                if (manifestObj.tools && Array.isArray(manifestObj.tools)) {
                    for (const tool of manifestObj.tools) {
                        if (tool.type === 'function') {
                            const functionName = tool.function?.name || tool.name;
                            if (functionName) {
                                allToolNames.add(functionName);
                            }
                        }
                    }
                }
            }

            logOut('CachedAssetsService', `Loading ${allToolNames.size} unique tools...`);

            // Load each unique tool
            for (const toolName of allToolNames) {
                try {
                    const toolModule = await import(join(toolsDir, `${toolName}.js`));

                    // Call factory functions with dependencies
                    if (toolName === 'change-context') {
                        // change-context needs CachedAssetsService for context access
                        loadedTools[toolName] = toolModule.createChangeContextTool(this);
                        logOut('CachedAssetsService', `Loaded tool (factory): ${toolName}`);
                    } else if (toolName === 'send-sms') {
                        // send-sms needs ServerConfig for Twilio credentials
                        loadedTools[toolName] = toolModule.createSendSMSTool(this.config);
                        logOut('CachedAssetsService', `Loaded tool (factory): ${toolName}`);
                    } else {
                        // Other tools don't need factories (self-contained)
                        loadedTools[toolName] = toolModule.default;
                        logOut('CachedAssetsService', `Loaded tool: ${toolName}`);
                    }
                } catch (error) {
                    logError('CachedAssetsService', `Failed to load tool ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            logOut('CachedAssetsService', `Successfully loaded ${Object.keys(loadedTools).length} tools`);
            return loadedTools;
        } catch (error) {
            logError('CachedAssetsService', `Error loading tools: ${error instanceof Error ? error.message : String(error)}`);
            return loadedTools;
        }
    }

    /**
     * Creates the appropriate asset loader based on configuration
     */
    private async createAssetLoader(): Promise<AssetLoader> {
        try {
            // Read configuration to determine asset loader type
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
                    logError('CachedAssetsService', `Unknown asset loader type: ${assetLoaderType}, defaulting to sync`);
                    return new SyncAssetLoader();
            }
        } catch (error) {
            logError('CachedAssetsService', `Failed to create asset loader: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Reads the asset loader configuration from serverConfig.json
     */
    private async readAssetLoaderConfig(): Promise<AssetLoaderConfig> {
        try {
            // Get the assets path
            const currentModuleFile = fileURLToPath(import.meta.url);
            const serverSrcDir = dirname(dirname(currentModuleFile)); // Go up from services to src
            const serverDir = dirname(serverSrcDir); // Go up from src to server
            const configPath = join(serverDir, 'assets', 'serverConfig.json');

            // Read and parse config
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            // Extract assetLoaderType, default to 'sync' for backward compatibility
            return config.AssetLoader?.assetLoaderType || 'sync';
        } catch (error) {
            logError('CachedAssetsService', `Failed to read asset loader config: ${error instanceof Error ? error.message : String(error)}, defaulting to sync`);
            return 'sync';
        }
    }

    /**
     * Loads additional contexts at runtime and adds them to the cache
     * @param contextKeys Array of context keys to load
     */
    async loadAndCacheContexts(contextKeys: string[]): Promise<void> {
        this.ensureInitialized();

        try {
            const newContexts = await this.assetLoader!.loadContexts(contextKeys);
            newContexts.forEach((content, key) => {
                this.cache!.contexts.set(key, content);
            });
            logOut('CachedAssetsService', `Loaded ${newContexts.size} additional contexts into cache`);
        } catch (error) {
            logError('CachedAssetsService', `Failed to load and cache contexts: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Loads additional manifests at runtime and adds them to the cache
     * Also loads any new tools from the manifests
     * @param manifestKeys Array of manifest keys to load
     */
    async loadAndCacheManifests(manifestKeys: string[]): Promise<void> {
        this.ensureInitialized();

        try {
            const newManifests = await this.assetLoader!.loadManifests(manifestKeys);

            // Load tools from new manifests
            const newTools = await this.loadTools(newManifests);

            // Add manifests to cache
            newManifests.forEach((content, key) => {
                this.cache!.manifests.set(key, content);
            });

            // Add new tools to cache
            Object.assign(this.cache!.loadedTools, newTools);

            logOut('CachedAssetsService', `Loaded ${newManifests.size} additional manifests and ${Object.keys(newTools).length} new tools into cache`);
        } catch (error) {
            logError('CachedAssetsService', `Failed to load and cache manifests: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized || !this.cache || !this.assetLoader) {
            throw new Error('CachedAssetsService not initialized. Call initialize() first.');
        }
    }
}

export { CachedAssetsService };