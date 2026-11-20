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
export type MissReason = 'catch-all' | 'below-threshold' | 'low-margin' | 'no-match' | 'timeout' | 'error';
export type ScoreBy = 'max' | 'when-only' | 'mean-top2';
export const SCORE_BYS: readonly ScoreBy[] = ['max', 'when-only', 'mean-top2'];

/** Per-call overrides (offline eval); each defaults to its env var, then to current behaviour. */
export interface MatchOptions { fillersPath?: string; threshold?: number; margin?: number; scoreBy?: ScoreBy }

const JEV_TIMEOUT_MS = 600;
// The explicit out inside the Jev question: always pick something, this is the safe default.
const CATCH_ALL = 'generic-ack';

const num = (name: string, fallback: number): number => {
    const n = Number(process.env[name]);
    return process.env[name] && Number.isFinite(n) ? n : fallback;
};

// Bank of every filler document, embedded once per process per dictionary ('' = default).
const banks = new Map<string, Promise<{ vectors: number[][]; owner: Filler[]; first: boolean[] }>>();

function loadBank(path?: string) {
    const key = path ?? process.env.FILLERS_PATH ?? '';
    let b = banks.get(key);
    if (!b) {
        b = (async () => {
            const owner: Filler[] = [];
            const first: boolean[] = [];
            const docs: string[] = [];
            for (const f of loadFillers(path)) fillerDocuments(f).forEach((d, i) => { docs.push(d); owner.push(f); first.push(i === 0); });
            return { vectors: (await embed(docs, 'document')).vectors, owner, first };
        })().catch((e) => { banks.delete(key); throw e; });
        banks.set(key, b);
    }
    return b;
}

/** Fire-and-forget: pre-embed the filler bank so the first call doesn't pay for it. */
export function warmFillerBank(): void {
    loadBank().then(
        () => logOut('Latency', 'Filler bank embedded'),
        (e) => logError('Latency', `Filler bank warm-up failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}

/** Top-1 candidate before any gating. `filler` is undefined when Jev picked the catch-all. `margin` = top-1 minus top-2. */
export interface Ranked { filler?: Filler; score: number; margin: number }

const scoreByEnv = (): ScoreBy => (SCORE_BYS as readonly string[]).includes(process.env.LATENCY_EMBED_SCORE_BY ?? '')
    ? process.env.LATENCY_EMBED_SCORE_BY as ScoreBy : 'mean-top2';

async function rankEmbedding(text: string, o: MatchOptions): Promise<Ranked | null> {
    const { vectors, owner, first } = await loadBank(o.fillersPath);
    const q = (await embed([text], 'query')).vectors[0];
    const docs = new Map<Filler, { when: number; all: number[] }>();
    vectors.forEach((v, i) => {
        const s = cosine(q, v);
        const d = docs.get(owner[i]) ?? docs.set(owner[i], { when: -Infinity, all: [] }).get(owner[i])!;
        d.all.push(s);
        if (first[i]) d.when = s;
    });
    const by = o.scoreBy ?? scoreByEnv();
    const scored = [...docs].map(([filler, d]) => {
        const top = [...d.all].sort((x, y) => y - x);
        return { filler, score: by === 'when-only' ? d.when : by === 'mean-top2' ? (top[0] + (top[1] ?? top[0])) / 2 : top[0] };
    }).sort((x, y) => y.score - x.score);
    return scored.length ? { filler: scored[0].filler, score: scored[0].score, margin: scored[0].score - (scored[1]?.score ?? 0) } : null;
}

async function rankJev(text: string, o: MatchOptions): Promise<Ranked> {
    const fillers = loadFillers(o.fillersPath);
    const criteria: Record<string, unknown> = {};
    for (const f of fillers) criteria[f.id] = { what: f.when, examples: f.examples };
    criteria[CATCH_ALL] = {
        what: 'Use when the utterance has no request or answer that matches any other option: off-topic chatter, side talk to someone else in the room, background noise, or fragments with no request. Prefer it over any specific option that only shares a word with the utterance.',
    };
    const r = await jevEvaluate(
        text,
        { filler: { type: 'choice', instructions: 'Which option best describes what the caller just said?', criteria } },
        JEV_TIMEOUT_MS,
    );
    if (!r.ok) throw new Error(r.error);
    const a = r.answers.filler;
    const probs = Object.values<unknown>(a?.probabilities ?? {}).map(Number).sort((x, y) => y - x);
    const filler = a?.choice === CATCH_ALL ? undefined : fillerById(a?.choice, o.fillersPath);
    const score = Number(a?.probabilities?.[a?.choice]);
    return { filler, score, margin: score - (probs.find((p) => p !== score) ?? 0) };
}

/** Raw top-1 for a mode, no threshold applied. Throws on infrastructure failure. */
export function rank(mode: 'embedding' | 'jev', text: string, o: MatchOptions = {}): Promise<Ranked | null> {
    return mode === 'embedding' ? rankEmbedding(text, o) : rankJev(text, o);
}

/** Apply catch-all / threshold / margin gating. Returns the filler, or why it was a miss. */
export function gate(mode: 'embedding' | 'jev', r: Ranked | null, o: MatchOptions = {}): { filler: Filler; score: number } | MissReason {
    if (!r) return 'no-match';
    if (!r.filler || r.filler.category === 'catch-all') return 'catch-all';
    const min = o.threshold ?? num(mode === 'embedding' ? 'LATENCY_EMBED_THRESHOLD' : 'LATENCY_JEV_THRESHOLD', mode === 'embedding' ? 0.59 : 0.5);
    if (r.score < min) return 'below-threshold';
    if (r.margin < (o.margin ?? num(mode === 'embedding' ? 'LATENCY_EMBED_MARGIN' : 'LATENCY_JEV_MARGIN', mode === 'embedding' ? 0.01 : 0))) return 'low-margin';
    return { filler: r.filler, score: r.score };
}

/** `onMiss` is told why a null was returned, so the caller can log it and fall back. */
export async function matchFiller(text: string, signal?: AbortSignal, onMiss?: (r: MissReason) => void, o: MatchOptions = {}): Promise<FillerMatch | null> {
    const mode = getMode();
    if (mode === 'none') return null;
    const t0 = performance.now();
    try {
        const g = gate(mode, await rank(mode, text, o), o);
        if (signal?.aborted) { onMiss?.('no-match'); return null; }
        if (typeof g === 'string') { onMiss?.(g); return null; }
        return { filler: g.filler, score: g.score, mode, ms: performance.now() - t0 };
    } catch (e) {
        logError('Latency', `matchFiller (${mode}) failed: ${e instanceof Error ? e.message : String(e)}`);
        onMiss?.('error');
        return null;
    }
}
