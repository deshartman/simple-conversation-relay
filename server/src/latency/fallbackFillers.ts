import { opener } from './fillers.js';

/**
 * Neutral acknowledgements spoken when no topical filler is available (below threshold,
 * no match, error, or the match was too slow). Deliberately topic- and outcome-free.
 */
export const FALLBACK_FILLERS = [
    'Sure thing!',
    'Right, okay.',
    'Mm-hmm, I see.',
    'Alright, let me see.',
    'Okay, got it.',
    'Absolutely!',
    'Of course, one moment.',
    'Hmm, okay, let me see.',
] as const;

/**
 * Next fallback after `last` (the one used previously on this session): rotates, never repeats back-to-back,
 * and skips any whose opening word is in `avoid` (falls back to plain rotation if that excludes everything).
 */
export function nextFallback(last?: string, avoid: ReadonlySet<string> = new Set()): string {
    const start = last === undefined ? 0 : FALLBACK_FILLERS.indexOf(last as (typeof FALLBACK_FILLERS)[number]) + 1;
    const n = FALLBACK_FILLERS.length;
    for (let k = 0; k < n; k++) {
        const c = FALLBACK_FILLERS[(start + k) % n];
        if (!avoid.has(opener(c))) return c;
    }
    return FALLBACK_FILLERS[start % n];
}
