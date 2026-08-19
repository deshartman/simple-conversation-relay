/**
 * OpenAIResponseService — stream handling
 *
 * Two defects observed on live outbound calls, both pre-existing since v4.12:
 *
 *   1. Double speech. `processStream()` recurses on every tool call, and each
 *      follow-up stream may emit text. When the model spoke AND called
 *      `end-call` in one response, the follow-up produced a second farewell and
 *      the caller heard the goodbye twice.
 *
 *   2. Interleaved speech. `generateResponse()` had no concurrency guard, so two
 *      prompts arriving close together started two independent streams feeding
 *      the same handler — their tokens interleaved mid-sentence on the wire.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponseService } from '../../../src/services/OpenAIResponseService.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';
import { defineTool } from '../../../src/tools/define-tool.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('openai', () => {
    class MockOpenAI {
        responses = { create: (...args: any[]) => createMock(...args) };
    }
    return { default: MockOpenAI };
});

/** Minimal async-iterable stand-in for an OpenAI streaming response. */
function fakeStream(events: any[]) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
    };
}

const toolCallEvents = (name: string) => [
    {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: '{}' },
    },
    { type: 'response.function_call_arguments.done' },
    { type: 'response.completed' },
];

const textEvents = (...tokens: string[]) => [
    ...tokens.map(t => ({ type: 'response.output_text.delta', delta: t })),
    { type: 'response.completed' },
];

function makeService(registry: ToolRegistry) {
    const service = new OpenAIResponseService('ctx', registry, ServerConfig.forTesting());
    const tokens: string[] = [];
    const lastFlags: boolean[] = [];
    service.createResponseHandler({
        content: r => {
            if (r.token) tokens.push(r.token);
            lastFlags.push(r.last);
        },
        toolResult: () => {},
        error: () => {},
        callSid: () => {},
    });
    return { service, tokens, lastFlags };
}

const terminalTool = defineTool<any, any>({
    name: 'end-call',
    description: 'ends the call',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => ({
        success: true,
        message: 'Call ended successfully',
        outgoingMessage: { type: 'end', handoffData: '{}' },
    }),
});

const plainTool = defineTool<any, any>({
    name: 'set-listen-mode',
    description: 'toggles listen mode',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => ({ success: true, message: 'ok', listenMode: false }),
});

describe('OpenAIResponseService — stream handling', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        createMock.mockReset();
        registry = new ToolRegistry();
        registry.register(terminalTool as any).register(plainTool as any);
    });

    describe('terminal tools do not trigger a follow-up generation', () => {
        it('does not generate again after a tool that ends the call', async () => {
            createMock.mockReturnValueOnce(fakeStream(toolCallEvents('end-call')));
            const { service } = makeService(registry);

            await service.generateResponse('user', 'goodbye');

            // One create for the original response; no follow-up.
            expect(createMock).toHaveBeenCalledTimes(1);
        });

        it('still emits a final token so the deferred end frame can flush', async () => {
            createMock.mockReturnValueOnce(fakeStream(toolCallEvents('end-call')));
            const { service, lastFlags } = makeService(registry);

            await service.generateResponse('user', 'goodbye');

            // The session defers the terminal frame until the last text token —
            // without this the call would never hang up.
            expect(lastFlags).toContain(true);
        });

        it('does not speak a second farewell after the model already spoke', async () => {
            // Model speaks AND calls end-call in the same response — the exact
            // shape seen on call CA0668e8..., which produced two greetings.
            createMock.mockReturnValueOnce(
                fakeStream([
                    { type: 'response.output_text.delta', delta: 'Goodbye.' },
                    ...toolCallEvents('end-call'),
                ])
            );
            const { service, tokens } = makeService(registry);

            await service.generateResponse('user', 'bye');

            expect(tokens.filter(Boolean)).toEqual(['Goodbye.']);
            expect(createMock).toHaveBeenCalledTimes(1);
        });

        it('DOES generate a follow-up after a non-terminal tool', async () => {
            createMock
                .mockReturnValueOnce(fakeStream(toolCallEvents('set-listen-mode')))
                .mockReturnValueOnce(fakeStream(textEvents('Hello ', 'there.')));
            const { service, tokens } = makeService(registry);

            await service.generateResponse('user', 'hello');

            // The follow-up is how a tool-then-speak turn produces its speech.
            expect(createMock).toHaveBeenCalledTimes(2);
            expect(tokens.join('')).toBe('Hello there.');
        });
    });

    describe('cancel-previous concurrency guard', () => {
        it('abandons an in-flight stream when a newer prompt arrives', async () => {
            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            // Resolves once the consumer has actually handled the first token,
            // so the second prompt is issued mid-stream rather than racing a
            // fixed number of microticks.
            let firstEmitted!: () => void;
            const emitted = new Promise<void>(resolve => {
                firstEmitted = resolve;
            });

            const slowStream = {
                async *[Symbol.asyncIterator]() {
                    yield { type: 'response.output_text.delta', delta: 'stale-first' };
                    firstEmitted();
                    await gate;
                    yield { type: 'response.output_text.delta', delta: 'stale-second' };
                    yield { type: 'response.completed' };
                },
            };

            createMock
                .mockReturnValueOnce(slowStream)
                .mockReturnValueOnce(fakeStream(textEvents('fresh')));

            const { service, tokens } = makeService(registry);

            const first = service.generateResponse('user', 'first prompt');
            await emitted; // 'stale-first' has now reached the handler
            const second = service.generateResponse('user', 'second prompt');
            await second;
            release();
            await first;

            expect(tokens).toContain('stale-first'); // emitted before supersession
            expect(tokens).toContain('fresh');
            // The whole point: the stale stream must not resume mid-sentence
            // alongside the newer response.
            expect(tokens).not.toContain('stale-second');
        });

        it('lets a single stream run to completion when nothing supersedes it', async () => {
            createMock.mockReturnValueOnce(fakeStream(textEvents('one ', 'two ', 'three')));
            const { service, tokens } = makeService(registry);

            await service.generateResponse('user', 'hello');

            expect(tokens.join('')).toBe('one two three');
        });
    });
});
