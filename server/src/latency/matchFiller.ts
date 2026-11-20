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
export type MissReason = 'catch-all' | 'below-threshold' | 'no-match' | 'timeout' | 'error';

const JEV_TIMEOUT_MS = 600;
// The explicit out inside the Jev question: always pick something, this is the safe default.
const CATCH_ALL = 'generic-ack';

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

type Candidate = { filler: Filler; score: number; min: number };

async function byEmbedding(text: string): Promise<Candidate | null> {
    const { vectors, owner } = await loadBank();
    const q = (await embed([text], 'query')).vectors[0];
    let best: { filler: Filler; score: number } | null = null;
    vectors.forEach((v, i) => {
        const s = cosine(q, v);
        if (!best || s > best.score) best = { filler: owner[i], score: s };
    });
    return best && { ...(best as { filler: Filler; score: number }), min: num('LATENCY_EMBED_THRESHOLD', 0.6) };
}

async function byJev(text: string): Promise<Candidate | null> {
    const criteria: Record<string, unknown> = {};
    for (const f of loadFillers()) criteria[f.id] = { what: f.when, examples: f.examples };
    criteria[CATCH_ALL] = {
        what: 'Use this when no other option clearly fits. It is the safe default for anything unclear, unusual, off-topic or ambiguous.',
    };
    const r = await jevEvaluate(
        text,
        { filler: { type: 'choice', instructions: 'Which option best describes what the caller just said?', criteria } },
        JEV_TIMEOUT_MS,
    );
    if (!r.ok) throw new Error(r.error);
    const a = r.answers.filler;
    const filler = a?.choice === CATCH_ALL ? undefined : fillerById(a?.choice);
    const score = Number(a?.probabilities?.[a?.choice]);
    return filler ? { filler, score, min: num('LATENCY_JEV_THRESHOLD', 0.5) } : null;
}

/** `onMiss` is told why a null was returned, so the caller can log it and fall back. */
export async function matchFiller(text: string, signal?: AbortSignal, onMiss?: (r: MissReason) => void): Promise<FillerMatch | null> {
    const mode = getMode();
    if (mode === 'none') return null;
    const t0 = performance.now();
    try {
        const hit = await (mode === 'embedding' ? byEmbedding(text) : byJev(text));
        if (signal?.aborted) { onMiss?.('no-match'); return null; }
        if (!hit) { onMiss?.(mode === 'jev' ? 'catch-all' : 'no-match'); return null; }
        if (hit.score < hit.min) { onMiss?.('below-threshold'); return null; }
        return { filler: hit.filler, score: hit.score, mode, ms: performance.now() - t0 };
    } catch (e) {
        logError('Latency', `matchFiller (${mode}) failed: ${e instanceof Error ? e.message : String(e)}`);
        onMiss?.('error');
        return null;
    }
}
