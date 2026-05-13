/**
 * SilenceHandler — progressive reminder system for silent callers.
 *
 * Uses a `setTimeout` chain rather than a `setInterval` poll: at each
 * scheduled fire-time the next reminder is sent and the next timeout is
 * scheduled. When all reminders have been spoken, the next breach fires
 * `onTerminate` (typically ending the call).
 *
 * One handler per `ConversationRelaySession`. Stateful only via scalars
 * that live and die with the session.
 *
 * == Public API ==
 * Two APIs are supported for constructing/wiring the handler:
 *
 * 1. **Legacy** (`startMonitoring(onMessage)`): kept for back-compat with
 *    callers (e.g. the /conversation HTTP endpoint) that weren't rewritten
 *    to the session model. The callback receives either a text
 *    (`{type:'text',...}`) or end (`{type:'end',...}`) message — semantics
 *    match v4.11 on the wire.
 *
 * 2. **Session-native** (`{ onReminder, onTerminate }` in config): preferred
 *    for `ConversationRelaySession`. The session wires `onReminder` to
 *    `session.sendText(reminder, true)` and `onTerminate` to
 *    `session.endCall(...)` — both of which go through session state
 *    (listen-mode gating, etc.) and observe the proper wire ordering.
 */

import { logOut } from '../utils/logger.js';

interface SilenceDetectionConfig {
    enabled: boolean;
    secondsThreshold: number;
    messages: string[];
    /** Optional: called when a reminder is due. If omitted, reminders flow through the legacy `startMonitoring(onMessage)` callback. */
    onReminder?: (reminder: string) => void;
    /** Optional: called after reminders are exhausted. If omitted, terminal flows through the legacy `startMonitoring(onMessage)` callback. */
    onTerminate?: () => void;
}

interface SilenceBreakerTextMessage {
    type: 'text';
    token: string;
    last: boolean;
}

interface EndCallMessage {
    type: 'end';
    handoffData: string;
}

type SilenceHandlerMessage = SilenceBreakerTextMessage | EndCallMessage;
type MessageCallback = (message: SilenceHandlerMessage) => void;

class SilenceHandler {
    private readonly config: SilenceDetectionConfig;
    private timer: NodeJS.Timeout | null = null;
    private reminderIndex = 0;
    private enabled = true;
    private legacyCallback: MessageCallback | null = null;

    constructor(config: SilenceDetectionConfig) {
        this.config = config;
    }

    // =========================================================================
    // Legacy API — preserved for back-compat with v4.11 call sites
    // =========================================================================

    /**
     * Legacy API. Starts monitoring and routes reminders/terminal events to
     * `onMessage` as v4.11-shaped messages. If the config provided
     * `onReminder` / `onTerminate`, those take precedence and this callback
     * is ignored.
     */
    startMonitoring(onMessage: MessageCallback): void {
        this.legacyCallback = onMessage;
        this.start();
    }

    /** Legacy API. Resets the timer and reminder index. */
    resetTimer(): void {
        this.reset();
    }

    /** Legacy API. Enable/disable monitoring. */
    set(enabled: boolean): void {
        this.setEnabled(enabled);
    }

    /** Legacy API. Stop monitoring and clear callbacks. */
    cleanup(): void {
        this.clearTimer();
        this.legacyCallback = null;
        this.reminderIndex = 0;
        logOut('Silence', 'Cleaning up silence monitor');
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    // =========================================================================
    // Session-native API
    // =========================================================================

    /** Start (or restart) the timer. No-op if disabled. */
    start(): void {
        this.clearTimer();
        this.reminderIndex = 0;
        if (this.enabled) {
            this.scheduleNext();
        }
        logOut('Silence', `Silence monitor started (enabled=${this.enabled})`);
    }

    /** Reset the timer on signal-of-life. Also resets reminder index. */
    reset(): void {
        this.clearTimer();
        this.reminderIndex = 0;
        if (this.enabled) {
            this.scheduleNext();
        }
    }

    /**
     * Enable/disable. Disabling clears the pending timeout. Enabling does
     * NOT auto-start — the caller decides when the clock restarts (typically
     * on the next signal-of-life via `reset()`).
     */
    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        if (!enabled) {
            this.clearTimer();
        }
        logOut('Silence', `Silence detection ${enabled ? 'enabled' : 'disabled'}`);
    }

    /** Stop monitoring. Use on session end. */
    stop(): void {
        this.clearTimer();
        this.reminderIndex = 0;
    }

    // =========================================================================
    // Internal
    // =========================================================================

    private scheduleNext(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.enabled) return;

            const reminder = this.config.messages[this.reminderIndex];
            if (reminder !== undefined) {
                logOut(
                    'Silence',
                    `Reminder ${this.reminderIndex + 1}/${this.config.messages.length}: "${reminder}"`
                );
                this.fireReminder(reminder);
                this.reminderIndex += 1;
                // Schedule the next breach only if we're still enabled (the
                // reminder callback may have toggled state).
                if (this.enabled && this.timer === null) {
                    this.scheduleNext();
                }
                return;
            }

            // Reminders exhausted + one more breach → terminate.
            logOut('Silence', 'Silence terminal — reminders exhausted');
            this.fireTerminate();
            this.stop();
        }, this.config.secondsThreshold * 1000);
    }

    private fireReminder(reminder: string): void {
        if (this.config.onReminder) {
            this.config.onReminder(reminder);
            return;
        }
        if (this.legacyCallback) {
            this.legacyCallback({ type: 'text', token: reminder, last: true });
        }
    }

    private fireTerminate(): void {
        if (this.config.onTerminate) {
            this.config.onTerminate();
            return;
        }
        if (this.legacyCallback) {
            this.legacyCallback({
                type: 'end',
                handoffData: JSON.stringify({
                    reasonCode: 'unresponsive',
                    reason: 'The caller was not speaking',
                }),
            });
        }
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

export { SilenceHandler, SilenceDetectionConfig };
