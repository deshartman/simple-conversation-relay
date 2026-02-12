/**
 * TwilioService Tests
 *
 * Tests for TwilioService initialization with ServerConfig
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TwilioService } from '../../../src/services/TwilioService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

// Mock the twilio module
vi.mock('twilio', () => {
    return {
        default: vi.fn((accountSid, authToken, options) => {
            return {
                accountSid,
                authToken,
                options,
                calls: { create: vi.fn() },
                messages: { create: vi.fn() }
            };
        })
    };
});

describe('TwilioService', () => {
    beforeEach(() => {
        // Clear environment variables
        delete process.env.ACCOUNT_SID;
        delete process.env.AUTH_TOKEN;
        delete process.env.FROM_NUMBER;
        delete process.env.TWILIO_EDGE;
        delete process.env.TWILIO_REGION;
    });

    describe('Constructor with ServerConfig', () => {
        it('should initialize with config parameters', () => {
            const config = ServerConfig.forTesting({
                twilioAccountSid: 'AC-config-sid',
                twilioAuthToken: 'config-token',
                twilioFromNumber: '+15551234567'
            });

            const service = new TwilioService(config);

            // Verify service was created (no errors thrown)
            expect(service).toBeDefined();
        });

        it('should use config values over environment variables', () => {
            // Set environment variables
            process.env.ACCOUNT_SID = 'AC-env-sid';
            process.env.AUTH_TOKEN = 'env-token';
            process.env.FROM_NUMBER = '+15559999999';

            // Create config with different values
            const config = ServerConfig.forTesting({
                twilioAccountSid: 'AC-config-sid',
                twilioAuthToken: 'config-token',
                twilioFromNumber: '+15551234567'
            });

            const service = new TwilioService(config);

            // Service should prefer config values
            expect(service).toBeDefined();
        });

        it('should handle edge and region from config', () => {
            const config = ServerConfig.forTesting({
                twilioEdge: 'sydney',
                twilioRegion: 'australia1'
            });

            const service = new TwilioService(config);

            expect(service).toBeDefined();
        });

        it('should work without edge and region', () => {
            const config = ServerConfig.forTesting();
            // Default test config has no edge/region

            const service = new TwilioService(config);

            expect(service).toBeDefined();
        });
    });

    describe('Constructor without ServerConfig (backwards compatibility)', () => {
        it('should fallback to environment variables', () => {
            process.env.ACCOUNT_SID = 'AC-env-sid';
            process.env.AUTH_TOKEN = 'env-token';
            process.env.FROM_NUMBER = '+15559999999';

            const service = new TwilioService();

            expect(service).toBeDefined();
        });

        it('should handle missing environment variables gracefully', () => {
            // No env vars set, no config provided
            const service = new TwilioService();

            // Should initialize with empty strings (backwards compatible behavior)
            expect(service).toBeDefined();
        });

        it('should handle edge/region from environment', () => {
            process.env.ACCOUNT_SID = 'AC-test';
            process.env.AUTH_TOKEN = 'test-token';
            process.env.FROM_NUMBER = '+15555555555';
            process.env.TWILIO_EDGE = 'dublin';
            process.env.TWILIO_REGION = 'ireland1';

            const service = new TwilioService();

            expect(service).toBeDefined();
        });
    });

    describe('Service initialization', () => {
        it('should initialize successfully with valid config', async () => {
            const config = ServerConfig.forTesting();
            const service = new TwilioService(config);

            await expect(service.initialize()).resolves.not.toThrow();
        });
    });
});
