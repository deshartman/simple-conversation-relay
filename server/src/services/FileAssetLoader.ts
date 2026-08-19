/**
 * FileAssetLoader - Loads assets from local file system
 *
 * This implementation loads contexts and manifests directly from the assets folder
 * without any interaction with Twilio Sync service.
 */

import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
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
     * Scans assets directory for context files (.md files)
     * @returns Array of context keys (filenames without .md extension)
     */
    private async scanContextFiles(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.assetsPath);
            const contextFiles = files.filter(file =>
                file.endsWith('.md') || file.toLowerCase().includes('context')
            );
            return contextFiles.map(file => basename(file, '.md'));
        } catch (error) {
            logError('FileAssetLoader', `Failed to scan context files: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Scans assets directory for manifest files (.json files excluding serverConfig.json)
     * @returns Array of manifest keys (filenames without .json extension)
     */
    private async scanManifestFiles(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.assetsPath);
            const manifestFiles = files.filter(file =>
                file.endsWith('.json') &&
                file !== 'serverConfig.json' &&
                (file.toLowerCase().includes('manifest') || file.toLowerCase().includes('tool'))
            );
            return manifestFiles.map(file => basename(file, '.json'));
        } catch (error) {
            logError('FileAssetLoader', `Failed to scan manifest files: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
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

    /**
     * Loads specific contexts by keys
     * @param keys Array of context keys (filenames without .md extension)
     */
    async loadContexts(keys: string[]): Promise<Map<string, string>> {
        try {
            const contexts = new Map<string, string>();

            for (const key of keys) {
                const filename = `${key}.md`;
                const filePath = join(this.assetsPath, filename);

                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    contexts.set(key, content);
                } catch (error) {
                    logError('FileAssetLoader', `Failed to load context ${key}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            logOut('FileAssetLoader', `Loaded ${contexts.size} contexts from assets folder`);
            return contexts;
        } catch (error) {
            logError('FileAssetLoader', `Failed to load contexts: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Loads specific manifests by keys
     * @param keys Array of manifest keys (filenames without .json extension)
     */
    async loadManifests(keys: string[]): Promise<Map<string, object>> {
        try {
            const manifests = new Map<string, object>();

            for (const key of keys) {
                const filename = `${key}.json`;
                const filePath = join(this.assetsPath, filename);

                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    const manifestData = JSON.parse(content);
                    manifests.set(key, manifestData);
                } catch (error) {
                    logError('FileAssetLoader', `Failed to load manifest ${key}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            logOut('FileAssetLoader', `Loaded ${manifests.size} manifests from assets folder`);
            return manifests;
        } catch (error) {
            logError('FileAssetLoader', `Failed to load manifests: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

}