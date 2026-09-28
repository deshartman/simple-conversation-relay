/**
 * FileAssetLoader - Loads assets from local file system
 *
 * Loads the server config from the assets folder. (LLM contexts are read by
 * `ContextStore`, not here.)
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';
import type { AssetLoader, ServerConfig } from '../interfaces/AssetLoader.js';

export class FileAssetLoader implements AssetLoader {
    private assetsPath: string;

    constructor() {
        // Get the current module's directory and navigate to assets
        const currentModuleFile = fileURLToPath(import.meta.url);
        const serverSrcDir = dirname(dirname(currentModuleFile)); // Go up from services to src
        const serverDir = dirname(serverSrcDir); // Go up from src to server
        this.assetsPath = join(serverDir, 'assets');
    }

    /**
     * Loads the server configuration from serverConfig.json
     */
    async loadServerConfig(): Promise<ServerConfig> {
        try {
            const configPath = join(this.assetsPath, 'serverConfig.json');
            const configContent = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(configContent);

            logOut('FileAssetLoader', `Loaded ServerConfig from ${configPath}`);
            return config;
        } catch (error) {
            logError('FileAssetLoader', `Failed to load ServerConfig: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

}