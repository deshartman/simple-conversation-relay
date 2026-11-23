/**
 * Minimal Jev (TypeSafe System One) client: POST {base}/v1/systemone.
 * Uses node:https with its own keep-alive agent, because fetch's default 4s
 * keep-alive drops the socket between caller turns and re-pays TLS (the
 * reference ConversationAgent measured ~430ms/turn from this).
 * Never throws: always resolves { ok, ... }.
 */
import { Agent, request } from 'node:https';
import { logOut, logError } from '../utils/logger.js';

export type JevQuestion =
    | { type: 'noul'; instructions: string; criteria?: Record<string, unknown> }
    | { type: 'choice'; instructions: string; criteria: Record<string, unknown> };

export type JevResult =
    | { ok: true; answers: Record<string, any>; model: string; ms: number }
    | { ok: false; error: string; ms: number };

const agent = new Agent({ keepAlive: true, keepAliveMsecs: 60_000, maxSockets: 4 });

export async function jevEvaluate(
    state: string | Record<string, unknown>,
    questions: Record<string, JevQuestion>,
    timeoutMs = 1200,
): Promise<JevResult> {
    const apiKey = process.env.JEV_API_KEY;
    if (!apiKey) return { ok: false, error: 'JEV_API_KEY not set', ms: 0 };
    const url = new URL(`${(process.env.JEV_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, '')}/v1/systemone`);
    const body = JSON.stringify({ state, model: process.env.JEV_MODEL ?? 'jev-latest', questions });
    const t0 = performance.now();

    return new Promise((resolve) => {
        const fail = (error: string) => resolve({ ok: false, error, ms: performance.now() - t0 });
        const req = request(
            {
                agent, hostname: url.hostname, path: url.pathname, method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

/**
 * Open the TLS connection on the same keep-alive agent so the first real call reuses a warm socket.
 * A bodyless HEAD to the API host: no model run, not billable. Any HTTP status counts as warm.
 * Never throws; fire and forget.
 */
export function warmJev(): Promise<void> {
    const t0 = performance.now();
    const done = (note = '') => logOut('Latency', `jev warm ms=${Math.round(performance.now() - t0)}${note}`);
    return new Promise((resolve) => {
        try {
            const url = new URL((process.env.JEV_BASE_URL ?? 'https://api.typesafe.ai').replace(/\/+$/, ''));
            const req = request({ agent, hostname: url.hostname, path: '/', method: 'HEAD' }, (res) => {
                res.resume();
                res.on('end', () => { done(` status=${res.statusCode}`); resolve(); });
            });
            req.setTimeout(3000, () => req.destroy(new Error('timeout after 3000ms')));
            req.on('error', (e) => { logError('Latency', `jev warm failed: ${e.message}`); resolve(); });
            req.end();
        } catch (e) {
            logError('Latency', `jev warm failed: ${e instanceof Error ? e.message : String(e)}`);
            resolve();
        }
    });
}
