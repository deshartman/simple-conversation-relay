/**
 * SimpleTacResponseService — ResponseService backed by a SIMPLE-TAC agent over HTTP.
 *
 * SIMPLE-TAC owns the prompt, tools, conversation history and memory, so this
 * adapter keeps none: each call event maps to one SIMPLE-TAC route.
 *
 *   setup     -> POST   /sessions                 (awaited before any other call)
 *   prompt    -> POST   /sessions/:key/respond    (NDJSON token stream)
 *   interrupt -> POST   /sessions/:key/interrupt  (+ abort local fetch)
 *   dtmf      -> POST   /sessions/:key/events     {type:'dtmf', digit}
 *   status    -> POST   /sessions/:key/events     {type:'status', status}
 *   silenceReminder -> POST /sessions/:key/events {type:'silence', count}
 *                      (optional reply {text}; SCR owns when to remind/end)
 *   cleanup   -> DELETE /sessions/:key            (SIMPLE-TAC consolidates memory)
 *
 * Tools run in SIMPLE-TAC. Its handoff asks for the end with a {"handoff"} line
 * (handoffData string); SCR turns that into an `endCall` action, so SIMPLE-TAC
 * never builds CR frames.
 * A `context` event is ignored: SIMPLE-TAC owns its prompt.
 */

import { logOut, logError } from '../utils/logger.js';
import type {
    ResponseService,
    ContentResponse,
    ResponseHandler,
    CallEvent,
} from '../interfaces/ResponseService.js';

export interface SimpleTacOptions {
    baseUrl: string;
    apiKey: string;
}

/** How long a silence reminder may wait for SIMPLE-TAC's wording before SCR's is used. */
const SILENCE_WORDING_TIMEOUT_MS = 1500;

class SimpleTacResponseService implements ResponseService {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    /** Session key — the callSid from setup (UUID when absent). */
    private key = '';
    /** Settles once POST /sessions has; every later call awaits it. */
    private ready: Promise<void> = Promise.reject(new Error('setup event not received'));
    private responseHandler!: ResponseHandler;
    /** Aborts the in-flight /respond fetch (interrupt or cancel-previous). */
    private abortController: AbortController | null = null;

    constructor(opts: SimpleTacOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/$/, '');
        this.apiKey = opts.apiKey;
        this.ready.catch(() => {}); // replaced on setup; don't surface the placeholder
    }

    createResponseHandler(handler: ResponseHandler): void {
        this.responseHandler = handler;
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
                }).then(() => {
                    logOut('SimpleTacResponseService', `Session ${this.key} ready`);
                });
                // Surface creation failures here, not as an unhandled rejection;
                // later calls still see the rejection through `ready`.
                this.ready.catch(err => logError('SimpleTacResponseService', `Session create failed: ${err.message}`));
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
            case 'context':
                // SIMPLE-TAC owns its prompt; SCR has no context to switch to.
                logOut('SimpleTacResponseService', `context switch '${event.key}' ignored — SIMPLE-TAC owns the prompt`);
                break;
        }
    }

    /**
     * Ask SIMPLE-TAC for the wording of silence reminder `count`. SCR decides when
     * to remind and when to end; SIMPLE-TAC may only reword. Anything but a quick
     * 2xx `{ text }` means "use SCR's configured wording" — the caller is
     * already waiting, so a slow SIMPLE-TAC must not delay the reminder.
     */
    async silenceReminder(count: number): Promise<string | null> {
        try {
            await this.ready;
            const res = await this.request(
                'POST',
                `/sessions/${this.key}/events`,
                { type: 'silence', count },
                AbortSignal.timeout(SILENCE_WORDING_TIMEOUT_MS)
            );
            const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
            return typeof body?.text === 'string' && body.text.trim() ? body.text : null;
        } catch (error) {
            logError('SimpleTacResponseService', `silence wording unavailable: ${(error as Error).message}`);
            return null;
        }
    }

    private async postEvent(body: object): Promise<void> {
        try {
            await this.ready;
            await this.request('POST', `/sessions/${this.key}/events`, body);
        } catch (error) {
            logError('SimpleTacResponseService', `event failed: ${(error as Error).message}`);
        }
    }

    async generateResponse(role: 'user' | 'system' = 'user', prompt: string, lang?: string): Promise<void> {
        // Cancel-previous locally; SIMPLE-TAC also cancels server-side on a new /respond.
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
            .catch(err => logError('SimpleTacResponseService', `interrupt failed: ${err.message}`));
    }

    cleanup(): void {
        this.abortController?.abort();
        this.abortController = null;
        this.ready
            .then(() => this.request('DELETE', `/sessions/${this.key}`))
            .catch(err => logError('SimpleTacResponseService', `cleanup failed: ${err.message}`));
    }

    /** Parse the NDJSON stream: {"token"} and {"handoff","tool"} lines, then {"last":true,...}. */
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
                    handoff?: string;
                    tool?: string;
                };
                if (typeof frame.handoff === 'string') {
                    // SIMPLE-TAC's handoff tool asks for the end; SCR builds the
                    // frame and holds it until the farewell has been spoken.
                    this.responseHandler.toolResult({
                        toolType: frame.tool ?? 'handoff',
                        toolData: {
                            success: true,
                            message: 'from SIMPLE-TAC',
                            action: { type: 'endCall', handoffData: frame.handoff },
                        },
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
            throw new Error(`SIMPLE-TAC ${method} ${path} -> ${res.status} (${reason})`);
        }
        return res;
    }
}

export { SimpleTacResponseService };
