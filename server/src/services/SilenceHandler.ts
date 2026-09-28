/**
 * SilenceHandler — the silence *timer* for one ConversationRelaySession.
 *
 * Measures silence and reports each breach; it has no wording and never ends
 * the call itself. The session applies the policy on each breach: speak
 * reminder n (wording from the ResponseService or config), then end the call
 * once the reminders are used up.
 *
 * Uses a `setTimeout` chain rather than a `setInterval` poll. While the caller
 * stays silent, `onBreach(n)` fires every `secondsThreshold` seconds with
 * n = 1, 2, 3, … until `reset()` (signal of life), `setEnabled(false)` or
 * `stop()`.
 */

import { logOut } from '../utils/logger.js';

interface SilenceDetectionConfig {
    enabled: boolean;
    secondsThreshold: number;
    /**
     * Default reminder wording, one per reminder; its length is the number of
     * reminders before the call is ended. A ResponseService may supply its own
     * words per reminder via `silenceReminder()`.
     */
    messages: string[];
}

interface SilenceTimerOptions {
    enabled: boolean;
    secondsThreshold: number;
    /** Called on each consecutive breach; `count` restarts at 1 after `reset()`. */
    onBreach: (count: number) => void;
}

class SilenceHandler {
    private readonly opts: SilenceTimerOptions;
    private timer: NodeJS.Timeout | null = null;
    private breachCount = 0;
    private enabled: boolean;

    constructor(opts: SilenceTimerOptions) {
        this.opts = opts;
        this.enabled = opts.enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Start (or restart) the timer. No-op if disabled. */
    start(): void {
        this.reset();
        logOut('Silence', `Silence monitor started (enabled=${this.enabled})`);
    }

    /** Reset the timer on signal-of-life. Also restarts the breach count. */
    reset(): void {
        this.clearTimer();
        this.breachCount = 0;
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
        this.breachCount = 0;
    }

    private scheduleNext(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.enabled) return;

            this.breachCount += 1;
            logOut('Silence', `Silence breach ${this.breachCount} (${this.opts.secondsThreshold}s)`);
            this.opts.onBreach(this.breachCount);
            // The breach handler may have toggled or stopped the timer.
            if (this.enabled && this.timer === null) {
                this.scheduleNext();
            }
        }, this.opts.secondsThreshold * 1000);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

export { SilenceHandler, SilenceDetectionConfig };
