/**
 * Fake Twilio ConversationRelay client.
 * npx tsx scripts/harness/run.mts --phrases scripts/harness/phrases.json --modes none,jev,embedding,laya --host localhost:3007
 * See README.md. Reads AUTH_TOKEN from server/.env (never printed) to sign the WS upgrade.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import { FALLBACK_FILLERS } from '../../src/latency/fallbackFillers.js';
import twilio from 'twilio';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: a } = (await import('node:util')).parseArgs({
    options: {
        phrases: { type: 'string', default: path.join(here, 'phrases.json') },
        modes: { type: 'string', default: 'none' },
        host: { type: 'string', default: 'localhost:3007' },
        'settle-ms': { type: 'string', default: '4000' },
        'quiet-ms': { type: 'string', default: '700' },
        only: { type: 'string' },
        limit: { type: 'string' },
        'no-llm-wait': { type: 'boolean', default: false },
        'interrupt-after-ms': { type: 'string' },
        'log-file': { type: 'string', default: '/tmp/scr-server.log' },
    },
});

interface Phrase { text: string; expectCategory: string }
interface Filler { id: string; category: string; say: string }
const fillers: Filler[] = JSON.parse(readFileSync(path.join(here, '../../src/latency/fillers.json'), 'utf8'));
let phrases: Phrase[] = JSON.parse(readFileSync(a.phrases!, 'utf8'));
if (a.only) phrases = phrases.filter((p) => p.expectCategory === a.only);
if (a.limit) phrases = phrases.slice(0, Number(a.limit));
const modes = a.modes!.split(',').map((s) => s.trim());
const settleMs = Number(a['settle-ms']);
const quietMs = Number(a['quiet-ms']);
const noWait = a['no-llm-wait']!;
const interruptAfter = a['interrupt-after-ms'] ? Number(a['interrupt-after-ms']) : undefined;
const host = a.host!;
const authToken = process.env.AUTH_TOKEN ?? '';

const llmCalls = modes.length * phrases.length;
console.log(
    `Run: ${modes.length} mode(s) x ${phrases.length} phrase(s) = ${llmCalls} sessions; ` +
        (noWait ? 'closing after first frame (LLM call still started, ~' + llmCalls + ' OpenAI calls, partially consumed)' : `~${llmCalls} full OpenAI calls`) +
        (modes.some((m) => m !== 'none') ? `; plus jev/embedding/laya calls for ${phrases.length * modes.filter((m) => m !== 'none').length} turns` : '')
);

const wsUrl = `wss://${host}/conversation-relay`; // the URL Twilio would sign
const signature = authToken ? twilio.getExpectedTwilioSignature(authToken, wsUrl, {}) : '';

async function api(method: string, body?: unknown) {
    const r = await fetch(`http://${host}/latency/mode`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`/latency/mode ${method} -> ${r.status} ${await r.text()}`);
    return (await r.json()) as { mode: string };
}

function logSize(): number {
    try { return existsSync(a['log-file']!) ? statSync(a['log-file']!).size : 0; } catch { return 0; }
}
function logSince(offset: number): string[] {
    try {
        const size = logSize();
        if (size <= offset) return [];
        const buf = Buffer.alloc(size - offset);
        const fd = openSync(a['log-file']!, 'r');
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        return buf.toString('utf8').split('\n').filter((l) => /match|filler|latency/i.test(l)).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    } catch { return []; }
}

interface Result {
    mode: string; text: string; expectCategory: string; callSid: string;
    firstFrameMs: number | null; lastFrameMs: number | null; firstText: string | null; reply: string;
    fillerId: string | null; fillerCategory: string | null; categoryMatch: boolean | null;
    frames: number; timedOut: boolean; error?: string; serverLog: string[];
}

function runTurn(mode: string, p: Phrase): Promise<Result> {
    const callSid = 'CA' + randomUUID().replace(/-/g, '');
    const res: Result = {
        mode, text: p.text, expectCategory: p.expectCategory, callSid, firstFrameMs: null, lastFrameMs: null,
        firstText: null, reply: '', fillerId: null, fillerCategory: null, categoryMatch: null,
        frames: 0, timedOut: false, serverLog: [],
    };
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${host}/conversation-relay`, {
            headers: { 'x-twilio-signature': signature, host },
        });
        let t0 = 0, quiet: NodeJS.Timeout | undefined, done = false, logOffset = 0, sawLast = false;
        const finish = (err?: string) => {
            if (done) return;
            done = true;
            clearTimeout(settle); clearTimeout(quiet);
            if (err) res.error = err;
            res.serverLog = logSince(logOffset);
            if (res.firstText !== null) {
                const hit = fillers.filter((f) => res.firstText!.trim().startsWith(f.say.trim())).sort((x, y) => y.say.length - x.say.length)[0];
                if (hit) { res.fillerId = hit.id; res.fillerCategory = hit.category; res.categoryMatch = hit.category === p.expectCategory; }
                else if (mode !== 'none' && FALLBACK_FILLERS.some((f) => res.firstText!.trim().startsWith(f))) res.fillerId = 'fallback';
            }
            try { ws.close(); } catch { /* ignore */ }
            resolve(res);
        };
        const settle = setTimeout(() => { res.timedOut = true; finish(); }, settleMs + 5000);
        const armQuiet = () => { clearTimeout(quiet); quiet = setTimeout(() => finish(), quietMs); };
        ws.on('error', (e) => finish(e.message));
        ws.on('close', (code, reason) => { if (!done) finish(`closed ${code} ${reason}`); });
        ws.on('open', () => {
            ws.send(JSON.stringify({
                type: 'setup', sessionId: 'VX' + randomUUID().replace(/-/g, ''), callSid,
                parentCallSid: '', from: '+15555550100', to: '+15555550199', forwardedFrom: '', callerName: '',
                direction: 'inbound', callType: 'PSTN', callStatus: 'RINGING',
                accountSid: 'AC' + '0'.repeat(32), customParameters: {},
            }));
            // setup() may speak a greeting; wait for it to go quiet before prompting.
            setTimeout(() => {
                logOffset = logSize();
                res.frames = 0; res.reply = ''; res.firstText = null; sawLast = false;
                t0 = performance.now();
                ws.send(JSON.stringify({ type: 'prompt', voicePrompt: p.text, lang: 'en-US', last: true }));
                if (interruptAfter !== undefined) {
                    setTimeout(() => ws.send(JSON.stringify({ type: 'interrupt', utteranceUntilInterrupt: res.reply, durationUntilInterruptMs: interruptAfter })), interruptAfter);
                }
                clearTimeout(settle);
                setTimeout(() => { res.timedOut = true; finish(); }, settleMs);
            }, 600);
        });
        ws.on('message', (raw) => {
            if (!t0) return; // greeting frames before the prompt are ignored
            let m: any;
            try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type !== 'text') return;
            const now = performance.now() - t0;
            res.frames++;
            if (res.firstFrameMs === null) { res.firstFrameMs = now; res.firstText = m.token; }
            res.reply += m.token;
            res.lastFrameMs = now;
            if (noWait) { setTimeout(() => finish(), 150); return; }
            if (m.last) sawLast = true;
            if (sawLast) armQuiet();
        });
    });
}

const pct = (xs: number[], q: number) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const f0 = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : '-');

const results: Result[] = [];
let original: string | null = null;
let restoring = false;
const restore = async () => {
    if (restoring || original === null) return;
    restoring = true;
    try { await api('PUT', { mode: original }); console.log(`\nRestored mode: ${original}`); } catch (e) { console.error('Failed to restore mode', e); }
};
process.on('SIGINT', async () => { await restore(); process.exit(130); });

try {
    original = (await api('GET')).mode;
    console.log(`Original mode: ${original}; WS signature: ${signature ? 'signed' : 'NONE (AUTH_TOKEN not found)'}`);
    for (const mode of modes) {
        await api('PUT', { mode });
        console.log(`\n=== mode ${mode} ===`);
        for (const p of phrases) {
            const r = await runTurn(mode, p);
            results.push(r);
            console.log(
                `${f0(r.firstFrameMs ?? NaN).padStart(5)}ms ${(r.fillerId ?? '-').padEnd(20)} ${(r.fillerCategory ?? '-').padEnd(21)} exp=${p.expectCategory.padEnd(21)} ${r.categoryMatch === null ? ' ' : r.categoryMatch ? 'OK' : 'XX'} | ${p.text.slice(0, 40)} -> ${(r.firstText ?? r.error ?? '(no frame)').slice(0, 40)}`
            );
        }
    }
} finally {
    await restore();
}

console.log('\n=== Summary ===');
for (const mode of modes) {
    const rs = results.filter((r) => r.mode === mode);
    const ttf = rs.map((r) => r.firstFrameMs).filter((x): x is number => x !== null);
    const fb = rs.filter((r) => r.fillerId === 'fallback');
    const hits = rs.filter((r) => r.fillerId && r.fillerId !== 'fallback');
    const agree = hits.filter((r) => r.categoryMatch);
    console.log(
        `${mode}: n=${rs.length} frames=${ttf.length} ttf median=${f0(pct(ttf, 0.5))}ms p95=${f0(pct(ttf, 0.95))}ms ` +
            `matched filler=${hits.length} fallback=${fb.length} no frame=${rs.length - ttf.length} ` +
            `category agree (matched only)=${agree.length}/${hits.length}`
    );
    for (const r of hits.filter((x) => !x.categoryMatch)) console.log(`   mismatch: "${r.text}" expected ${r.expectCategory}, got ${r.fillerCategory} (${r.fillerId})`);
}

const outDir = path.join(here, 'out');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(path.join(outDir, `results-${stamp}.json`), JSON.stringify({ args: a, results }, null, 2));
const cols = ['mode', 'text', 'expectCategory', 'firstFrameMs', 'lastFrameMs', 'fillerId', 'fillerCategory', 'categoryMatch', 'firstText', 'reply', 'timedOut', 'error'] as const;
const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(path.join(outDir, `results-${stamp}.csv`), [cols.join(','), ...results.map((r) => cols.map((c) => esc((r as any)[c])).join(','))].join('\n'));
console.log(`\nWrote out/results-${stamp}.{json,csv}`);
