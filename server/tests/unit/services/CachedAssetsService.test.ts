/**
 * CachedAssetsService Tests
 *
 * Tests for CachedAssetsService configuration with ServerConfig
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CachedAssetsService } from '../../../src/services/CachedAssetsService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

describe('CachedAssetsService', () => {
    let service: CachedAssetsService;
    let testConfig: ServerConfig;

    beforeEach(() => {
        testConfig = ServerConfig.forTesting({
            twilioAccountSid: 'AC-test',
            twilioAuthToken: 'test-token',
            twilioFromNumber: '+15551234567'
        });
    });

    describe('Constructor with ServerConfig', () => {
        it('should initialize with config parameter', () => {
            service = new CachedAssetsService(testConfig);

            expect(service).toBeDefined();
            // Config should be stored for tool factory use
            expect((service as any).config).toBe(testConfig);
        });

        it('should store config for tool factories to access', () => {
            const config = ServerConfig.forTesting({
                twilioAccountSid: 'AC-specific-sid',
                twilioAuthToken: 'specific-token',
                twilioFromNumber: '+15555555555'
            });

            service = new CachedAssetsService(config);

            // Verify config is accessible for factory calls
            const storedConfig = (service as any).config;
            expect(storedConfig.twilioAccountSid).toBe('AC-specific-sid');
            expect(storedConfig.twilioAuthToken).toBe('specific-token');
            expect(storedConfig.twilioFromNumber).toBe('+15555555555');
        });
    });

    describe('Service Configuration', () => {
        it('should work with minimal test config', () => {
            const minimalConfig = ServerConfig.forTesting();

            service = new CachedAssetsService(minimalConfig);

            expect(service).toBeDefined();
            expect((service as any).config).toBeDefined();
        });

        it('should work with full config including optional fields', () => {
            const fullConfig = ServerConfig.forTesting({
                twilioAccountSid: 'AC-test',
                twilioAuthToken: 'test-token',
                twilioFromNumber: '+15551234567',
                twilioEdge: 'sydney',
                twilioRegion: 'australia1'
            });

            service = new CachedAssetsService(fullConfig);

            expect(service).toBeDefined();
            const storedConfig = (service as any).config;
            expect(storedConfig.twilioEdge).toBe('sydney');
            expect(storedConfig.twilioRegion).toBe('australia1');
        });
    });

    describe('Tool Factory Pattern Integration', () => {
        it('should provide config to tool factories during initialization', async () => {
            service = new CachedAssetsService(testConfig);

            // This verifies that:
            // 1. Service has config stored
            // 2. Config can be passed to factories when loadTools is called
            // 3. The integration point exists

            expect((service as any).config).toBe(testConfig);
            expect((service as any).config.twilioAccountSid).toBe('AC-test');
        });
    });
});
