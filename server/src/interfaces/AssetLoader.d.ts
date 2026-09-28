/**
 * Interface for asset loading implementations
 * Abstracts the source of the server configuration
 */

import type { SilenceDetectionConfig } from '../services/SilenceHandler.js';
import type { ConversationRelayConfig } from './ConversationRelay.js';

/**
 * Configuration type for asset loader selection
 */
export type AssetLoaderConfig = 'file';

/**
 * ServerConfig structure for server configuration
 */
export interface ServerConfig {
    ConversationRelay: {
        Configuration: ConversationRelayConfig;
        SilenceDetection: SilenceDetectionConfig;
    };
    AssetLoader: {
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
     * Initializes the asset loader, if it needs any setup
     * @returns Promise that resolves when initialization is complete
     */
    initialize?(): Promise<void>;

    /**
     * Loads the server configuration (CR/TwiML settings, languages, silence, listen mode)
     * @returns Promise resolving to the server configuration object
     */
    loadServerConfig(): Promise<ServerConfig>;

}