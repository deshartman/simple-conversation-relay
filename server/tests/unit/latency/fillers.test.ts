/**
 * Filler dictionary — pins the shipped fillers.json against the loader's rules.
 */

import { describe, it, expect } from 'vitest';
import { loadFillers, fillerDocuments, fillerById } from '../../../src/latency/fillers.js';

describe('fillers', () => {
    const fillers = loadFillers();

    it('has at least 100 entries with unique kebab-case ids', () => {
        expect(fillers.length).toBeGreaterThanOrEqual(100);
        const ids = fillers.map((f) => f.id);
        expect(new Set(ids).size).toBe(fillers.length);
        ids.forEach((id) => expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/));
    });

    it('has non-empty fields, 3-5 examples, and 3-12 word say', () => {
        for (const f of fillers) {
            expect(f.category.trim()).not.toBe('');
            expect(f.when.trim()).not.toBe('');
            expect(f.examples.length).toBeGreaterThanOrEqual(3);
            expect(f.examples.length).toBeLessThanOrEqual(5);
            f.examples.forEach((e) => expect(e.trim()).not.toBe(''));
            const words = f.say.trim().split(/\s+/).length;
            expect(words, f.id).toBeGreaterThanOrEqual(3);
            expect(words, f.id).toBeLessThanOrEqual(12);
            expect(f.say, f.id).not.toMatch(/[<>*_#\[\]{}]/);
        }
    });

    it('has at least 4 entries in every category (12-20 categories)', () => {
        const counts = new Map<string, number>();
        fillers.forEach((f) => counts.set(f.category, (counts.get(f.category) ?? 0) + 1));
        expect(counts.size).toBeGreaterThanOrEqual(12);
        expect(counts.size).toBeLessThanOrEqual(20);
        counts.forEach((n, c) => expect(n, c).toBeGreaterThanOrEqual(4));
    });

    it('has the sensitive-tone categories', () => {
        const cats = new Set(fillers.map((f) => f.category));
        for (const c of ['distress-sensitive', 'bad-news-empathy', 'professional-direct']) expect(cats.has(c), c).toBe(true);
    });

    it('fillerDocuments returns when + examples; fillerById finds entries', () => {
        const f = fillers[0];
        expect(fillerDocuments(f)).toEqual([f.when, ...f.examples]);
        expect(fillerById(f.id)).toBe(f);
        expect(fillerById('nope')).toBeUndefined();
    });
});
