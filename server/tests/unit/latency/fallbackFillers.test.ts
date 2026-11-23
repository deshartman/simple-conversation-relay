import { describe, it, expect } from 'vitest';
import { nextFallback, FALLBACK_FILLERS } from '../../../src/latency/fallbackFillers.js';
import { opener } from '../../../src/latency/fillers.js';

describe('nextFallback', () => {
    it('rotates and never repeats back-to-back', () => {
        expect(nextFallback()).toBe(FALLBACK_FILLERS[0]);
        expect(nextFallback(FALLBACK_FILLERS[0])).toBe(FALLBACK_FILLERS[1]);
        expect(nextFallback(FALLBACK_FILLERS[FALLBACK_FILLERS.length - 1])).toBe(FALLBACK_FILLERS[0]);
    });

    it('skips fallbacks whose opening word was recently used', () => {
        const avoid = new Set(['okay', 'hmm']);
        let last: string | undefined;
        for (let i = 0; i < FALLBACK_FILLERS.length * 2; i++) {
            last = nextFallback(last, avoid);
            expect(avoid.has(opener(last))).toBe(false);
        }
    });

    it('falls back to plain rotation when every opener is avoided', () => {
        const all = new Set(FALLBACK_FILLERS.map(opener));
        expect(nextFallback(FALLBACK_FILLERS[0], all)).toBe(FALLBACK_FILLERS[1]);
    });
});
