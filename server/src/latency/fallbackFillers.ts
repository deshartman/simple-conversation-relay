/**
 * Neutral acknowledgements spoken when no topical filler is available (below threshold,
 * no match, error, or the match was too slow). Deliberately topic- and outcome-free.
 */
export const FALLBACK_FILLERS = ['Okay.', 'Mm-hmm.', 'Right.', 'Hmm, okay.', 'I see.', 'Sure.', 'Okay, got it.', 'Alright.'] as const;

/** Next fallback after `last` (the one used previously on this session): rotates, never repeats back-to-back. */
export function nextFallback(last?: string): string {
    const i = last === undefined ? -1 : FALLBACK_FILLERS.indexOf(last as (typeof FALLBACK_FILLERS)[number]);
    return FALLBACK_FILLERS[(i + 1) % FALLBACK_FILLERS.length];
}
