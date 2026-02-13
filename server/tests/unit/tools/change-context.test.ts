/**
 * change-context Tool Tests
 *
 * Tests for the change-context tool factory and execution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createChangeContextTool } from '../../../src/tools/change-context.js';

// Mock types for dependencies
interface MockCachedAssetsService {
    getAssetsForContextSwitch: ReturnType<typeof vi.fn>;
}

interface MockOpenAIResponseService {
    insertMessage: ReturnType<typeof vi.fn>;
    updateContext: ReturnType<typeof vi.fn>;
    updateTools: ReturnType<typeof vi.fn>;
}

describe('change-context Tool', () => {
    let mockCachedAssetsService: MockCachedAssetsService;
    let mockResponseService: MockOpenAIResponseService;

    beforeEach(() => {
        // Create fresh mocks for each test
        mockCachedAssetsService = {
            getAssetsForContextSwitch: vi.fn()
        };

        mockResponseService = {
            insertMessage: vi.fn().mockResolvedValue(undefined),
            updateContext: vi.fn().mockResolvedValue(undefined),
            updateTools: vi.fn().mockResolvedValue(undefined)
        };
    });

    describe('Factory Pattern', () => {
        it('should create a tool function with proper signature', () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            expect(tool).toBeDefined();
            expect(typeof tool).toBe('function');
            expect(tool.length).toBe(2); // Should accept 2 parameters: args, responseService
        });

        it('should capture cachedAssetsService in closure', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockResponseService as any
            );

            // Verify cachedAssetsService from closure was called
            expect(mockCachedAssetsService.getAssetsForContextSwitch).toHaveBeenCalledWith('test-context');
        });
    });

    describe('Parameter Validation', () => {
        it('should require newContext parameter', async () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: '', handoffSummary: 'Test summary' } as any,
                mockResponseService as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('newContext parameter is required');
            expect(mockCachedAssetsService.getAssetsForContextSwitch).not.toHaveBeenCalled();
        });

        it('should require handoffSummary parameter', async () => {
            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: 'test-context', handoffSummary: '' } as any,
                mockResponseService as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('handoffSummary parameter is required');
            expect(mockCachedAssetsService.getAssetsForContextSwitch).not.toHaveBeenCalled();
        });

        it('should accept valid parameters', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: 'test-context', handoffSummary: 'Test summary' },
                mockResponseService as any
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Context Switching', () => {
        it('should retrieve assets from cachedAssetsService', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool(
                { newContext: 'support-context', handoffSummary: 'Escalating to support' },
                mockResponseService as any
            );

            expect(mockCachedAssetsService.getAssetsForContextSwitch).toHaveBeenCalledWith('support-context');
        });

        it('should call responseService methods in correct order', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: ['tool1', 'tool2'] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            await tool(
                { newContext: 'test-context', handoffSummary: 'Test handoff' },
                mockResponseService as any
            );

            // Verify all methods were called
            expect(mockResponseService.insertMessage).toHaveBeenCalledWith(
                'system',
                'Context handoff summary: Test handoff'
            );
            expect(mockResponseService.updateContext).toHaveBeenCalledWith('new context content');
            expect(mockResponseService.updateTools).toHaveBeenCalledWith({ tools: ['tool1', 'tool2'] });
        });

        it('should return success response with context details', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: 'billing-context', handoffSummary: 'Customer has billing question' },
                mockResponseService as any
            );

            expect(result).toEqual({
                success: true,
                message: 'Successfully switched to context: billing-context',
                newContext: 'billing-context',
                handoffSummary: 'Customer has billing question'
            });
        });
    });

    describe('Error Handling', () => {
        it('should handle missing context gracefully', async () => {
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(null);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: 'nonexistent-context', handoffSummary: 'Test' },
                mockResponseService as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('not found in cache');
            expect(result.newContext).toBe('nonexistent-context');
        });

        it('should handle errors during context switch', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);
            mockResponseService.updateContext.mockRejectedValue(new Error('Update failed'));

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            const result = await tool(
                { newContext: 'test-context', handoffSummary: 'Test' },
                mockResponseService as any
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('Context switch failed');
            expect(result.message).toContain('Update failed');
        });

        it('should accept extra properties from LLM', async () => {
            const mockAssets = {
                context: 'new context content',
                manifest: { tools: [] }
            };
            mockCachedAssetsService.getAssetsForContextSwitch.mockReturnValue(mockAssets);

            const tool = createChangeContextTool(mockCachedAssetsService as any);

            // LLM might send extra properties
            const result = await tool(
                {
                    newContext: 'test-context',
                    handoffSummary: 'Test',
                    extraProperty: 'should be ignored'
                } as any,
                mockResponseService as any
            );

            expect(result.success).toBe(true);
        });
    });
});
