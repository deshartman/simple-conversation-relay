/**
 * Offline eval of the coherence classifier: no server, no WebSocket, no OpenAI.
 * npx tsx scripts/eval/eval-coherence.mts [--set scripts/eval/coherence.json] --mode embedding|jev [--concurrency N] [--out <path>]
 * Needs local Ollama (embedding) or JEV_API_KEY in server/.env (jev, billable: one call per phrase).
 * Phrase: { text, expect, context?: string[] } where expect is question|statement|filler|changed-mind.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { classifyCoherence, COHERENCE_CLASSES, type CoherenceClass } from '../../src/latency/coherence.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({
    options: { set: { type: 'string', default: path.join(here, 'coherence.json') }, mode: { type: 'string' }, concurrency: { type: 'string', default: '4' }, out: { type: 'string' } },
});
const die = (m: string): never => { console.error(m); process.exit(1); };
if (a.mode !== 'embedding' && a.mode !== 'jev') die('--mode must be embedding or jev');
const mode = a.mode as 'embedding' | 'jev';

interface Phrase { text: string; expect: CoherenceClass; context?: string[] }
const phrases: Phrase[] = JSON.parse(readFileSync(a.set!, 'utf8'));
phrases.forEach((p, i) => {
    if (typeof p?.text !== 'string' || !p.text.trim()) die(`phrase[${i}]: text required`);
    if (!COHERENCE_CLASSES.includes(p.expect)) die(`phrase[${i}] (${p.text}): expect must be one of ${COHERENCE_CLASSES.join('|')}`);
});
const concurrency = Math.max(1, Number(a.concurrency) || 4);
console.log(mode === 'jev' ? `Jev mode: ${phrases.length} billable Jev call(s), concurrency ${concurrency}` : `Embedding mode: ${phrases.length} query embeds + 1 bank embed (local Ollama), concurrency ${concurrency}`);

interface Row { text: string; context: string[]; expect: CoherenceClass; got: CoherenceClass | null; score: number | null; ms: number; error?: string }
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

// Warm-up so the exemplar bank embed (and TLS for Jev) is not counted in the per-phrase latency.
// The first call can exceed the production timeout (model load, bank embed), so retry a few times.
for (let i = 0; ; i++) {
    try { await classifyCoherence(mode, 'warm up'); break; }
    catch (e) { if (i >= 4) die(`warm-up failed: ${e instanceof Error ? e.message : e}`); }
}

const rows: Row[] = new Array(phrases.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, phrases.length) }, async () => {
    while (next < phrases.length) {
        const i = next++, p = phrases[i];
        const t0 = performance.now();
        try {
            const r = await classifyCoherence(mode, p.text, p.context ?? []);
            rows[i] = { text: p.text, context: p.context ?? [], expect: p.expect, got: r.cls, score: Number.isFinite(r.score) ? Math.round(r.score * 1000) / 1000 : null, ms: r1(r.ms)! };
        } catch (e) {
            rows[i] = { text: p.text, context: p.context ?? [], expect: p.expect, got: null, score: null, ms: r1(performance.now() - t0)!, error: e instanceof Error ? e.message : String(e) };
        }
    }
}));

const pc = (n: number, d: number) => `${((100 * n) / d).toFixed(0)}%`.padStart(4);
console.log(`\nmode=${mode} n=${rows.length}`);
for (const c of COHERENCE_CLASSES) {
    const rs = rows.filter((r) => r.expect === c);
    const ok = rs.filter((r) => r.got === c).length;
    console.log(`${c.padEnd(13)} ${ok}/${rs.length} ${pc(ok, rs.length)}  median=${r1(median(rs.map((r) => r.ms)))}ms`);
}
const ok = rows.filter((r) => r.got === r.expect).length;
console.log(`${'overall'.padEnd(13)} ${ok}/${rows.length} ${pc(ok, rows.length)}  median=${r1(median(rows.map((r) => r.ms)))}ms  errors=${rows.filter((r) => r.error).length}`);

console.log('\nConfusion (rows = expected, cols = got):');
const cols = [...COHERENCE_CLASSES, 'error'] as const;
console.log(''.padEnd(13) + cols.map((c) => c.padStart(13)).join(''));
for (const e of COHERENCE_CLASSES) console.log(e.padEnd(13) + cols.map((g) => String(rows.filter((r) => r.expect === e && (r.got ?? 'error') === g).length).padStart(13)).join(''));

console.log('\nMisses:');
rows.filter((r) => r.got !== r.expect).forEach((r) => console.log(`  "${r.text}"${r.context.length ? ` (after "${r.context.join(' ')}")` : ''} -> ${r.got ?? 'error'}${r.error ? ` ${r.error}` : ''}; want ${r.expect}`));

const outPath = a.out ?? path.join(here, 'out', `eval-coherence-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ mode, set: path.resolve(a.set!), rows }, null, 2));
console.log(`\nWrote ${outPath}`);
