/**
 * Interface for asset loading implementations
 * Abstracts the source of contexts, manifests, and configuration data
 */

import type { SilenceDetectionConfig } from '../services/SilenceHandler.js';
import type { ConversationRelayConfig } from './ConversationRelay.js';

/**
 * Configuration type for asset loader selection
 */
export type AssetLoaderConfig = 'sync' | 'file' | 'j2';

/**
 * ServerConfig structure for server configuration
 */
export interface ServerConfig {
    ConversationRelay: {
        Configuration: ConversationRelayConfig;
        SilenceDetection: SilenceDetectionConfig;
    };
    AssetLoader: {
        activeContextKey: string;
        /** @deprecated v4.12: tools are registered in code; this field is ignored. */
        activeManifestKey?: string;
        assetLoaderType: AssetLoaderConfig;
    };
    Server: {
        ListenMode: {
            enabled: boolean;
        };
    };
}

/**
 * Asset loader interface for abstracting asset loading from different sources
 */
export interface AssetLoader {
    /**
     * Initializes the asset loader (creates services/maps/documents for sync loader)
     * @returns Promise that resolves when initialization is complete
     */
    initialize?(): Promise<void>;

    /**
     * Loads the server configuration that determines default context and manifest
     * @returns Promise resolving to the server configuration object
     */
    loadServerConfig(): Promise<ServerConfig>;

    /**
     * Loads specific contexts by keys
     * @param keys Array of context keys to load
     * @returns Promise resolving to a Map of context keys to context content
     */
    loadContexts(keys: string[]): Promise<Map<string, string>>;

    /**
     * @deprecated v4.12: tools are now registered in code, not via JSON
     * manifests. Kept in the interface (optional) for back-compat with
     * existing `FileAssetLoader` / `SyncAssetLoader` implementations.
     */
    loadManifests?(keys: string[]): Promise<Map<string, object>>;

}