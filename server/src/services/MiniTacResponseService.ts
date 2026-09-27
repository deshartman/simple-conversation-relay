/**
 * MiniTacResponseService — ResponseService backed by a MINI-TAC agent over HTTP.
 *
 * MINI-TAC owns the conversation history and memory, so this adapter keeps
 * none: every ResponseService method maps to one MINI-TAC route.
 *
 *   constructor      -> POST   /sessions                 (lazy, awaited before first use)
 *   insertMessage    -> POST   /sessions/:key/messages
 *   generateResponse -> POST   /sessions/:key/respond    (NDJSON token stream)
 *   interrupt        -> POST   /sessions/:key/interrupt  (+ abort local fetch)
 *   cleanup          -> DELETE /sessions/:key            (MINI-TAC consolidates memory)
 *
 * PoC limits: SCR's ToolRegistry is not exposed to MINI-TAC, so end-call,
 * handoff etc. never fire on this path. updateContext/updateTools are no-ops.
 */

import { logOut, logError } from '../utils/logger.js';
import type {
    ResponseService,
    ContentResponse,
    ResponseHandler,
} from '../interfaces/ResponseService.js';

export interface MiniTacOptions {
    baseUrl: string;
    apiKey: string;
    /** Session key — the callSid. */
    key: string;
    /** Caller's number; MINI-TAC keys memory on it. */
    phone: string;
    /** SCR context string; MINI-TAC appends its own memory instructions. */
    instructions: string;
}

class MiniTacResponseService implements ResponseService {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly key: string;
    private readonly ready: Promise<void>;
    private responseHandler!: ResponseHandler;
    /** Aborts the in-flight /respond fetch (interrupt or cancel-previous). */
    private abortController: AbortController | null = null;

    constructor(opts: MiniTacOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, '');
        this.apiKey = opts.apiKey;
        this.key = opts.key;
        // Constructors can't be async; every call awaits this first.
        this.ready = this.request('POST', '/sessions', {
            key: opts.key,
            phone: opts.phone,
            channel: 'voice',
            instructions: opts.instructions,
        })
            .then(async res => {
                const body = await res.json();
                logOut('MiniTacResponseService', `Session ${this.key} ready (isNew=${body.isNew}, name=${body.name ?? '-'})`);
            });
        // Surface creation failures on first use, not as an unhandled rejection.
        this.ready.catch(err => logError('MiniTacResponseService', `Session create failed: ${err.message}`));
    }

    createResponseHandler(handler: ResponseHandler): void {
        this.responseHandler = handler;
    }

    async insertMessage(role: 'system' | 'user' | 'assistant', message: string): Promise<void> {
        try {
            await this.ready;
            await this.request('POST', `/sessions/${this.key}/messages`, { role, content: message });
        } catch (error) {
            logError('MiniTacResponseService', `insertMessage failed: ${(error as Error).message}`);
        }
    }

    async generateResponse(role: 'user' | 'system' = 'user', prompt: string): Promise<void> {
        // Cancel-previous locally; MINI-TAC also cancels server-side on a new /respond.
        this.abortController?.abort();
        const controller = new AbortController();
        this.abortController = controller;

        try {
            await this.ready;
            const res = await this.request(
                'POST',
                `/sessions/${this.key}/respond`,
                { role, content: prompt },
                controller.signal
            );
            await this.readStream(res, controller.signal);
        } catch (error) {
            if (controller.signal.aborted) return; // interrupted or superseded
            this.responseHandler.error(error as Error);
            throw error;
        } finally {
            if (this.abortController === controller) this.abortController = null;
        }
    }

    interrupt(heard?: string): void {
        this.abortController?.abort();
        this.abortController = null;
        this.ready
            .then(() => this.request('POST', `/sessions/${this.key}/interrupt`, heard === undefined ? {} : { heard }))
            .catch(err => logError('MiniTacResponseService', `interrupt failed: ${err.message}`));
    }

    async updateContext(_context: string): Promise<void> {
        logOut('MiniTacResponseService', 'updateContext not supported (PoC) — ignored');
    }

    updateTools(_registry: unknown): void {
        logOut('MiniTacResponseService', 'updateTools not supported (PoC) — ignored');
    }

    cleanup(): void {
        this.abortController?.abort();
        this.abortController = null;
        this.ready
            .then(() => this.request('DELETE', `/sessions/${this.key}`))
            .catch(err => logError('MiniTacResponseService', `cleanup failed: ${err.message}`));
    }

    /** Parse the NDJSON stream: {"token"} lines, then {"last":true,...}. */
    private async readStream(res: Response, signal: AbortSignal): Promise<void> {
        if (!res.body) throw new Error('respond returned no body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newline: number;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line || signal.aborted) continue;

                const frame = JSON.parse(line) as { token?: string; last?: boolean; interrupted?: boolean };
                if (frame.last) {
                    if (!frame.interrupted) {
                        this.responseHandler.content({ type: 'text', token: '', last: true } as ContentResponse);
                    }
                    return;
                }
                if (frame.token) {
                    this.responseHandler.content({ type: 'text', token: frame.token, last: false } as ContentResponse);
                }
            }
        }
    }

    private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            const reason = res.status === 401 ? 'bad API key' : res.status === 404 ? 'unknown session' : res.statusText;
            throw new Error(`MINI-TAC ${method} ${path} -> ${res.status} (${reason})`);
        }
        return res;
    }
}

export { MiniTacResponseService };
