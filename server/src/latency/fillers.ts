/**
 * Filler dictionary: short, safe-to-say-before-knowing-the-answer replies,
 * each with a situation description and example caller utterances for matching.
 * Data lives in fillers.json (imported so tsc copies it into dist/).
 */
import { readFileSync } from 'node:fs';
import data from './fillers.json' with { type: 'json' };

export interface Filler {
    id: string;
    category: string;
    when: string;
    examples: string[];
    say: string;
}

// One entry per dictionary: '' is the bundled fillers.json, otherwise the FILLERS_PATH file (offline eval).
const cache = new Map<string, { list: Filler[]; byId: Map<string, Filler> }>();

function validate(raw: unknown): Filler[] {
    if (!Array.isArray(raw)) throw new Error('fillers.json: expected an array');
    const seen = new Set<string>();
    raw.forEach((f, i) => {
        const where = `fillers.json[${i}]${f?.id ? ` (${f.id})` : ''}`;
        for (const k of ['id', 'category', 'when', 'say'] as const) {
            if (typeof f?.[k] !== 'string' || !f[k].trim()) throw new Error(`${where}: "${k}" must be a non-empty string`);
        }
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)) throw new Error(`${where}: id must be kebab-case`);
        if (seen.has(f.id)) throw new Error(`${where}: duplicate id`);
        seen.add(f.id);
        if (!Array.isArray(f.examples) || f.examples.length < 3 || f.examples.length > 5
            || f.examples.some((e: unknown) => typeof e !== 'string' || !e.trim())) {
            throw new Error(`${where}: "examples" must be 3-5 non-empty strings`);
        }
        const words = f.say.trim().split(/\s+/).length;
        if (words < 3 || words > 12) throw new Error(`${where}: "say" must be 3-12 words (got ${words})`);
    });
    return raw as Filler[];
}

/** Bundled dictionary, or the file at `path` (default: env FILLERS_PATH) when set. */
export function loadFillers(path: string | undefined = process.env.FILLERS_PATH || undefined): Filler[] {
    return entry(path).list;
}

function entry(path: string | undefined) {
    const key = path ?? '';
    let e = cache.get(key);
    if (!e) {
        const list = validate(path ? JSON.parse(readFileSync(path, 'utf8')) : data);
        e = { list, byId: new Map(list.map((f) => [f.id, f])) };
        cache.set(key, e);
    }
    return e;
}

/** Texts to embed for one filler: the `when` description plus each example. */
export function fillerDocuments(f: Filler): string[] {
    return [f.when, ...f.examples];
}

export function fillerById(id: string, path: string | undefined = process.env.FILLERS_PATH || undefined): Filler | undefined {
    return entry(path).byId.get(id);
}

/** Opening word of a spoken phrase, lowercased, punctuation stripped ("Okay, one moment." -> "okay"). */
export function opener(say: string): string {
    return say.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, '');
}
