/**
 * SilenceHandler Class
 *
 * Manages silence detection and response during voice conversations. This class monitors
 * the duration of silence (no messages received) and triggers appropriate responses based
 * on configurable thresholds.
 *
 * Features:
 * - Tracks duration of silence since last message
 * - Ignores info-type messages to prevent false resets
 * - Sends reminder messages when silence threshold is reached
 * - Ends call after maximum retry attempts
 * - Provides cleanup for proper resource management
 *
 * @example
 * const silenceHandler = new SilenceHandler(5, 3);
 * silenceHandler.startMonitoring((message) => {
 *   // Handle message (e.g., send to WebSocket)
 * });
 *
 * // Reset timer when valid message received
 * silenceHandler.resetTimer('prompt');
 *
 * // Cleanup when done
 * silenceHandler.cleanup();
 */
export class SilenceHandler {
  /**
   * Creates a new SilenceHandler instance.
   *
   * @param {number} silenceSecondsThreshold - Seconds of silence before triggering a reminder
   * @param {number} silenceRetryThreshold - Maximum number of reminder attempts before ending call
   */
  silenceSecondsThreshold: number;
  silenceRetryThreshold: number;
  lastMessageTime: number | null;
  silenceRetryCount: number;
  silenceTimer: NodeJS.Timeout | null;
  messageCallback: ((message: any) => void) | null;

  constructor(silenceSecondsThreshold: number, silenceRetryThreshold: number) {
    this.silenceSecondsThreshold = silenceSecondsThreshold;
    this.silenceRetryThreshold = silenceRetryThreshold;
    this.lastMessageTime = null;
    this.silenceTimer = null;
    this.silenceRetryCount = 0;
    this.messageCallback = null;
  }

  /**
   * Creates the message to end the call due to silence.
   *
   * @returns {Object} Message object with end type and handoff data
   */
  createEndCallMessage() {
    return {
      type: "end",
      handoffData: JSON.stringify({
        reasonCode: "unresponsive",
        reason: "The caller was not speaking",
      }),
    };
  }

  /**
   * Creates a silence breaker reminder message.
   *
   * @returns {Object} Message object with text type and reminder content
   */
  createSilenceBreakerMessage() {
    return {
      type: "text",
      text: "I'm sorry, I didn't catch that. Could you please repeat that?",
      final: true,
    };
  }

  /**
   * Starts monitoring for silence.
   *
   * @param {Function} onMessage - Callback function to handle messages
   */
  startMonitoring(
    onMessage: (message: { type: string; message: string }) => void
  ) {
    console.log("[Silence Monitor] Starting silence monitoring");
    this.lastMessageTime = Date.now();
    this.messageCallback = onMessage;

    this.silenceTimer = setInterval(() => {
      const silenceTime = this.lastMessageTime
        ? (Date.now() - this.lastMessageTime) / 10000
        : 0; // Convert to seconds
      console.log(
        `[Silence Monitor] Current silence duration: ${silenceTime.toFixed(
          1
        )} seconds`
      );
      if (silenceTime >= this.silenceSecondsThreshold) {
        this.silenceRetryCount++;
        console.log(
          `[Silence Monitor] SILENCE BREAKER - No messages for ${this.silenceSecondsThreshold}+ seconds (Retry count: ${this.silenceRetryCount}/${this.silenceRetryThreshold})`
        );

        if (this.silenceRetryCount >= this.silenceRetryThreshold) {
          // End the call if we've exceeded the retry threshold
          if (this.silenceTimer) {
            clearInterval(this.silenceTimer);
          }
          console.log(
            "[Silence Monitor] Ending call due to exceeding silence retry threshold"
          );
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
   * Ignores info-type messages to prevent false resets.
   *
   * @param {string} messageType - Type of message received
   */
  resetTimer(messageType: string) {
    if (this.lastMessageTime !== null && messageType !== "info") {
      this.lastMessageTime = Date.now();
      // Reset the retry count when we get a valid message
      this.silenceRetryCount = 0;
      console.log(
        `[Silence Monitor] Timer and retry count reset due to ${messageType} message`
      );
    } else if (messageType === "info") {
      console.log(
        "[Silence Monitor] Info message received - Ignoring for timer reset"
      );
    } else {
      console.log(
        "[Silence Monitor] Message received but monitoring not yet started"
      );
    }
  }

  /**
   * Cleans up resources by clearing the silence timer.
   */
  cleanup() {
    if (this.silenceTimer) {
      console.log("[Silence Monitor] Cleaning up silence monitor");
      clearInterval(this.silenceTimer);
      this.messageCallback = null;
    }
  }
}

module.exports = { SilenceHandler };
