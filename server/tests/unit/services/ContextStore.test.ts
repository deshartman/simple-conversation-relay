/**
 * ContextStore — the prompt source for response services that own one.
 *
 * Uses a temp directory so the tests pin behaviour, not the shipped assets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContextStore } from '../../../src/services/ContextStore.js';

describe('ContextStore', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ctx-'));
        await writeFile(join(dir, 'defaultContext.md'), 'Default prompt');
        await writeFile(join(dir, 'campaign.md'), 'Campaign prompt');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('loads a context by key from <key>.md', async () => {
        const store = new ContextStore({ dir });
        expect(await store.get('campaign')).toBe('Campaign prompt');
    });

    it('returns null for a missing context', async () => {
        const store = new ContextStore({ dir });
        expect(await store.get('nope')).toBeNull();
    });

    it('caches after the first read', async () => {
        const store = new ContextStore({ dir });
        await store.get('campaign');
        await writeFile(join(dir, 'campaign.md'), 'Changed on disk');

        expect(await store.get('campaign')).toBe('Campaign prompt');
    });

    it('rejects keys that are not plain names, so callers cannot read other files', async () => {
        await writeFile(join(dir, 'secret.md'), 'nope');
        const store = new ContextStore({ dir: join(dir, 'sub') });

        expect(await store.get('../secret')).toBeNull();
        expect(await store.get('a/b')).toBeNull();
    });

    it('loads the default context, and throws when it is missing', async () => {
        expect(await new ContextStore({ dir }).getDefault()).toBe('Default prompt');
        await expect(new ContextStore({ dir, defaultKey: 'missing' }).getDefault()).rejects.toThrow(
            "Default context 'missing' not found"
        );
    });
});
