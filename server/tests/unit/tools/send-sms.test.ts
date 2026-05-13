/**
 * send-sms Tool Tests
 *
 * Tests for the send-sms tool factory and execution.
 * v4.12: factory returns a `ConversationRelayTool` record; tests call
 * `tool.handler(args, session)` instead of `tool(args, responseService)`.
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

import twilio from 'twilio';

// A minimal session stand-in. send-sms doesn't touch the session, so an empty
// object satisfies the handler signature at runtime.
const stubSession = {} as any;

describe('send-sms Tool', () => {
    let testConfig: ServerConfig;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCreate.mockReset();

        testConfig = ServerConfig.forTesting({
            twilioAccountSid: 'AC-test-sid',
            twilioAuthToken: 'test-token',
            twilioFromNumber: '+15551234567'
        });
    });

    describe('Factory Pattern', () => {
        it('should create a tool record with handler and schema', () => {
            const tool = createSendSMSTool(testConfig);

            expect(tool).toBeDefined();
            expect(tool.name).toBe('send-sms');
            expect(typeof tool.handler).toBe('function');
            expect(tool.parameters).toBeDefined();
            expect(typeof tool.toOpenAIFormat).toBe('function');
        });

        it('should capture config in closure', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            await tool.handler({ to: '+15559999999', message: 'Test SMS' }, stubSession);

            expect(twilio).toHaveBeenCalledWith('AC-test-sid', 'test-token');
        });

        it('should not access process.env', async () => {
            process.env.ACCOUNT_SID = 'AC-env-sid';
            process.env.AUTH_TOKEN = 'env-token';
            process.env.FROM_NUMBER = '+15550000000';

            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            await tool.handler({ to: '+15559999999', message: 'Test SMS' }, stubSession);

            expect(twilio).toHaveBeenCalledWith('AC-test-sid', 'test-token');
            expect(mockCreate).toHaveBeenCalledWith({
                body: 'Test SMS',
                from: '+15551234567',
                to: '+15559999999'
            });

            delete process.env.ACCOUNT_SID;
            delete process.env.AUTH_TOKEN;
            delete process.env.FROM_NUMBER;
        });
    });

    describe('SMS Sending', () => {
        it('should send SMS with correct parameters', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            const result = await tool.handler(
                { to: '+15559999999', message: 'Hello from test' },
                stubSession
            );

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

        it('should accept extra properties from LLM', async () => {
            mockCreate.mockResolvedValue({ sid: 'SM123456' });

            const tool = createSendSMSTool(testConfig);

            const result = await tool.handler(
                {
                    to: '+15559999999',
                    message: 'Test',
                    extraProperty: 'should be ignored',
                    anotherExtra: 123
                } as any,
                stubSession
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Error Handling', () => {
        it('should handle Twilio API errors gracefully', async () => {
            mockCreate.mockRejectedValue(new Error('Invalid phone number'));

            const tool = createSendSMSTool(testConfig);

            const result = await tool.handler({ to: 'invalid', message: 'Test' }, stubSession);

            expect(result).toEqual({
                success: false,
                message: 'SMS send failed: Invalid phone number'
            });
        });

        it('should handle non-Error exceptions', async () => {
            mockCreate.mockRejectedValue('String error');

            const tool = createSendSMSTool(testConfig);

            const result = await tool.handler(
                { to: '+15559999999', message: 'Test' },
                stubSession
            );

            expect(result.success).toBe(false);
            expect(result.message).toContain('SMS send failed: String error');
        });

        it('should handle network errors', async () => {
            mockCreate.mockRejectedValue(new Error('Network timeout'));

            const tool = createSendSMSTool(testConfig);

            const result = await tool.handler(
                { to: '+15559999999', message: 'Test' },
                stubSession
            );

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

            await tool.handler({ to: '+15559999999', message: 'First' }, stubSession);
            await tool.handler({ to: '+15558888888', message: 'Second' }, stubSession);

            expect(twilio).toHaveBeenCalledTimes(2);
        });
    });
});
