/**
 * OpenAIResponseService Tests
 *
 * Tests for OpenAIResponseService initialization with ServerConfig.
 *
 * NOTE: `tsconfig.json` scopes type-checking to `src/**`, and vitest strips
 * types without checking them, so nothing here is type-checked at build time.
 * These tests therefore assert on observable state rather than merely calling
 * the constructor — a `toBeDefined()`-only test passes even when the call
 * signature is wrong, which is exactly how the v4.12 signature change went
 * unnoticed on this file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponseService } from '../../../src/services/OpenAIResponseService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';

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
    let registry: ToolRegistry;

    beforeEach(() => {
        // Clear environment variables
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_MODEL;
        registry = new ToolRegistry();
    });

    describe('Constructor with ServerConfig', () => {
        it('should take the model from config', () => {
            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(mockContext, registry, config);

            expect(service).toBeDefined();
            expect((service as any).model).toBe('gpt-4-turbo');
        });

        it('should use config model over environment variable', () => {
            process.env.OPENAI_MODEL = 'gpt-3.5-turbo';

            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(mockContext, registry, config);

            expect((service as any).model).toBe('gpt-4-turbo');
        });

        it('should store the supplied context as instructions', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(mockContext, registry, config);

            expect((service as any).instructions).toBe(mockContext);
        });

        it('should retain the supplied tool registry', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(mockContext, registry, config);

            expect((service as any).registry).toBe(registry);
        });

        /**
         * BUG-1 regression guard.
         *
         * Listen mode is owned solely by `ConversationRelaySession`, which is
         * the only writer to the WebSocket. A second copy of the flag here
         * could not be updated at runtime (there was no setter), so toggling
         * listen mode off left this one stuck `true` and every text delta was
         * silently discarded — the agent went permanently mute.
         */
        it('should NOT hold any independent listenMode state', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(mockContext, registry, config);

            expect('listenMode' in (service as any)).toBe(false);
            expect((service as any).listenMode).toBeUndefined();
            expect((service as any).setListenMode).toBeUndefined();
        });

        it('should accept exactly three constructor arguments', () => {
            // Guards against silently reintroducing the removed `listenMode`
            // parameter, which type-checking will not catch in this file.
            expect(OpenAIResponseService.length).toBe(3);
        });
    });

    describe('Service with different configurations', () => {
        it('should create multiple services with independent models', () => {
            const config1 = ServerConfig.forTesting({ openaiModel: 'gpt-4o' });
            const config2 = ServerConfig.forTesting({ openaiModel: 'gpt-4-turbo' });

            const service1 = new OpenAIResponseService(mockContext, registry, config1);
            const service2 = new OpenAIResponseService(mockContext, registry, config2);

            expect((service1 as any).model).toBe('gpt-4o');
            expect((service2 as any).model).toBe('gpt-4-turbo');
        });

        it('should handle an empty tool registry', () => {
            const config = ServerConfig.forTesting();
            const emptyRegistry = new ToolRegistry();

            const service = new OpenAIResponseService(mockContext, emptyRegistry, config);

            expect(service).toBeDefined();
            expect((service as any).registry.size()).toBe(0);
        });
    });
});
