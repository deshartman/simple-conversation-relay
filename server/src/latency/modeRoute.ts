import { Router } from 'express';
import { LATENCY_MODES, getMode, setMode, isLatencyMode } from './mode.js';
import { warmFillerBank } from './matchFiller.js';
import { logOut } from '../utils/logger.js';

/**
 * GET /latency/mode            -> { mode, available }
 * PUT|POST /latency/mode {mode} -> { mode, previous }  (400 if invalid)
 *
 * Not behind Twilio signature validation (Twilio never calls it) and, like
 * /conversation and /updateResponseService, currently unauthenticated.
 * Requires express.json() to be applied upstream.
 */
export function createLatencyModeRouter(): Router {
    const router = Router();

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
