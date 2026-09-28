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

/** In-memory ContextSource: `defaultContext` plus any extra keys. */
function fakeContexts(extra: Record<string, string> = {}) {
    const all: Record<string, string> = { defaultContext: 'Test context for conversation', ...extra };
    return {
        get: vi.fn(async (key: string) => all[key] ?? null),
        getDefault: vi.fn(async () => all.defaultContext),
    };
}

describe('OpenAIResponseService', () => {
    const mockContext = 'Test context for conversation';
    let contexts: ReturnType<typeof fakeContexts>;
    let registry: ToolRegistry;

    beforeEach(() => {
        // Clear environment variables
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENAI_MODEL;
        registry = new ToolRegistry();
        contexts = fakeContexts();
    });

    describe('Constructor with ServerConfig', () => {
        it('should take the model from config', () => {
            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(contexts, registry, config);

            expect(service).toBeDefined();
            expect((service as any).model).toBe('gpt-4-turbo');
        });

        it('should use config model over environment variable', () => {
            process.env.OPENAI_MODEL = 'gpt-3.5-turbo';

            const config = ServerConfig.forTesting({
                openaiModel: 'gpt-4-turbo'
            });

            const service = new OpenAIResponseService(contexts, registry, config);

            expect((service as any).model).toBe('gpt-4-turbo');
        });

        it('should load no context until it is needed', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(contexts, registry, config);

            expect((service as any).instructions).toBeNull();
            expect(contexts.getDefault).not.toHaveBeenCalled();
        });

        it('should retain the supplied tool registry', () => {
            const config = ServerConfig.forTesting();

            const service = new OpenAIResponseService(contexts, registry, config);

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

            const service = new OpenAIResponseService(contexts, registry, config);

            expect('listenMode' in (service as any)).toBe(false);
            expect((service as any).listenMode).toBeUndefined();
            expect((service as any).setListenMode).toBeUndefined();
        });

        it('should require exactly three constructor arguments', () => {
            // Guards against silently reintroducing the removed `listenMode`
            // parameter, which type-checking will not catch in this file.
            // (The optional fourth, silenceReminders, has a default, so it
            // does not count toward `length`.)
            expect(OpenAIResponseService.length).toBe(3);
        });
    });

    describe('Service with different configurations', () => {
        it('should create multiple services with independent models', () => {
            const config1 = ServerConfig.forTesting({ openaiModel: 'gpt-4o' });
            const config2 = ServerConfig.forTesting({ openaiModel: 'gpt-4-turbo' });

            const service1 = new OpenAIResponseService(contexts, registry, config1);
            const service2 = new OpenAIResponseService(contexts, registry, config2);

            expect((service1 as any).model).toBe('gpt-4o');
            expect((service2 as any).model).toBe('gpt-4-turbo');
        });

        it('should handle an empty tool registry', () => {
            const config = ServerConfig.forTesting();
            const emptyRegistry = new ToolRegistry();

            const service = new OpenAIResponseService(contexts, emptyRegistry, config);

            expect(service).toBeDefined();
            expect((service as any).registry.size()).toBe(0);
        });
    });

    describe('handleEvent (service owns the prompt)', () => {
        const config = () => ServerConfig.forTesting();
        const withCampaign = () => fakeContexts({ campaign: 'Campaign context' });

        it('appends the call details on setup, as the transport used to', async () => {
            const service = new OpenAIResponseService(withCampaign(), registry, config());
            await service.handleEvent({ type: 'setup', setup: { callSid: 'CA1' }, parameters: { requestData: {} } });

            const instructions = (service as any).instructions as string;
            expect(instructions.startsWith(mockContext)).toBe(true);
            expect(instructions).toContain('These are all the details of the call');
            expect(instructions).toContain('"callSid": "CA1"');
        });

        it('swaps to the contextKey context before adding call details', async () => {
            const service = new OpenAIResponseService(withCampaign(), registry, config());
            await service.handleEvent({
                type: 'setup',
                setup: { callSid: 'CA1', customParameters: { contextKey: 'campaign' } },
                parameters: {},
            });

            expect((service as any).instructions.startsWith('Campaign context')).toBe(true);
        });

        it('keeps the default context when the contextKey is unknown', async () => {
            const service = new OpenAIResponseService(withCampaign(), registry, config());
            await service.handleEvent({
                type: 'setup',
                setup: { callSid: 'CA1', customParameters: { contextKey: 'nope' } },
                parameters: {},
            });

            expect((service as any).instructions.startsWith(mockContext)).toBe(true);
        });

        it('adds a status event to the instructions', async () => {
            const service = new OpenAIResponseService(contexts, registry, config());
            await service.handleEvent({ type: 'status', status: { callStatus: 'no-answer' } });

            expect((service as any).instructions).toContain('"callStatus":"no-answer"');
        });

        it('routes prompt and interrupt events to generateResponse and interrupt', async () => {
            const service = new OpenAIResponseService(contexts, registry, config());
            const gen = vi.spyOn(service, 'generateResponse').mockResolvedValue();
            const intr = vi.spyOn(service, 'interrupt');

            await service.handleEvent({ type: 'prompt', text: 'hello' });
            await service.handleEvent({ type: 'interrupt', heard: 'Hel' });

            expect(gen).toHaveBeenCalledWith('user', 'hello');
            expect(intr).toHaveBeenCalledOnce();
        });

        it('loads the default context once, on first use', async () => {
            const service = new OpenAIResponseService(contexts, registry, config());
            await service.handleEvent({ type: 'status', status: { a: 1 } });
            await service.handleEvent({ type: 'status', status: { b: 2 } });

            expect(contexts.getDefault).toHaveBeenCalledOnce();
            expect((service as any).instructions.startsWith(mockContext)).toBe(true);
        });

        it('does not load the default when setup supplies a known contextKey', async () => {
            const campaign = withCampaign();
            const service = new OpenAIResponseService(campaign, registry, config());
            await service.handleEvent({
                type: 'setup',
                setup: { callSid: 'CA1', customParameters: { contextKey: 'campaign' } },
                parameters: {},
            });

            expect(campaign.getDefault).not.toHaveBeenCalled();
        });

        describe('silence', () => {
            const REMINDERS = ['Still there?', 'Just checking you are still there?'];

            function withHandler() {
                const service = new OpenAIResponseService(contexts, registry, config(), REMINDERS);
                const out: any[] = [];
                service.createResponseHandler({
                    content: r => out.push({ content: r.token, last: r.last }),
                    toolResult: e => out.push({ tool: e.toolType, frame: e.toolData.outgoingMessage }),
                    error: () => {},
                    callSid: () => {},
                });
                return { service, out };
            }

            it('speaks the configured reminders on breaches 1 and 2', async () => {
                const { service, out } = withHandler();
                await service.handleEvent({ type: 'silence', count: 1 });
                await service.handleEvent({ type: 'silence', count: 2 });

                expect(out).toEqual([
                    { content: 'Still there?', last: true },
                    { content: 'Just checking you are still there?', last: true },
                ]);
            });

            it('ends the call as unresponsive on the breach after the last reminder', async () => {
                const { service, out } = withHandler();
                await service.handleEvent({ type: 'silence', count: 3 });

                expect(out[0].tool).toBe('silence');
                expect(out[0].frame.type).toBe('end');
                expect(JSON.parse(out[0].frame.handoffData)).toEqual({
                    reasonCode: 'unresponsive',
                    reason: 'The caller was not speaking',
                });
                // The last:true that releases the deferred end frame.
                expect(out[1]).toEqual({ content: '', last: true });
            });

            it('does nothing after the call has been ended', async () => {
                const { service, out } = withHandler();
                await service.handleEvent({ type: 'silence', count: 4 });

                expect(out).toEqual([]);
            });

            it('with no reminders configured, ends on the first breach', async () => {
                const service = new OpenAIResponseService(contexts, registry, config());
                const tools: string[] = [];
                service.createResponseHandler({
                    content: () => {},
                    toolResult: e => tools.push(e.toolType),
                    error: () => {},
                    callSid: () => {},
                });
                await service.handleEvent({ type: 'silence', count: 1 });

                expect(tools).toEqual(['silence']);
            });
        });
    });
});
