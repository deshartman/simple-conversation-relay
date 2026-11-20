/**
 * Offline eval of the filler matcher: no server, no WebSocket, no OpenAI.
 * npx tsx scripts/eval/eval-match.mts --set scripts/eval/dev.json --mode embedding|jev [--fillers <path>]
 *   [--threshold N] [--margin N] [--score-by max|when-only|mean-top2] [--concurrency N] [--out <path>]
 * See README.md. Needs local Ollama (embedding) or JEV_API_KEY in server/.env (jev, billable).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { rank, gate, SCORE_BYS, type Ranked, type ScoreBy, type MatchOptions } from '../../src/latency/matchFiller.js';
import { loadFillers } from '../../src/latency/fillers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
    options: {
        set: { type: 'string' }, mode: { type: 'string' }, fillers: { type: 'string' },
        threshold: { type: 'string' }, margin: { type: 'string' }, 'score-by': { type: 'string' },
        concurrency: { type: 'string', default: '4' }, out: { type: 'string' },
    },
});
const die = (m: string): never => { console.error(m); process.exit(1); };
if (!a.set) die('--set <phrases.json> is required');
if (a.mode !== 'embedding' && a.mode !== 'jev') die('--mode must be embedding or jev');
const mode = a.mode as 'embedding' | 'jev';
if (a['score-by'] && !(SCORE_BYS as readonly string[]).includes(a['score-by'])) die(`--score-by must be one of ${SCORE_BYS.join('|')}`);
if (a['score-by'] && mode === 'jev') die('--score-by applies to embedding mode only');

interface Phrase { text: string; expectCategory?: string; acceptCategories?: string[]; ambiguous?: boolean; expectFallback?: boolean }
const raw = JSON.parse(readFileSync(a.set!, 'utf8'));
const phrases: Phrase[] = Array.isArray(raw) ? raw : raw.phrases;
if (!Array.isArray(phrases)) die('phrase file must be an array or {phrases:[...]}');
phrases.forEach((p, i) => {
    if (typeof p?.text !== 'string' || !p.text.trim()) die(`phrase[${i}]: text required`);
    if (!p.expectCategory && !p.acceptCategories?.length && !p.expectFallback) die(`phrase[${i}] (${p.text}): needs expectCategory, acceptCategories or expectFallback`);
});

const fillersPath = a.fillers ? path.resolve(a.fillers) : undefined;
const fillers = loadFillers(fillersPath); // validates the dictionary before any call
const categories = new Set(fillers.map((f) => f.category));
phrases.forEach((p) => [p.expectCategory, ...(p.acceptCategories ?? [])].forEach((c) => {
    if (c && !categories.has(c)) console.warn(`warning: category "${c}" (phrase "${p.text}") is not in the dictionary`);
}));
const opts: MatchOptions = {
    fillersPath,
    threshold: a.threshold !== undefined ? Number(a.threshold) : undefined,
    margin: a.margin !== undefined ? Number(a.margin) : undefined,
    scoreBy: a['score-by'] as ScoreBy | undefined,
};
const concurrency = Math.max(1, Number(a.concurrency) || 4);
const effThreshold = opts.threshold ?? (Number(process.env[mode === 'embedding' ? 'LATENCY_EMBED_THRESHOLD' : 'LATENCY_JEV_THRESHOLD']) || (mode === 'embedding' ? 0.6 : 0.5));
const effMargin = opts.margin ?? (Number(process.env[mode === 'embedding' ? 'LATENCY_EMBED_MARGIN' : 'LATENCY_JEV_MARGIN']) || 0);

console.log(
    mode === 'jev'
        ? `Jev mode: ${phrases.length} billable Jev call(s), concurrency ${concurrency}`
        : `Embedding mode: ${phrases.length} query embedding call(s) + 1 bank embed + 1 warm-up (local Ollama), concurrency ${concurrency}`,
);

type Outcome = 'correct' | 'wrong' | 'fallback';
const accepted = (p: Phrase, cat: string) => (p.acceptCategories ?? []).includes(cat) || p.expectCategory === cat;
/** Outcome for a phrase given whether it matched and the matched category. */
const judge = (p: Phrase, matched: boolean, cat?: string): Outcome =>
    p.expectFallback ? (matched ? 'wrong' : 'correct') : !matched ? 'fallback' : accepted(p, cat!) ? 'correct' : 'wrong';

interface Row {
    text: string; expected: string[]; ambiguous: boolean; expectFallback: boolean;
    top1Id: string | null; top1Category: string | null; top1CatchAll: boolean; score: number | null; margin: number | null;
    matchedId: string | null; matchedCategory: string | null; missReason: string | null;
    outcome: Outcome; ms: number; error?: string;
}
const pctile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

function isCatchAll(r: Ranked | null) { return !r || !r.filler || r.filler.category === 'catch-all'; }

async function run(p: Phrase): Promise<Row> {
    const t0 = performance.now();
    let r: Ranked | null = null, error: string | undefined;
    try { r = await rank(mode, p.text, opts); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const ms = performance.now() - t0;
    const g = error ? 'error' : gate(mode, r, opts);
    const hit = typeof g === 'string' ? null : g;
    return {
        text: p.text, expected: [...new Set([p.expectCategory, ...(p.acceptCategories ?? [])].filter(Boolean) as string[])],
        ambiguous: !!p.ambiguous, expectFallback: !!p.expectFallback,
        top1Id: r?.filler?.id ?? null, top1Category: r?.filler?.category ?? null, top1CatchAll: isCatchAll(r),
        score: r3(r?.score ?? null), margin: r3(r?.margin ?? null),
        matchedId: hit?.filler.id ?? null, matchedCategory: hit?.filler.category ?? null,
        missReason: typeof g === 'string' ? g : null, outcome: judge(p, !!hit, hit?.filler.category), ms: r3(ms)!, error,
    };
}

if (mode === 'embedding') await rank('embedding', 'warm up', opts).catch((e) => die(`Ollama embedding failed: ${e instanceof Error ? e.message : e}`));
const rows: Row[] = new Array(phrases.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, phrases.length) }, async () => {
    while (next < phrases.length) { const i = next++; rows[i] = await run(phrases[i]); }
}));

function aggregate(rs: Row[]) {
    const n = rs.length, c = rs.filter((r) => r.outcome === 'correct'), w = rs.filter((r) => r.outcome === 'wrong'), f = rs.filter((r) => r.outcome === 'fallback');
    const matches = rs.filter((r) => r.matchedId).length;
    const ms = rs.map((r) => r.ms);
    return {
        total: n, correct: c.length, wrong: w.length, fallback: f.length, errors: rs.filter((r) => r.error).length,
        correctRate: r3(c.length / n), wrongRate: r3(w.length / n), fallbackRate: r3(f.length / n),
        matches, wrongMatchRateAmongMatches: matches ? r3(w.filter((r) => r.matchedId).length / matches) : null,
        usefulRate: r3(c.length / n), p50Ms: r3(pctile(ms, 0.5)), p95Ms: r3(pctile(ms, 0.95)),
    };
}

/** Re-judge every stored top-1 under (threshold, margin), no model calls. Row.expected/expectFallback drive the verdict. */
function sweep(thresholds: number[], margins: number[]) {
    const out: { threshold: number; margin: number; correct: number; wrong: number; fallback: number; usefulRate: number; wrongMatchRateAmongMatches: number | null }[] = [];
    for (const m of margins) for (const t of thresholds) {
        let c = 0, w = 0, f = 0, matches = 0, wm = 0;
        rows.forEach((r) => {
            const matched = !r.error && !r.top1CatchAll && r.score !== null && !(r.score < t) && (r.margin ?? 0) >= m;
            const p = { text: '', acceptCategories: r.expected, expectFallback: r.expectFallback };
            const o = judge(p, matched, r.top1Category ?? undefined);
            if (matched) { matches++; if (o === 'wrong') wm++; }
            o === 'correct' ? c++ : o === 'wrong' ? w++ : f++;
        });
        out.push({ threshold: r3(t)!, margin: m, correct: c, wrong: w, fallback: f, usefulRate: r3(c / rows.length)!, wrongMatchRateAmongMatches: matches ? r3(wm / matches) : null });
    }
    return out;
}
const range = (lo: number, hi: number, step: number) => Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);
const sweepRows = mode === 'embedding' ? sweep(range(0.5, 0.8, 0.02), [0, 0.02, 0.04]) : sweep(range(0.3, 0.95, 0.05), [0, 0.1, 0.2]);

const result = {
    mode, set: path.resolve(a.set!), fillers: fillersPath ?? process.env.FILLERS_PATH ?? 'bundled', fillerCount: fillers.length,
    params: { threshold: effThreshold, margin: effMargin, scoreBy: mode === 'embedding' ? opts.scoreBy ?? process.env.LATENCY_EMBED_SCORE_BY ?? 'max' : null },
    ranAt: new Date().toISOString(),
    aggregate: aggregate(rows),
    aggregateExcludingAmbiguous: aggregate(rows.filter((r) => !r.ambiguous)),
    sweep: sweepRows,
    phrases: rows,
};
const outPath = a.out ?? path.join(here, 'out', `eval-${mode}-${path.basename(a.set!, '.json')}-${result.ranAt.replace(/[:.]/g, '-')}.json`);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

const pc = (x: number | null) => (x === null ? '  -  ' : `${(x * 100).toFixed(1)}%`.padStart(5));
const show = (label: string, g: ReturnType<typeof aggregate>) =>
    console.log(`${label.padEnd(20)} n=${g.total} correct=${g.correct} wrong=${g.wrong} fallback=${g.fallback} errors=${g.errors} | useful=${pc(g.usefulRate)} wrong-among-matches=${pc(g.wrongMatchRateAmongMatches)} fallback=${pc(g.fallbackRate)} | p50=${g.p50Ms}ms p95=${g.p95Ms}ms`);
console.log(`\nmode=${mode} threshold=${effThreshold} margin=${effMargin} scoreBy=${result.params.scoreBy ?? '-'} fillers=${result.fillers} (${fillers.length})`);
show('all', result.aggregate);
show('excl. ambiguous', result.aggregateExcludingAmbiguous);
console.log('\nWrong matches:');
rows.filter((r) => r.outcome === 'wrong').forEach((r) => console.log(`  [${r.score}/${r.margin}] "${r.text}" -> ${r.matchedCategory} (${r.matchedId}); want ${r.expectFallback ? 'fallback' : r.expected.join('|')}`));
console.log('\nMissed (fallback) phrases:');
rows.filter((r) => r.outcome === 'fallback').forEach((r) => console.log(`  [${r.score}/${r.margin}] "${r.text}" ${r.missReason}${r.error ? ' ' + r.error : ''}; top1=${r.top1Category ?? 'catch-all'}; want ${r.expected.join('|')}`));
console.log('\nSweep (correct/wrong/fallback, useful%, wrong-among-matches%):');
console.log('margin thresh  C   W   F  useful  wrongAmongMatches');
sweepRows.forEach((s) => console.log(`${String(s.margin).padEnd(6)} ${s.threshold.toFixed(2)}  ${String(s.correct).padStart(3)} ${String(s.wrong).padStart(3)} ${String(s.fallback).padStart(3)}  ${pc(s.usefulRate)}  ${pc(s.wrongMatchRateAmongMatches)}`));
console.log(`\nWrote ${outPath}`);
