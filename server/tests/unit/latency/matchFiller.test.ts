import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/latency/embeddings.js', () => ({
    embed: vi.fn(),
    cosine: (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1],
}));
vi.mock('../../../src/latency/jev.js', () => ({ jevEvaluate: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ logOut: vi.fn(), logError: vi.fn() }));

import { embed } from '../../../src/latency/embeddings.js';
import { jevEvaluate } from '../../../src/latency/jev.js';
import { loadFillers, fillerDocuments } from '../../../src/latency/fillers.js';

const FIRST = loadFillers()[0];
const embedMock = vi.mocked(embed);
const jevMock = vi.mocked(jevEvaluate);

// Bank: the first filler's documents point along [1,0], everything else along [0,1].
function mockEmbeddings(queryVec: number[]) {
    embedMock.mockImplementation(async (inputs, kind) => ({
        vectors: kind === 'query'
            ? [queryVec]
            : inputs.map((d) => (fillerDocuments(FIRST).includes(d) ? [1, 0] : [0, 1])),
        ms: 1,
    }));
}

// vi.resetModules gives matchFiller a fresh mode.js, which reads LATENCY_MODE.
async function load(mode: string) {
    process.env.LATENCY_MODE = mode;
    vi.resetModules();
    return (await import('../../../src/latency/matchFiller.js')).matchFiller;
}

describe('matchFiller', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.LATENCY_EMBED_THRESHOLD;
        delete process.env.LATENCY_JEV_THRESHOLD;
        delete process.env.LATENCY_MODE;
    });

    it('returns null immediately in none mode', async () => {
        const matchFiller = await load('none');
        expect(await matchFiller('hello')).toBeNull();
        expect(embedMock).not.toHaveBeenCalled();
        expect(jevMock).not.toHaveBeenCalled();
    });

    it('embedding: returns the best filler above the threshold', async () => {
        mockEmbeddings([0.9, 0.1]);
        const matchFiller = await load('embedding');
        const r = await matchFiller('hi');
        expect(r?.filler.id).toBe(FIRST.id);
        expect(r?.score).toBeCloseTo(0.9);
        expect(r?.mode).toBe('embedding');
    });

    it('embedding: returns null below the threshold', async () => {
        process.env.LATENCY_EMBED_THRESHOLD = '0.95';
        mockEmbeddings([0.9, 0.1]);
        const matchFiller = await load('embedding');
        expect(await matchFiller('hi')).toBeNull();
    });

    it('embedding: error returns null and the bank is retried next time', async () => {
        embedMock.mockRejectedValueOnce(new Error('ollama down'));
        const matchFiller = await load('embedding');
        expect(await matchFiller('hi')).toBeNull();
        mockEmbeddings([1, 0]);
        expect((await matchFiller('hi'))?.filler.id).toBe(FIRST.id);
    });

    it('jev: returns the chosen filler when its probability clears the threshold', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: FIRST.id, probabilities: { [FIRST.id]: 0.8 } } } });
        const matchFiller = await load('jev');
        const r = await matchFiller('hi');
        expect(r?.filler.id).toBe(FIRST.id);
        expect(r?.score).toBe(0.8);
        const q = jevMock.mock.calls[0][1].filler as any;
        expect(q.type).toBe('choice');
        expect(Object.keys(q.criteria)).toContain(FIRST.id);
    });

    it('jev: returns null below the probability threshold', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: FIRST.id, probabilities: { [FIRST.id]: 0.3 } } } });
        const matchFiller = await load('jev');
        expect(await matchFiller('hi')).toBeNull();
    });

    it('jev: the none option and failures return null', async () => {
        const matchFiller = await load('jev');
        jevMock.mockResolvedValueOnce({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: 'none', probabilities: { none: 0.9 } } } });
        expect(await matchFiller('hi')).toBeNull();
        jevMock.mockResolvedValueOnce({ ok: false, error: 'timeout', ms: 600 });
        expect(await matchFiller('hi')).toBeNull();
    });
});
