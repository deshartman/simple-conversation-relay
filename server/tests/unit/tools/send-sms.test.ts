/**
 * send-sms Tool Tests
 *
 * Tests for the send-sms tool factory and execution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSendSMSTool } from '../../../src/tools/send-sms.js';
import { ServerConfig } from '../../../src/config/ServerConfig.js';

// Mock the twilio module
const mockCreate = vi.fn();
vi.mock('twilio', () => {
    return {
        default: vi.fn(() => ({
            messages: {
                create: mockCreate
            }
        }))
    };
});

// Import twilio after mocking
import twilio from 'twilio';

describe('send-sms Tool', () => {
    let testConfig: ServerConfig;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        mockCreate.mockReset();

        // Create test config
        testConfig = ServerConfig.forTesting({
            twilioAccountSid: 'AC-test-sid',
            twilioAuthToken: 'test-token',
            twilioFromNumber: '+15551234567'
        });
    });

    describe('Factory Pattern', () => {
        it('should create a tool function with proper signature', () => {
            const tool = createSendSMSTool(testConfig);

            expect(tool).toBeDefined();
            expect(typeof tool).toBe('function');
            expect(tool.length).toBe(2); // Should accept 2 parameters: args, responseService (optional)
        });

        it('should capture config in closure', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            await tool({ to: '+15559999999', message: 'Test SMS' });

            // Verify twilio was initialized with config credentials (not process.env)
            expect(twilio).toHaveBeenCalledWith('AC-test-sid', 'test-token');
        });

        it('should not access process.env', async () => {
            // Set env vars that should NOT be used
            process.env.ACCOUNT_SID = 'AC-env-sid';
            process.env.AUTH_TOKEN = 'env-token';
            process.env.FROM_NUMBER = '+15550000000';

            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            await tool({ to: '+15559999999', message: 'Test SMS' });

            // Should use config, not env vars
            expect(twilio).toHaveBeenCalledWith('AC-test-sid', 'test-token');
            expect(mockCreate).toHaveBeenCalledWith({
                body: 'Test SMS',
                from: '+15551234567', // From config, not env
                to: '+15559999999'
            });

            // Clean up
            delete process.env.ACCOUNT_SID;
            delete process.env.AUTH_TOKEN;
            delete process.env.FROM_NUMBER;
        });
    });

    describe('SMS Sending', () => {
        it('should send SMS with correct parameters', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            const result = await tool({
                to: '+15559999999',
                message: 'Hello from test'
            });

            expect(mockCreate).toHaveBeenCalledWith({
                body: 'Hello from test',
                from: '+15551234567',
                to: '+15559999999'
            });

            expect(result).toEqual({
                success: true,
                message: 'SMS sent successfully',
                recipient: '+15559999999'
            });
        });

        it('should accept optional responseService parameter', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);
            const mockResponseService = { someMethod: vi.fn() };

            // Should not throw when responseService is passed
            const result = await tool(
                { to: '+15559999999', message: 'Test' },
                mockResponseService
            );

            expect(result.success).toBe(true);
        });

        it('should work without responseService parameter', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            // Should work without responseService
            const result = await tool({ to: '+15559999999', message: 'Test' });

            expect(result.success).toBe(true);
        });

        it('should accept extra properties from LLM', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            const result = await tool({
                to: '+15559999999',
                message: 'Test',
                extraProperty: 'should be ignored',
                anotherExtra: 123
            });

            expect(result.success).toBe(true);
        });
    });

    describe('Error Handling', () => {
        it('should handle Twilio API errors gracefully', async () => {
            mockCreate.mockRejectedValue(new Error('Invalid phone number'));

            const tool = createSendSMSTool(testConfig);

            const result = await tool({
                to: 'invalid',
                message: 'Test'
            });

            expect(result).toEqual({
                success: false,
                message: 'SMS send failed: Invalid phone number'
            });
        });

        it('should handle non-Error exceptions', async () => {
            mockCreate.mockRejectedValue('String error');

            const tool = createSendSMSTool(testConfig);

            const result = await tool({
                to: '+15559999999',
                message: 'Test'
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain('SMS send failed: String error');
        });

        it('should handle network errors', async () => {
            mockCreate.mockRejectedValue(new Error('Network timeout'));

            const tool = createSendSMSTool(testConfig);

            const result = await tool({
                to: '+15559999999',
                message: 'Test'
            });

            expect(result).toEqual({
                success: false,
                message: 'SMS send failed: Network timeout'
            });
        });
    });

    describe('Tool Self-Containment', () => {
        it('should create its own Twilio client on each call', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            // Call tool twice
            await tool({ to: '+15559999999', message: 'First' });
            await tool({ to: '+15558888888', message: 'Second' });

            // Twilio should be called twice (creates new client each time)
            expect(twilio).toHaveBeenCalledTimes(2);
        });
    });
});
