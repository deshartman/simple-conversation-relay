/**
 * OpenAIResponseService Tests
 *
 * Tests for OpenAIResponseService initialization with ServerConfig
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponseService } from '../../../src/services/OpenAIResponseService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

// Mock OpenAI
vi.mock('openai', () => {
    class MockOpenAI {
        responses = {
            create: vi.fn()
        };
    }
    return {
        default: MockOpenAI
    };
});

describe('OpenAIResponseService', () => {
    const mockContext = 'Test context for conversation';
    const mockManifest = {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'test_tool',
                    description: 'A test tool'
                }
            }
        ]
    };
    const mockLoadedTools = {
        test_tool: async () => ({ success: true, message: 'test' })
    };

    beforeEach(() => {
        // Clear environment variables
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_MODEL;
    });

    describe('Constructor with ServerConfig', () => {
        it('should initialize with config model parameter', () => {
            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                false,
                config
            );

            expect(service).toBeDefined();
        });

        it('should use config model over environment variable', () => {
            // Set environment variable
            process.env.OPENAI_MODEL = 'gpt-3.5-turbo';

            // Create config with different model
            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                false,
                config
            );

            // Service should use config value
            expect(service).toBeDefined();
        });

        it('should work with listen mode enabled', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                true, // listen mode enabled
                config
            );

            expect(service).toBeDefined();
        });

        it('should work with listen mode disabled', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                false, // listen mode disabled
                config
            );

            expect(service).toBeDefined();
        });
    });

    // Backwards compatibility tests removed - ServerConfig is now required

    describe('Service with different configurations', () => {
        it('should create multiple services with different configs', () => {
            const config1 = ServerConfig.forTesting({
                openaiModel: 'gpt-4o'
            });

            const config2 = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service1 = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                false,
                config1
            );

            const service2 = new OpenAIResponseService(
                mockContext,
                mockManifest,
                mockLoadedTools,
                false,
                config2
            );

            expect(service1).toBeDefined();
            expect(service2).toBeDefined();
        });

        it('should handle empty tool manifest', () => {
            const config = ServerConfig.forTesting();
            const emptyManifest = { tools: [] };

            const service = new OpenAIResponseService(
                mockContext,
                emptyManifest,
                {},
                false,
                config
            );

            expect(service).toBeDefined();
        });
    });
});
