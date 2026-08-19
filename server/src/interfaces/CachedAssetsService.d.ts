/**
 * Type definitions for CachedAssetsService.
 *
 * v4.12: tool function / manifest / loadedTools types have moved to
 * `server/src/tools/`. This file keeps only the context-cache shapes.
 * Kept as a `.d.ts` rather than deleted to preserve existing imports.
 */

import type { SilenceDetectionConfig } from '../services/SilenceHandler.js';
import type { ServerConfig } from './AssetLoader.js';

export interface CachedAssets {
    contexts: Map<string, string>;
    serverConfig: ServerConfig;
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
