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
