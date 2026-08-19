#!/usr/bin/env node

/**
 * Asset Upload Utility
 *
 * Uploads asset files from @server/assets/ to Twilio Sync
 * - .md files → Context map (with content wrapper)
 * - .json files → ToolManifest map
 *
 * Usage: node scripts/upload-assets.js <filename>
 * Example: node scripts/upload-assets.js defaultContext.md
 * Example: node scripts/upload-assets.js ivrWalkToolManifest.json
 */

import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import twilio from 'twilio';
import { logOut, logError } from '../dist/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    try {
        // Load environment variables
        dotenv.config({ path: path.join(__dirname, '..', '.env') });

        // Validate command line arguments
        const inputPath = process.argv[2];
        if (!inputPath) {
            console.error('Usage: node scripts/upload-assets.js <filepath>');
            console.error('Example: node scripts/upload-assets.js /absolute/path/to/file.json');
            process.exit(1);
        }

        // Convert to absolute path
        const filePath = path.resolve(inputPath);

        // Validate file extension
        const fileExtension = path.extname(filePath).toLowerCase();
        if (fileExtension !== '.md' && fileExtension !== '.json') {
            console.error('Error: Only .md and .json files are supported');
            console.error('  .md files → Context map');
            console.error('  .json files → ToolManifest map');
            process.exit(1);
        }

        // Check if file exists
        try {
            await fs.access(filePath);
        } catch (error) {
            console.error(`Error: File not found: ${filePath}`);
            process.exit(1);
        }

        // Initialize Twilio client
        const accountSid = process.env.ACCOUNT_SID;
        const authToken = process.env.AUTH_TOKEN;

        if (!accountSid || !authToken) {
            console.error('Error: Missing Twilio credentials');
            console.error('Please set ACCOUNT_SID and AUTH_TOKEN in your .env file');
            process.exit(1);
        }

        const twilioClient = twilio(accountSid, authToken);
        const syncService = twilioClient.sync.v1.services('ConversationRelay');

        logOut('UploadAssets', `Starting upload of ${path.basename(filePath)}...`);

        // Read file content
        const fileContent = await fs.readFile(filePath, 'utf-8');

        // Extract asset name (filename without extension)
        const assetName = path.basename(filePath, fileExtension);

        if (fileExtension === '.md') {
            // Upload to Context map with content wrapper
            logOut('UploadAssets', `Uploading ${path.basename(filePath)} to Context map as '${assetName}'`);
            const syncMap = syncService.syncMaps('Context');
            await syncMap.syncMapItems(assetName).update({
                data: {
                    content: fileContent
                }
            }).catch(async () => {
                // If update fails, try create
                await syncMap.syncMapItems.create({
                    key: assetName,
                    data: {
                        content: fileContent
                    }
                });
            });
            logOut('UploadAssets', `✓ Successfully uploaded ${path.basename(filePath)} to Context map`);
            logOut('UploadAssets', `  Asset name: ${assetName}`);
            logOut('UploadAssets', `  Content length: ${fileContent.length} characters`);

        } else if (fileExtension === '.json') {
            // Parse JSON and upload to ToolManifest map
            let parsedContent;
            try {
                parsedContent = JSON.parse(fileContent);
            } catch (parseError) {
                console.error(`Error: Invalid JSON in ${path.basename(filePath)}`);
                console.error(parseError.message);
                process.exit(1);
            }

            logOut('UploadAssets', `Uploading ${path.basename(filePath)} to ToolManifest map as '${assetName}'`);
            const syncMap = syncService.syncMaps('ToolManifest');
            await syncMap.syncMapItems(assetName).update({
                data: parsedContent
            }).catch(async () => {
                // If update fails, try create
                await syncMap.syncMapItems.create({
                    key: assetName,
                    data: parsedContent
                });
            });
            logOut('UploadAssets', `✓ Successfully uploaded ${path.basename(filePath)} to ToolManifest map`);
            logOut('UploadAssets', `  Asset name: ${assetName}`);

            // Show tools count if it's a tool manifest
            if (parsedContent.tools && Array.isArray(parsedContent.tools)) {
                logOut('UploadAssets', `  Tools count: ${parsedContent.tools.length}`);
            }
        }

        logOut('UploadAssets', 'Upload completed successfully!');

    } catch (error) {
        logError('UploadAssets', `Upload failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

// Run the main function
main();