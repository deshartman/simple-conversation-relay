/**
 * ContextStore — the LLM prompt (context) source for response services that
 * need one. SCR's transport never loads a context; only a ResponseService that
 * owns its prompt (OpenAI) reads from here.
 *
 * Contexts are `server/assets/<key>.md`, read on first use and then cached.
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logOut, logError } from '../utils/logger.js';

export interface ContextSource {
    /** Context for `key`, or null when absent or the key is not a plain name. */
    get(key: string): Promise<string | null>;
    /** The default context; throws when it cannot be loaded. */
    getDefault(): Promise<string>;
}

/** Thrown when a requested context key has no `.md` file. */
export class ContextNotFoundError extends Error {
    constructor(key: string) {
        super(`Context not found for key: ${key}`);
        this.name = 'ContextNotFoundError';
    }
}

/** Keys arrive from callers (customParameters, HTTP), so no paths. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ContextStore implements ContextSource {
    private readonly dir: string;
    private readonly defaultKey: string;
    private readonly cache = new Map<string, string>();

    constructor(opts: { defaultKey?: string; dir?: string } = {}) {
        this.defaultKey = opts.defaultKey ?? 'defaultContext';
        // server/src/services -> server/assets
        this.dir = opts.dir ?? join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'assets');
    }

    async get(key: string): Promise<string | null> {
        if (!KEY_PATTERN.test(key)) {
            logError('ContextStore', `Rejected context key '${key}'`);
            return null;
        }
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;

        try {
            const content = await fs.readFile(join(this.dir, `${key}.md`), 'utf-8');
            this.cache.set(key, content);
            logOut('ContextStore', `Loaded context '${key}' (${content.length} characters)`);
            return content;
        } catch {
            return null;
        }
    }

    async getDefault(): Promise<string> {
        const context = await this.get(this.defaultKey);
        if (context === null) {
            throw new Error(`Default context '${this.defaultKey}' not found in ${this.dir}`);
        }
        return context;
    }
}
