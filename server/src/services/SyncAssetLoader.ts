/**
 * SyncAssetLoader - Loads assets from Twilio Sync service
 *
 * This implementation directly uses Twilio Sync API to load contexts and manifests
 * from Twilio Sync services without any wrapper dependencies.
 */

import twilio from 'twilio';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';
import type { AssetLoader, ServerConfig } from '../interfaces/AssetLoader.js';

interface SyncServiceMap {
    name: string;
    maps: string[];
    documents?: string[];
}

export class SyncAssetLoader implements AssetLoader {
    private twilioClient: twilio.Twilio;
    private assetsPath: string;

    private readonly SERVICE_DEFINITIONS: SyncServiceMap[] = [
        {
            name: 'ConversationRelay',
            maps: ['Context', 'ToolManifest'],
            documents: ['serverConfig']
        }
    ];

    constructor() {
        this.twilioClient = twilio(process.env.ACCOUNT_SID || '', process.env.AUTH_TOKEN || '');

        // Get the assets path
        const currentModuleFile = fileURLToPath(import.meta.url);
        const serverSrcDir = dirname(dirname(currentModuleFile)); // Go up from services to src
        const serverDir = dirname(serverSrcDir); // Go up from src to server
        this.assetsPath = join(serverDir, 'assets');
    }

    /**
     * Scans Sync Context map for all available context keys
     * @returns Array of context keys
     */
    private async scanContextKeys(): Promise<string[]> {
        try {
            const allData = await this.getMapItem('ConversationRelay', 'Context');
            return Object.keys(allData || {});
        } catch (error) {
            logError('SyncAssetLoader', `Failed to scan context keys: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Scans Sync ToolManifest map for all available manifest keys
     * @returns Array of manifest keys
     */
    private async scanManifestKeys(): Promise<string[]> {
        try {
            const allData = await this.getMapItem('ConversationRelay', 'ToolManifest');
            return Object.keys(allData || {});
        } catch (error) {
            logError('SyncAssetLoader', `Failed to scan manifest keys: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    /**
     * Loads the server configuration from Sync document
     */
    async loadServerConfig(): Promise<ServerConfig> {
        try {
            const serverConfigData = await this.getDocument('ConversationRelay', 'serverConfig');

            if (!serverConfigData) {
                throw new Error('serverConfig document not found in Sync');
            }

            return serverConfigData;
        } catch (error) {
            logError('SyncAssetLoader', `Failed to load serverConfig: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Loads specific contexts by keys from Sync map
     * @param keys Array of context keys to load
     */
    async loadContexts(keys: string[]): Promise<Map<string, string>> {
        try {
            const contexts = new Map<string, string>();

            for (const key of keys) {
                try {
                    const value = await this.getMapItem('ConversationRelay', 'Context', key);
                    if (value) {
                        const content = typeof value === 'object' && value && 'content' in value
                            ? (value as any).content
                            : String(value || '');
                        contexts.set(key, content);
                    }
                } catch (error) {
                    logError('SyncAssetLoader', `Failed to load context ${key}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            logOut('SyncAssetLoader', `Loaded ${contexts.size} contexts from Sync`);
            return contexts;
        } catch (error) {
            logError('SyncAssetLoader', `Failed to load contexts: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Loads specific manifests by keys from Sync map
     * @param keys Array of manifest keys to load
     */
    async loadManifests(keys: string[]): Promise<Map<string, object>> {
        try {
            const manifests = new Map<string, object>();

            for (const key of keys) {
                try {
                    const value = await this.getMapItem('ConversationRelay', 'ToolManifest', key);
                    if (value) {
                        manifests.set(key, value || {});
                    }
                } catch (error) {
                    logError('SyncAssetLoader', `Failed to load manifest ${key}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            logOut('SyncAssetLoader', `Loaded ${manifests.size} manifests from Sync`);
            return manifests;
        } catch (error) {
            logError('SyncAssetLoader', `Failed to load manifests: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }


    /**
     * Ensures a Sync Service exists, creates if it doesn't
     * @returns boolean indicating if a new service was created
     */
    private async ensureService(serviceName: string): Promise<boolean> {
        try {
            // List all services and find by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const existingService = services.find(service => service.friendlyName === serviceName);

            if (existingService) {
                logOut('SyncAssetLoader', `Found existing service: ${serviceName}`);
                return false; // Service existed
            } else {
                // Service doesn't exist, create it
                await this.twilioClient.sync.v1.services.create({
                    friendlyName: serviceName
                });
                logOut('SyncAssetLoader', `Created new service: ${serviceName}`);
                return true; // New service was created
            }
        } catch (error) {
            logError('SyncAssetLoader', `Failed to ensure service ${serviceName}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Ensures a Sync Map exists within a service, creates if it doesn't
     */
    private async ensureMap(serviceName: string, mapName: string): Promise<any> {
        try {
            // Find service by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const service = services.find(s => s.friendlyName === serviceName);

            if (!service) {
                throw new Error(`Service ${serviceName} not found`);
            }

            // List all maps in the service and find by unique name
            const maps = await this.twilioClient.sync.v1.services(service.sid).syncMaps.list();
            const existingMap = maps.find(map => map.uniqueName === mapName);

            if (existingMap) {
                logOut('SyncAssetLoader', `Found existing map: ${serviceName}:${mapName}`);
                return existingMap;
            } else {
                // Map doesn't exist, create it
                const map = await this.twilioClient.sync.v1.services(service.sid).syncMaps.create({
                    uniqueName: mapName
                });
                logOut('SyncAssetLoader', `Created new map: ${serviceName}:${mapName}`);
                return map;
            }
        } catch (error) {
            logError('SyncAssetLoader', `Failed to ensure map ${serviceName}:${mapName}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Ensures a Sync Document exists for the specified service
     */
    private async ensureDocument(serviceName: string, documentName: string): Promise<boolean> {
        try {
            // Find service by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const service = services.find(s => s.friendlyName === serviceName);
            if (!service) {
                throw new Error(`Service ${serviceName} not found`);
            }

            // Check if document exists
            try {
                await this.twilioClient.sync.v1.services(service.sid)
                    .documents(documentName)
                    .fetch();
                logOut('SyncAssetLoader', `Found existing document: ${serviceName}:${documentName}`);
                return false; // Document existed
            } catch (error: any) {
                if (error.code === 20404) {
                    // Document doesn't exist, create it
                    await this.twilioClient.sync.v1.services(service.sid)
                        .documents
                        .create({
                            uniqueName: documentName,
                            data: {}
                        });
                    logOut('SyncAssetLoader', `Created new document: ${serviceName}:${documentName}`);
                    return true; // Document was created
                } else {
                    throw error;
                }
            }
        } catch (error) {
            logError('SyncAssetLoader', `Failed to ensure document ${serviceName}:${documentName}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Set item in a Sync Map - updates existing or creates new (try-update-then-create pattern)
     */
    private async setMapItem(serviceName: string, mapName: string, key: string, data: any): Promise<void> {
        // Find service by friendly name
        const services = await this.twilioClient.sync.v1.services.list();
        const service = services.find(s => s.friendlyName === serviceName);

        if (!service) {
            throw new Error(`Service ${serviceName} not found`);
        }

        // Try to update first (most common case on restart)
        try {
            await this.twilioClient.sync.v1.services(service.sid)
                .syncMaps(mapName)
                .syncMapItems(key)
                .update({
                    data: data
                });
            logOut('SyncAssetLoader', `Updated map item ${serviceName}:${mapName}:${key}`);
        } catch (error: any) {
            // Item does not exist, create it
            try {
                await this.twilioClient.sync.v1.services(service.sid)
                    .syncMaps(mapName)
                    .syncMapItems
                    .create({
                        key: key,
                        data: data
                    });
                logOut('SyncAssetLoader', `Created map item ${serviceName}:${mapName}:${key}`);
            } catch (createError: any) {
                logError('SyncAssetLoader', `Failed to create map item ${serviceName}:${mapName}:${key}: ${createError instanceof Error ? createError.message : String(createError)}`);
                throw createError;
            }
        }
    }

    /**
     * Set/Update document data in a Sync Document
     */
    private async setDocument(serviceName: string, documentName: string, data: any): Promise<void> {
        try {
            // Find service by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const service = services.find(s => s.friendlyName === serviceName);
            if (!service) {
                throw new Error(`Service ${serviceName} not found`);
            }

            await this.twilioClient.sync.v1.services(service.sid)
                .documents(documentName)
                .update({
                    data: data
                });
            logOut('SyncAssetLoader', `Updated document ${serviceName}:${documentName}`);
        } catch (error) {
            logError('SyncAssetLoader', `Failed to set document ${serviceName}:${documentName}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Loads an asset file from the assets directory
     */
    private async loadAssetFile(filename: string): Promise<string | object | null> {
        try {
            const assetPath = join(this.assetsPath, filename);
            const content = await fs.readFile(assetPath, 'utf-8');

            // If it's a JSON file, parse it
            if (filename.endsWith('.json')) {
                return JSON.parse(content);
            }

            logOut('SyncAssetLoader', `Loaded asset file: ${filename}`);
            return content;
        } catch (error) {
            logError('SyncAssetLoader', `Failed to load asset file ${filename}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Get document data from a Sync Document (copied from TwilioSyncService)
     */
    private async getDocument(serviceName: string, documentName: string): Promise<any> {
        try {
            // Find service by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const service = services.find(s => s.friendlyName === serviceName);
            if (!service) {
                throw new Error(`Service ${serviceName} not found`);
            }

            const document = await this.twilioClient.sync.v1.services(service.sid)
                .documents(documentName)
                .fetch();
            return document.data;
        } catch (error: any) {
            if (error.code === 20404) {
                return null; // Document doesn't exist
            }
            logError('SyncAssetLoader', `Failed to get document ${serviceName}:${documentName}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Get item(s) from a Sync Map (copied from TwilioSyncService)
     */
    private async getMapItem(serviceName: string, mapName: string, key?: string): Promise<any> {
        try {
            // Find service by friendly name
            const services = await this.twilioClient.sync.v1.services.list();
            const service = services.find(s => s.friendlyName === serviceName);

            if (!service) {
                throw new Error(`Service ${serviceName} not found`);
            }

            if (key) {
                // Get specific item
                try {
                    const item = await this.twilioClient.sync.v1.services(service.sid)
                        .syncMaps(mapName)
                        .syncMapItems(key)
                        .fetch();
                    return item.data;
                } catch (error: any) {
                    if (error.code === 20404) {
                        return null; // Item doesn't exist
                    }
                    throw error;
                }
            } else {
                // Get all items
                const items = await this.twilioClient.sync.v1.services(service.sid)
                    .syncMaps(mapName)
                    .syncMapItems
                    .list();

                const result: Record<string, any> = {};
                items.forEach(item => {
                    result[item.key] = item.data;
                });
                return result;
            }
        } catch (error) {
            logError('SyncAssetLoader', `Failed to get map item ${serviceName}:${mapName}:${key || 'all'}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Initializes Sync services, maps, documents and loads assets from local files
     * Should be called before loading assets to ensure Sync infrastructure exists
     */
    async initialize(): Promise<void> {
        try {
            logOut('SyncAssetLoader', 'Initializing Sync Services, Maps, and Documents');

            // Ensure all services exist
            for (const serviceDef of this.SERVICE_DEFINITIONS) {
                await this.ensureService(serviceDef.name);
            }

            // Ensure all maps exist
            for (const serviceDef of this.SERVICE_DEFINITIONS) {
                for (const mapName of serviceDef.maps) {
                    await this.ensureMap(serviceDef.name, mapName);
                }
            }

            // Ensure all documents exist
            for (const serviceDef of this.SERVICE_DEFINITIONS) {
                if (serviceDef.documents) {
                    for (const docName of serviceDef.documents) {
                        await this.ensureDocument(serviceDef.name, docName);
                    }
                }
            }

            // Scan and load all assets from local files
            await this.scanAndLoadAssets();

            logOut('SyncAssetLoader', 'Initialization complete - services, maps, documents created and local assets loaded');
        } catch (error) {
            logError('SyncAssetLoader', `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    /**
     * Scans assets directory and loads all found files into Sync
     */
    private async scanAndLoadAssets(): Promise<void> {
        try {
            logOut('SyncAssetLoader', 'Scanning assets directory and loading files to Sync');

            // Load serverConfig.json if it exists
            const serverConfig = await this.loadAssetFile('serverConfig.json');
            if (serverConfig) {
                await this.setDocument('ConversationRelay', 'serverConfig', serverConfig);
                logOut('SyncAssetLoader', 'Loaded serverConfig.json into serverConfig document');
            }

            // Scan for all files in assets directory
            const files = await fs.readdir(this.assetsPath);

            // Load all .md files into Context map
            const contextFiles = files.filter(file => file.endsWith('.md'));
            for (const file of contextFiles) {
                const content = await this.loadAssetFile(file);
                if (content) {
                    const key = file.replace('.md', '');
                    // Wrap string content in JSON object for Sync compatibility
                    await this.setMapItem('ConversationRelay', 'Context', key, { content });
                    logOut('SyncAssetLoader', `Loaded ${file} into Context map as ${key}`);
                }
            }

            // Load all .json files (except serverConfig.json) into ToolManifest map
            const manifestFiles = files.filter(file => file.endsWith('.json') && file !== 'serverConfig.json');
            for (const file of manifestFiles) {
                const content = await this.loadAssetFile(file);
                if (content) {
                    const key = file.replace('.json', '');
                    await this.setMapItem('ConversationRelay', 'ToolManifest', key, content as object);
                    logOut('SyncAssetLoader', `Loaded ${file} into ToolManifest map as ${key}`);
                }
            }

            logOut('SyncAssetLoader', `Asset scan complete: ${contextFiles.length} contexts, ${manifestFiles.length} manifests${serverConfig ? ', 1 serverConfig' : ''}`);
        } catch (error) {
            logError('SyncAssetLoader', `Failed to scan and load assets: ${error instanceof Error ? error.message : String(error)}`);
            // Don't throw - service creation should still succeed even if asset loading fails
        }
    }
}