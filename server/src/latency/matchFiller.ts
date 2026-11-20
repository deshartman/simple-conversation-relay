/**
 * Match the caller's utterance to a filler phrase, per the current latency mode.
 * Never throws: any failure is logged and returns null (no filler).
 *
 * `score` is cosine similarity (embedding) or the chosen option's Jev probability (jev).
 */
import { getMode, type LatencyMode } from './mode.js';
import { loadFillers, fillerDocuments, fillerById, type Filler } from './fillers.js';
import { embed, cosine } from './embeddings.js';
import { jevEvaluate } from './jev.js';
import { logOut, logError } from '../utils/logger.js';

export interface FillerMatch { filler: Filler; score: number; mode: LatencyMode; ms: number }

const JEV_TIMEOUT_MS = 600;
const NO_FILLER = 'none';

const num = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) ? n : fallback;
};

// Bank of every filler document, embedded once per process.
let bank: Promise<{ vectors: number[][]; owner: Filler[] }> | undefined;

function loadBank() {
    bank ??= (async () => {
        const owner: Filler[] = [];
        const docs: string[] = [];
        for (const f of loadFillers()) for (const d of fillerDocuments(f)) { docs.push(d); owner.push(f); }
        return { vectors: (await embed(docs, 'document')).vectors, owner };
    })().catch((e) => { bank = undefined; throw e; });
    return bank;
}

/** Fire-and-forget: pre-embed the filler bank so the first call doesn't pay for it. */
export function warmFillerBank(): void {
    loadBank().then(
        () => logOut('Latency', 'Filler bank embedded'),
        (e) => logError('Latency', `Filler bank warm-up failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}

async function byEmbedding(text: string): Promise<{ filler: Filler; score: number } | null> {
    const { vectors, owner } = await loadBank();
    const q = (await embed([text], 'query')).vectors[0];
    let best: { filler: Filler; score: number } | null = null;
    vectors.forEach((v, i) => {
        const s = cosine(q, v);
        if (!best || s > best.score) best = { filler: owner[i], score: s };
    });
    return best && (best as { score: number }).score >= num('LATENCY_EMBED_THRESHOLD', 0.6) ? best : null;
}

async function byJev(text: string): Promise<{ filler: Filler; score: number } | null> {
    const criteria: Record<string, unknown> = {};
    for (const f of loadFillers()) criteria[f.id] = { what: f.when, examples: f.examples };
    criteria[NO_FILLER] = { what: 'None of the other options fits what the caller said.' };
    const r = await jevEvaluate(
        text,
        { filler: { type: 'choice', instructions: 'Which option best describes what the caller just said?', criteria } },
        JEV_TIMEOUT_MS,
    );
    if (!r.ok) throw new Error(r.error);
    const a = r.answers.filler;
    const filler = a?.choice === NO_FILLER ? undefined : fillerById(a?.choice);
    const score = Number(a?.probabilities?.[a?.choice]);
    return filler && score >= num('LATENCY_JEV_THRESHOLD', 0.5) ? { filler, score } : null;
}

export async function matchFiller(text: string, signal?: AbortSignal): Promise<FillerMatch | null> {
    const mode = getMode();
    if (mode === 'none') return null;
    const t0 = performance.now();
    try {
        const hit = await (mode === 'embedding' ? byEmbedding(text) : byJev(text));
        if (signal?.aborted || !hit) return null;
        return { ...hit, mode, ms: performance.now() - t0 };
    } catch (e) {
        logError('Latency', `matchFiller (${mode}) failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
