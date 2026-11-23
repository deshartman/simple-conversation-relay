/**
 * Runtime-switchable latency mode (in-memory, per process).
 *
 * Decides how an immediate filler reply is picked:
 *   none      - stock behaviour, no filler
 *   jev       - src/latency/jev.ts
 *   embedding - src/latency/embeddings.ts
 */

export const LATENCY_MODES = ['none', 'jev', 'embedding'] as const;
export type LatencyMode = (typeof LATENCY_MODES)[number];

export function isLatencyMode(x: unknown): x is LatencyMode {
    return typeof x === 'string' && (LATENCY_MODES as readonly string[]).includes(x);
}

// Resolved lazily so LATENCY_MODE is read after dotenv has loaded.
let current: LatencyMode | undefined;

export function getMode(): LatencyMode {
    if (current === undefined) {
        const fromEnv = process.env.LATENCY_MODE;
        current = isLatencyMode(fromEnv) ? fromEnv : 'none';
    }
    return current;
}

export function setMode(m: LatencyMode): void {
    current = m;
}

export const MAX_LLM_DELAY_MS = 20000;

export function isValidDelayMs(x: unknown): x is number {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_LLM_DELAY_MS;
}

/**
 * Test-only artificial delay before the LLM call, so the hold sound gets a chance to play.
 * Default LATENCY_TEST_LLM_DELAY_MS (invalid/unset -> 0). 0 = off.
 */
let llmDelayMs: number | undefined;

export function getLlmDelayMs(): number {
    if (llmDelayMs === undefined) {
        const fromEnv = Number(process.env.LATENCY_TEST_LLM_DELAY_MS);
        llmDelayMs = isValidDelayMs(fromEnv) ? fromEnv : 0;
    }
    return llmDelayMs;
}

export function setLlmDelayMs(ms: number): void {
    llmDelayMs = ms;
}

/**
 * Handler on/off: whether the hold sound is played after the acknowledgement.
 * Default LATENCY_HANDLER: 'off' | 'false' | '0' -> off; anything else (incl. unset) -> on.
 */
let handlerEnabled: boolean | undefined;

export function isHandlerEnabled(): boolean {
    if (handlerEnabled === undefined) {
        const fromEnv = process.env.LATENCY_HANDLER?.trim().toLowerCase();
        handlerEnabled = !(fromEnv === 'off' || fromEnv === 'false' || fromEnv === '0');
    }
    return handlerEnabled;
}

export function setHandlerEnabled(b: boolean): void {
    handlerEnabled = b;
}

export const MAX_QUESTION_WAIT_MS = 10000;

export function isValidQuestionWaitMs(x: unknown): x is number {
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_QUESTION_WAIT_MS;
}

/**
 * Coherence: how long to wait for more words when a prompt looks unfinished (statement or filler).
 * Default LATENCY_QUESTION_WAIT_MS (invalid/unset -> 0). 0 = off: every prompt goes straight to the LLM.
 */
let questionWaitMs: number | undefined;

export function getQuestionWaitMs(): number {
    if (questionWaitMs === undefined) {
        const fromEnv = Number(process.env.LATENCY_QUESTION_WAIT_MS);
        questionWaitMs = isValidQuestionWaitMs(fromEnv) ? fromEnv : 0;
    }
    return questionWaitMs;
}

export function setQuestionWaitMs(ms: number): void {
    questionWaitMs = ms;
}
