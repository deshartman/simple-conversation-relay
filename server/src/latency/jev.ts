/**
 * Minimal Jev (TypeSafe System One) client: POST {base}/v1/systemone. Also targets a local laya-serve (same protocol).
 * Uses node:https with its own keep-alive agent, because fetch's default 4s
 * keep-alive drops the socket between caller turns and re-pays TLS (the
 * reference ConversationAgent measured ~430ms/turn from this).
 * Never throws: always resolves { ok, ... }.
 */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { logOut, logError } from '../utils/logger.js';

export type JevQuestion =
    | { type: 'noul'; instructions: string; criteria?: Record<string, unknown> }
    | { type: 'choice'; instructions: string; criteria: Record<string, unknown> };

export type JevResult =
    | { ok: true; answers: Record<string, any>; model: string; ms: number }
    | { ok: false; error: string; ms: number };

const httpsAgent = new HttpsAgent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 4 });
const httpAgent = new HttpAgent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 4 });

/** Where a Jev-protocol server lives. Resolved per call so env is read after dotenv loads. */
interface Target { name: string; baseUrl: string; apiKey?: string; requireKey: boolean; model?: string }

const JEV = (): Target => ({
    name: 'jev', baseUrl: process.env.JEV_BASE_URL ?? 'https://api.typesafe.ai',
    apiKey: process.env.JEV_API_KEY, requireKey: true, model: process.env.JEV_MODEL ?? 'jev-latest',
});

/** Local laya-serve speaks the same /v1/systemone protocol over plain http, key optional. */
const LAYA = (): Target => ({
    name: 'laya', baseUrl: process.env.LAYA_BASE_URL ?? 'http://localhost:8000',
    apiKey: process.env.LAYA_API_KEY, requireKey: false, model: process.env.LAYA_MODEL,
});

const transport = (url: URL) => (url.protocol === 'http:' ? { agent: httpAgent, request: httpRequest } : { agent: httpsAgent, request: httpsRequest });

async function evaluate(
    t: Target,
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    timeoutMs: number,
): Promise<JevResult> {
    const apiKey = t.apiKey;
    if (t.requireKey && !apiKey) return { ok: false, error: 'JEV_API_KEY not set', ms: 0 };
    const url = new URL(`${t.baseUrl.replace(/\/+$/, '')}/v1/systemone`);
    const { agent, request } = transport(url);
    const body = JSON.stringify({ state, ...(t.model ? { model: t.model } : {}), questions });
    const t0 = performance.now();

    return new Promise((resolve) => {
        const fail = (error: string) => resolve({ ok: false, error, ms: performance.now() - t0 });
        const req = request(
            {
                agent, hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST',
                headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) return fail(`http ${res.statusCode}: ${text.slice(0, 200)}`);
                    try {
                        const j = JSON.parse(text);
                        resolve({ ok: true, answers: j.answers, model: j.model, ms: performance.now() - t0 });
                    } catch { fail(`non-JSON response: ${text.slice(0, 100)}`); }
                });
            },
        );
        req.setTimeout(timeoutMs, () => { req.destroy(); fail(`timeout after ${timeoutMs}ms`); });
        req.on('error', (e) => fail(e.message));
        req.end(body);
    });
}

export const jevEvaluate = (
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    timeoutMs = 1200,
): Promise<JevResult> => evaluate(JEV(), state, questions, timeoutMs);

export const layaEvaluate = (
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    timeoutMs = 1200,
): Promise<JevResult> => evaluate(LAYA(), state, questions, timeoutMs);

export const warmJev = (): Promise<void> => warm(JEV());

/**
 * Local laya-serve: a HEAD would not trigger the one-off MPS kernel compile (~13 s), so send one real,
 * tiny decision. Generous timeout. Never throws; fire and forget.
 */
export function warmLaya(): Promise<void> {
    const t0 = performance.now();
    return layaEvaluate('hello', { warm: { type: 'choice', instructions: 'Is this a greeting?', criteria: { yes: { what: 'a greeting' }, no: { what: 'anything else' } } } }, 30_000)
        .then((r) => logOut('Latency', `laya warm ms=${Math.round(performance.now() - t0)}${r.ok ? '' : ` failed: ${r.error}`}`));
}

/**
 * Open the connection on the same keep-alive agent so the first real call reuses a warm socket.
 * A bodyless HEAD to the API host: no model run, not billable. Any HTTP status counts as warm.
 * Never throws; fire and forget.
 */
function warm(t: Target): Promise<void> {
    const t0 = performance.now();
    const done = (note = '') => logOut('Latency', `${t.name} warm ms=${Math.round(performance.now() - t0)}${note}`);
    return new Promise((resolve) => {
        try {
            const url = new URL(t.baseUrl.replace(/\/+$/, ''));
            const { agent, request } = transport(url);
            const req = request({ agent, hostname: url.hostname, port: url.port || undefined, path: '/', method: 'HEAD' }, (res) => {
                res.resume();
                res.on('end', () => { done(` status=${res.statusCode}`); resolve(); });
            });
            req.setTimeout(3000, () => req.destroy(new Error('timeout after 3000ms')));
            req.on('error', (e) => { logError('Latency', `${t.name} warm failed: ${e.message}`); resolve(); });
            req.end();
        } catch (e) {
            logError('Latency', `${t.name} warm failed: ${e instanceof Error ? e.message : String(e)}`);
            resolve();
        }
    });
}
