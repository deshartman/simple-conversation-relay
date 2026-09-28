/**
 * MiniTacResponseService — ResponseService backed by a MINI-TAC agent over HTTP.
 *
 * MINI-TAC owns the prompt, tools, conversation history and memory, so this
 * adapter keeps none: each call event maps to one MINI-TAC route.
 *
 *   setup     -> POST   /sessions                 (awaited before any other call)
 *   prompt    -> POST   /sessions/:key/respond    (NDJSON token stream)
 *   interrupt -> POST   /sessions/:key/interrupt  (+ abort local fetch)
 *   dtmf      -> POST   /sessions/:key/events     {type:'dtmf', digit}
 *   status    -> POST   /sessions/:key/events     {type:'status', status}
 *   cleanup   -> DELETE /sessions/:key            (MINI-TAC consolidates memory)
 *
 * Tools run in MINI-TAC; any CR frame they produce (e.g. an `end` handoff)
 * arrives as a {"frame"} line and is routed through toolResult.
 * insertMessage maps to /messages; updateContext/updateTools are no-ops.
 */

import { logOut, logError } from '../utils/logger.js';
import type {
    ResponseService,
    ContentResponse,
    ResponseHandler,
    CallEvent,
} from '../interfaces/ResponseService.js';

export interface MiniTacOptions {
    baseUrl: string;
    apiKey: string;
}

class MiniTacResponseService implements ResponseService {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    /** Session key — the callSid from setup (UUID when absent). */
    private key = '';
    /** Settles once POST /sessions has; every later call awaits it. */
    private ready: Promise<void> = Promise.reject(new Error('setup event not received'));
    private responseHandler!: ResponseHandler;
    /** Aborts the in-flight /respond fetch (interrupt or cancel-previous). */
    private abortController: AbortController | null = null;

    constructor(opts: MiniTacOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, '');
        this.apiKey = opts.apiKey;
        this.ready.catch(() => {}); // replaced on setup; don't surface the placeholder
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

    async handleEvent(event: CallEvent): Promise<void> {
        switch (event.type) {
            case 'setup': {
                this.key = event.setup.callSid ?? crypto.randomUUID();
                this.ready = this.request('POST', '/sessions', {
                    key: this.key,
                    phone: event.setup.from ?? '',
                    channel: 'voice',
                    setup: event.setup,
                    parameters: event.parameters,
                }).then(async res => {
                    const body = await res.json();
                    logOut('MiniTacResponseService', `Session ${this.key} ready (isNew=${body.isNew}, name=${body.name ?? '-'})`);
                });
                // Surface creation failures here, not as an unhandled rejection;
                // later calls still see the rejection through `ready`.
                this.ready.catch(err => logError('MiniTacResponseService', `Session create failed: ${err.message}`));
                break;
            }
            case 'prompt':
                await this.generateResponse('user', event.text, event.lang);
                break;
            case 'interrupt':
                this.interrupt(event.heard);
                break;
            case 'dtmf':
                await this.postEvent({ type: 'dtmf', digit: event.digit });
                break;
            case 'status':
                await this.postEvent({ type: 'status', status: event.status });
                break;
        }
    }

    private async postEvent(body: object): Promise<void> {
        try {
            await this.ready;
            await this.request('POST', `/sessions/${this.key}/events`, body);
        } catch (error) {
            logError('MiniTacResponseService', `event failed: ${(error as Error).message}`);
        }
    }

    async generateResponse(role: 'user' | 'system' = 'user', prompt: string, lang?: string): Promise<void> {
        // Cancel-previous locally; MINI-TAC also cancels server-side on a new /respond.
        this.abortController?.abort();
        const controller = new AbortController();
        this.abortController = controller;

        try {
            await this.ready;
            const res = await this.request(
                'POST',
                `/sessions/${this.key}/respond`,
                lang === undefined ? { role, content: prompt } : { role, content: prompt, lang },
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

    /** Parse the NDJSON stream: {"token"} and {"frame","tool"} lines, then {"last":true,...}. */
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

                const frame = JSON.parse(line) as {
                    token?: string;
                    last?: boolean;
                    interrupted?: boolean;
                    frame?: unknown;
                    tool?: string;
                };
                if (frame.frame) {
                    // A MINI-TAC tool produced a CR frame only SCR can send; route it
                    // like a local tool result so `end` is held until last:true.
                    this.responseHandler.toolResult({
                        toolType: frame.tool ?? 'mini-tac',
                        toolData: { success: true, message: 'from MINI-TAC', outgoingMessage: frame.frame },
                    });
                    continue;
                }
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
