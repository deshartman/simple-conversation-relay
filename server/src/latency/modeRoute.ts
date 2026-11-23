import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    LATENCY_MODES, getMode, setMode, isLatencyMode,
    MAX_LLM_DELAY_MS, isValidDelayMs, getLlmDelayMs, setLlmDelayMs, isHandlerEnabled, setHandlerEnabled,
    MAX_QUESTION_WAIT_MS, isValidQuestionWaitMs, getQuestionWaitMs, setQuestionWaitMs, isJevWarmEnabled, isLayaWarmEnabled,
} from './mode.js';
import { warmJev, warmLaya } from './jev.js';
import { warmFillerBank } from './matchFiller.js';
import { warmCoherenceBank } from './coherence.js';
import { logOut } from '../utils/logger.js';

/**
 * GET /latency/mode            -> { mode, available }
 * PUT|POST /latency/mode {mode} -> { mode, previous }  (400 if invalid)
 *
 * GET /latency/delay          -> { ms }
 * PUT|POST /latency/delay {ms}  -> { ms, previous }  (400 unless an integer 0..20000; test-only LLM delay)
 * GET /latency/handler         -> { enabled }
 * PUT|POST /latency/handler {enabled} -> { enabled, previous }  (400 unless boolean; hold sound on/off)
 *
 * GET /latency/question-wait -> { ms }
 * PUT|POST /latency/question-wait {ms} -> { ms, previous }  (400 unless an integer 0..10000; coherence wait, 0 = off)
 *
 * GET /latency/               -> public/latency.html (explainer plus mode switch; same origin, so no CORS)
 *
 * Not behind Twilio signature validation (Twilio never calls it) and, like
 * /conversation and /updateResponseService, currently unauthenticated.
 * Requires express.json() to be applied upstream.
 */
export function createLatencyModeRouter(): Router {
    const router = Router();

    // Resolved from this file so it works from src/ (tsx) and dist/ (tsc): both sit two levels below server/.
    const page = fileURLToPath(new URL('../../public/latency.html', import.meta.url));
    router.get('/', async (_req, res) => {
        try {
            res.type('html').send(await readFile(page, 'utf8'));
        } catch {
            res.status(404).send('latency.html not found');
        }
    });
    router.get('/mode', (_req, res) => {
        res.json({ mode: getMode(), available: [...LATENCY_MODES] });
    });

    const set: import('express').RequestHandler = (req, res) => {
        const mode = req.body?.mode;
        if (!isLatencyMode(mode)) {
            res.status(400).json({
                error: `Invalid mode. Expected one of: ${LATENCY_MODES.join(', ')}`,
                available: [...LATENCY_MODES],
            });
            return;
        }
        const previous = getMode();
        setMode(mode);
        logOut('Latency', `Mode changed: ${previous} -> ${mode}`);
        if (mode === 'embedding') { warmFillerBank(); warmCoherenceBank(); }
        if (mode === 'jev' && isJevWarmEnabled()) void warmJev();
        if (mode === 'laya' && isLayaWarmEnabled()) void warmLaya();
        res.json({ mode, previous });
    };
    router.put('/mode', set);
    router.post('/mode', set);

    router.get('/delay', (_req, res) => {
        res.json({ ms: getLlmDelayMs() });
    });

    const setDelay: import('express').RequestHandler = (req, res) => {
        const ms = req.body?.ms;
        if (!isValidDelayMs(ms)) {
            res.status(400).json({ error: `Invalid ms. Expected an integer from 0 to ${MAX_LLM_DELAY_MS}` });
            return;
        }
        const previous = getLlmDelayMs();
        setLlmDelayMs(ms);
        logOut('Latency', `LLM delay changed: ${previous}ms -> ${ms}ms`);
        res.json({ ms, previous });
    };
    router.put('/delay', setDelay);
    router.post('/delay', setDelay);

    router.get('/handler', (_req, res) => {
        res.json({ enabled: isHandlerEnabled() });
    });

    const setHandler: import('express').RequestHandler = (req, res) => {
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') {
            res.status(400).json({ error: 'Invalid enabled. Expected a boolean' });
            return;
        }
        const previous = isHandlerEnabled();
        setHandlerEnabled(enabled);
        logOut('Latency', `Handler changed: ${previous} -> ${enabled}`);
        res.json({ enabled, previous });
    };
    router.put('/handler', setHandler);
    router.post('/handler', setHandler);

    router.get('/question-wait', (_req, res) => {
        res.json({ ms: getQuestionWaitMs() });
    });

    const setQuestionWait: import('express').RequestHandler = (req, res) => {
        const ms = req.body?.ms;
        if (!isValidQuestionWaitMs(ms)) {
            res.status(400).json({ error: `Invalid ms. Expected an integer from 0 to ${MAX_QUESTION_WAIT_MS}` });
            return;
        }
        const previous = getQuestionWaitMs();
        setQuestionWaitMs(ms);
        logOut('Latency', `Question wait changed: ${previous}ms -> ${ms}ms`);
        res.json({ ms, previous });
    };
    router.put('/question-wait', setQuestionWait);
    router.post('/question-wait', setQuestionWait);

    return router;
}
