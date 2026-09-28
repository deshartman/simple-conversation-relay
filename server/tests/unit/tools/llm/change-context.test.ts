/**
 * change-context Tool Tests
 *
 * Tests for the change-context tool factory and execution.
 * v4.12:
 *  - factory returns a `ConversationRelayTool` record; invoke via `.handler`.
 *  - handler's 2nd arg is the response service's `ToolContext`; the tool
 *    calls `ctx.changeContext(context, summary)` and never sees the session.
 *  - v4.12 drops per-leg tool manifests, so the handler no longer calls
 *    `session.updateTools`.
 *  - Contexts come from a `ContextSource` (`get(key)` -> string | null),
 *    not from `CachedAssetsService`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChangeContextTool } from '../../../../src/tools/llm/change-context.js';

interface MockContextSource {
    get: ReturnType<typeof vi.fn>;
}

interface MockToolContext {
    changeContext: ReturnType<typeof vi.fn>;
}

describe('change-context Tool', () => {
    let mockContexts: MockContextSource;
    let mockCtx: MockToolContext;

    beforeEach(() => {
        mockContexts = {
            get: vi.fn().mockResolvedValue(null),
        };

        mockCtx = {
            changeContext: vi.fn().mockResolvedValue(undefined),
        };
    });

    describe('Factory Pattern', () => {
        it('should create a tool record with handler and schema', () => {
            const tool = createChangeContextTool(mockContexts as any);

            expect(tool).toBeDefined();
            expect(tool.name).toBe('change-context');
            expect(typeof tool.handler).toBe('function');
        });

        it('should capture the context source in closure', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockCtx as any
            );

            expect(mockContexts.get).toHaveBeenCalledWith(
                'test-context'
            );
        });
    });

    describe('Parameter Validation', () => {
        it('should require newContext parameter', async () => {
            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                { newContext: '', handoffSummary: 'Test summary' } as any,
                mockCtx as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('newContext parameter is required');
            expect(mockContexts.get).not.toHaveBeenCalled();
        });

        it('should require handoffSummary parameter', async () => {
            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: '' } as any,
                mockCtx as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('handoffSummary parameter is required');
            expect(mockContexts.get).not.toHaveBeenCalled();
        });

        it('should accept valid parameters', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockCtx as any
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Context Switching', () => {
        it('should retrieve the context from the context source', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            await tool.handler(
                { newContext: 'support-context', handoffSummary: 'Escalating to support' },
                mockCtx as any
            );

            expect(mockContexts.get).toHaveBeenCalledWith(
                'support-context'
            );
        });

        it('should hand the new context and summary to the ToolContext', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test handoff' },
                mockCtx as any
            );

            expect(mockCtx.changeContext).toHaveBeenCalledWith('new context content', 'Test handoff');
        });

        it('should return success response with context details', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                {
                    newContext: 'billing-context',
                    handoffSummary: 'Customer has billing question',
                },
                mockCtx as any
            );

            expect(result).toEqual({
                success: true,
                message: 'Successfully switched to context: billing-context',
                newContext: 'billing-context',
                handoffSummary: 'Customer has billing question',
            });
        });
    });

    describe('Error Handling', () => {
        it('should handle missing context gracefully', async () => {
            mockContexts.get.mockResolvedValue(null);

            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                { newContext: 'nonexistent-context', handoffSummary: 'Test' },
                mockCtx as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('not found');
            expect(result.newContext).toBe('nonexistent-context');
        });

        it('should handle errors during context switch', async () => {
            mockContexts.get.mockResolvedValue('new context content');
            mockCtx.changeContext.mockRejectedValue(new Error('Update failed'));

            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test' },
                mockCtx as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Context switch failed');
            expect(result.message).toContain('Update failed');
        });

        it('should accept extra properties from LLM', async () => {
            mockContexts.get.mockResolvedValue('new context content');

            const tool = createChangeContextTool(mockContexts as any);

            const result = await tool.handler(
                {
                    newContext: 'test-context',
                    handoffSummary: 'Test',
                    extraProperty: 'should be ignored',
                } as any,
                mockCtx as any
            );

            expect(result.success).toBe(true);
        });
    });
});
