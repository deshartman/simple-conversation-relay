import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LATENCY_MODES, getMode, setMode, isLatencyMode } from './mode.js';
import { warmFillerBank } from './matchFiller.js';
import { logOut } from '../utils/logger.js';

/**
 * GET /latency/mode            -> { mode, available }
 * PUT|POST /latency/mode {mode} -> { mode, previous }  (400 if invalid)
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
        if (mode === 'embedding') warmFillerBank();
        res.json({ mode, previous });
    };
    router.put('/mode', set);
    router.post('/mode', set);

    return router;
}
