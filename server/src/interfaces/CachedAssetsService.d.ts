/**
 * Type definitions for CachedAssetsService
 * Provides type safety for asset caching and retrieval operations
 */

import type { SilenceDetectionConfig } from '../services/SilenceHandler.js';
import type { ServerConfig } from './AssetLoader.js';
import type { ToolResult } from './ResponseService.js';

/**
 * Type for loaded tool function
 * Tools may optionally accept a responseService as a second parameter
 */
export type ToolFunction = (args: any, responseService?: any) => Promise<ToolResult> | ToolResult;

/**
 * Internal cache structure for storing all loaded assets
 */
export interface CachedAssets {
    contexts: Map<string, string>;
    manifests: Map<string, object>;
    serverConfig: ServerConfig;
    conversationRelayConfig: any;
    languages: Map<string, any>;
    loadedTools: Record<string, ToolFunction>;
}

/**
 * Active assets returned for a conversation session
 * Includes context, manifest, configuration, and pre-loaded tools
 */
export interface ActiveAssets {
    context: string;
    manifest: object;
    silenceDetection: SilenceDetectionConfig;
    listenMode: { enabled: boolean };
    loadedTools: Record<string, ToolFunction>;
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
    contexts: number;
    manifests: number;
    tools: number;
    initialized: boolean;
}
