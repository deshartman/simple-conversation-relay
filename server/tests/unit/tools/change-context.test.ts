/**
 * change-context Tool Tests
 *
 * Tests for the change-context tool factory and execution.
 * v4.12:
 *  - factory returns a `ConversationRelayTool` record; invoke via `.handler`.
 *  - handler's 2nd arg is a `ConversationRelaySession` (not a response
 *    service directly); the session proxies `insertMessage`/`updateContext`.
 *  - v4.12 drops per-leg tool manifests, so `getAssetsForContextSwitch`
 *    returns `{ context }` only (no `manifest`) and the handler no longer
 *    calls `session.updateTools`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChangeContextTool } from '../../../src/tools/change-context.js';

interface MockCachedAssetsService {
    getAssetsForContextSwitch: ReturnType<typeof vi.fn>;
}

interface MockSession {
    insertMessage: ReturnType<typeof vi.fn>;
    updateContext: ReturnType<typeof vi.fn>;
}

describe('change-context Tool', () => {
    let mockCachedAssetsService: MockCachedAssetsService;
    let mockSession: MockSession;

    beforeEach(() => {
        mockCachedAssetsService = {
            getAssetsForContextSwitch: vi.fn(),
        };

        mockSession = {
            insertMessage: vi.fn().mockResolvedValue(undefined),
            updateContext: vi.fn().mockResolvedValue(undefined),
        };
    });

    describe('Factory Pattern', () => {
        it('should create a tool record with handler and schema', () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            expect(tool).toBeDefined();
            expect(tool.name).toBe('change-context');
            expect(typeof tool.handler).toBe('function');
        });

        it('should capture cachedAssetsService in closure', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockSession as any
            );

            expect(mockCachedAssetsService.getAssetsForContextSwitch).toHaveBeenCalledWith(
                'test-context'
            );
        });
    });

    describe('Parameter Validation', () => {
        it('should require newContext parameter', async () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                { newContext: '', handoffSummary: 'Test summary' } as any,
                mockSession as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('newContext parameter is required');
            expect(mockCachedAssetsService.getAssetsForContextSwitch).not.toHaveBeenCalled();
        });

        it('should require handoffSummary parameter', async () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: '' } as any,
                mockSession as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('handoffSummary parameter is required');
            expect(mockCachedAssetsService.getAssetsForContextSwitch).not.toHaveBeenCalled();
        });

        it('should accept valid parameters', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockSession as any
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Context Switching', () => {
        it('should retrieve assets from cachedAssetsService', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool.handler(
                { newContext: 'support-context', handoffSummary: 'Escalating to support' },
                mockSession as any
            );

            expect(mockCachedAssetsService.getAssetsForContextSwitch).toHaveBeenCalledWith(
                'support-context'
            );
        });

        it('should call session methods in correct order', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test handoff' },
                mockSession as any
            );

            expect(mockSession.insertMessage).toHaveBeenCalledWith(
                'system',
                'Context handoff summary: Test handoff'
            );
            expect(mockSession.updateContext).toHaveBeenCalledWith('new context content');
        });

        it('should return success response with context details', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                {
                    newContext: 'billing-context',
                    handoffSummary: 'Customer has billing question',
                },
                mockSession as any
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
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(null);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                { newContext: 'nonexistent-context', handoffSummary: 'Test' },
                mockSession as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('not found in cache');
            expect(result.newContext).toBe('nonexistent-context');
        });

        it('should handle errors during context switch', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });
            mockSession.updateContext.mockRejectedValue(new Error('Update failed'));

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                { newContext: 'test-context', handoffSummary: 'Test' },
                mockSession as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Context switch failed');
            expect(result.message).toContain('Update failed');
        });

        it('should accept extra properties from LLM', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue({
                context: 'new context content',
            });

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool.handler(
                {
                    newContext: 'test-context',
                    handoffSummary: 'Test',
                    extraProperty: 'should be ignored',
                } as any,
                mockSession as any
            );

            expect(result.success).toBe(true);
        });
    });
});
