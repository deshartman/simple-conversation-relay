/**
 * @class SilenceHandler
 * @description Manages silence detection and automated responses during voice conversations.
 * This class implements a sophisticated silence monitoring system that:
 * 
 * 1. Continuously monitors the duration of silence (periods without messages)
 * 2. Implements a progressive response system:
 *    - First reminder: "Still there?" after initial silence threshold
 *    - Second reminder: "Just checking you are still there?" after continued silence
 *    - Call termination: After exceeding maximum retry attempts
 * 3. Automatically resets monitoring when valid messages are received
 * 4. Provides proper cleanup of resources when monitoring ends
 * 
 * The handler uses an interval-based timer that checks every second for silence duration,
 * comparing it against configurable thresholds. When thresholds are exceeded, it triggers
 * either reminder messages or call termination through a callback system.
 * 
 * @property {number} silenceSecondsThreshold - Seconds of silence before triggering response (default: 20)
 * @property {number} silenceRetryThreshold - Maximum reminder attempts before ending call (default: 3)
 * @property {number} lastMessageTime - Timestamp of the last received message
 * @property {NodeJS.Timeout} silenceTimer - Interval timer for silence monitoring
 * @property {number} silenceRetryCount - Current count of silence reminder attempts
 * @property {Function} messageCallback - Callback function for handling silence responses
 * 
 * @example
 * // Initialize and start silence monitoring
 * const silenceHandler = new SilenceHandler();
 * 
 * silenceHandler.startMonitoring((message) => {
 *   switch(message.type) {
 *     case 'end':
 *       // Handle call termination due to silence
 *       console.log('Call ended:', message.handoffData);
 *       break;
 *     case 'text':
 *       // Handle silence reminder message
 *       console.log('Silence reminder:', message.token);
 *       break;
 *   }
 * });
 * 
 * // Reset timer when valid messages are received
 * silenceHandler.resetTimer();
 * 
 * // Cleanup resources when done
 * silenceHandler.cleanup();
 * 
 * @see Message Types:
 * - 'text': Reminder messages with progressive content
 * - 'end': Call termination message with reason data
 * - 'info': System messages (ignored for silence detection)
 * - 'prompt': Interactive prompts (resets silence timer)
 */

import { logOut, logError } from '../utils/logger.js';

/**
 * Interface for silence breaker text message
 */
interface SilenceBreakerTextMessage {
    type: 'text';
    token: string;
    last: boolean;
}

/**
 * Interface for end call message
 */
interface EndCallMessage {
    type: 'end';
    handoffData: string;
}

/**
 * Union type for all message types that can be sent by the silence handler
 */
type SilenceHandlerMessage = SilenceBreakerTextMessage | EndCallMessage;

/**
 * Type for the message callback function
 */
type MessageCallback = (message: SilenceHandlerMessage) => void;

class SilenceHandler {
    private silenceSecondsThreshold: number;
    private silenceRetryThreshold: number;
    private lastMessageTime: number | null;
    private silenceTimer: NodeJS.Timeout | null;
    private silenceRetryCount: number;
    private messageCallback: MessageCallback | null;

    /**
     * Creates a new SilenceHandler instance.
     */
    constructor() {
        this.silenceSecondsThreshold = Number(process.env.SILENCE_SECONDS_THRESHOLD) || 20;
        this.silenceRetryThreshold = Number(process.env.SILENCE_RETRY_THRESHOLD) || 3;
        this.lastMessageTime = null;
        this.silenceTimer = null;
        this.silenceRetryCount = 0;
        this.messageCallback = null;
    }

    /**
     * Creates the message to end the call due to silence.
     * 
     * @returns {EndCallMessage} Message object with end type and handoff data
     */
    createEndCallMessage(): EndCallMessage {
        return {
            type: "end",
            handoffData: JSON.stringify({
                reasonCode: "unresponsive",
                reason: "The caller was not speaking"
            })
        };
    }

    /**
     * Creates a silence breaker reminder message.
     * 
     * @returns {SilenceBreakerTextMessage} Message object with text type and reminder content
     */
    createSilenceBreakerMessage(): SilenceBreakerTextMessage {
        // Select a different silence breaker message depending how many times you have asked
        if (this.silenceRetryCount === 1) {
            return {
                type: 'text',
                token: "Still there?",
                last: true
            };
        } else {
            return {
                type: 'text',
                token: "Just checking you are still there?",
                last: true
            };
        }
    }

    /**
     * Starts monitoring for silence.
     * 
     * @param {MessageCallback} onMessage - Callback function to handle messages
     */
    startMonitoring(onMessage: MessageCallback): void {
        this.lastMessageTime = Date.now();
        this.messageCallback = onMessage;

        this.silenceTimer = setInterval(() => {
            if (this.lastMessageTime === null) return;

            const silenceTime = (Date.now() - this.lastMessageTime) / 1000; // Convert to seconds
            if (silenceTime >= this.silenceSecondsThreshold) {
                this.silenceRetryCount++;
                logOut('Silence', `SILENCE BREAKER - No messages for ${this.silenceSecondsThreshold}+ seconds (Retry count: ${this.silenceRetryCount}/${this.silenceRetryThreshold})`);

                if (this.silenceRetryCount >= this.silenceRetryThreshold) {
                    // End the call if we've exceeded the retry threshold
                    if (this.silenceTimer) {
                        clearInterval(this.silenceTimer);
                    }
                    // logOut('Silence', 'Ending call due to exceeding silence retry threshold');
                    if (this.messageCallback) {
                        this.messageCallback(this.createEndCallMessage());
                    }
                } else {
                    // Send silence breaker message
                    if (this.messageCallback) {
                        this.messageCallback(this.createSilenceBreakerMessage());
                    }
                }
                // Reset the timer after sending the message or ending the call
                this.lastMessageTime = Date.now();
            }
        }, 1000);
    }

    /**
     * Resets the silence timer when a valid message is received.
     */
    resetTimer(): void {
        if (this.lastMessageTime !== null) {
            this.lastMessageTime = Date.now();
            // Reset the retry count when we get a valid message
            this.silenceRetryCount = 0;
            // logOut('Silence', 'Timer and retry count reset');
        } else {
            // logOut('Silence', 'Message received but monitoring not yet started');
        }
    }

    /**
     * Cleans up resources by clearing the silence timer.
     */
    cleanup(): void {
        if (this.silenceTimer) {
            logOut('Silence', 'Cleaning up silence monitor');
            clearInterval(this.silenceTimer);
            this.silenceTimer = null;
            this.messageCallback = null;
        }
    }
}

export { SilenceHandler };
