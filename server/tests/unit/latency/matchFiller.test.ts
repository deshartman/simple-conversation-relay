import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../../../src/latency/embeddings.js', () => ({
    embed: vi.fn(),
    cosine: (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1],
}));
vi.mock('../../../src/latency/jev.js', () => ({ jevEvaluate: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ logOut: vi.fn(), logError: vi.fn() }));

import { embed } from '../../../src/latency/embeddings.js';
import { jevEvaluate } from '../../../src/latency/jev.js';
import { loadFillers, fillerDocuments, opener } from '../../../src/latency/fillers.js';

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

    it('jev: leaves out fillers whose opening word was recently used', async () => {
        const all = loadFillers();
        const okay = all.filter((f) => opener(f.say) === 'okay');
        expect(okay.length).toBeGreaterThan(1);
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: FIRST.id, probabilities: { [FIRST.id]: 0.8 } } } });
        const matchFiller = await load('jev');
        await matchFiller('hi', undefined, undefined, { avoidOpeners: new Set(['okay']) });
        const criteria = (jevMock.mock.calls[0][1] as any).filler.criteria;
        for (const f of okay) expect(criteria).not.toHaveProperty(f.id);
        expect(criteria).toHaveProperty('generic-ack');
        expect(Object.keys(criteria).length).toBe(all.length - okay.length + 1);
    });

    it('embedding: never picks a filler whose opening word is avoided', async () => {
        const okay = loadFillers().find((f) => opener(f.say) === 'okay')!;
        embedMock.mockImplementation(async (inputs, kind) => ({
            vectors: kind === 'query' ? [[1, 0]] : inputs.map((d) => (fillerDocuments(okay).includes(d) ? [1, 0] : [0, 1])),
            ms: 1,
        }));
        const matchFiller = await load('embedding');
        expect((await matchFiller('hi'))?.filler.id).toBe(okay.id);
        const r = await matchFiller('hi', undefined, undefined, { avoidOpeners: new Set(['okay']) });
        expect(r?.filler ? opener(r.filler.say) : null).not.toBe('okay');
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

    it('jev: the generic-ack catch-all and failures return null', async () => {
        const matchFiller = await load('jev');
        jevMock.mockResolvedValueOnce({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: 'generic-ack', probabilities: { 'generic-ack': 0.9 } } } });
        expect(await matchFiller('hi')).toBeNull();
        jevMock.mockResolvedValueOnce({ ok: false, error: 'timeout', ms: 600 });
        expect(await matchFiller('hi')).toBeNull();
    });

    it('reports why it missed via onMiss', async () => {
        const reasons: string[] = [];
        const onMiss = (r: string) => reasons.push(r);
        process.env.LATENCY_EMBED_THRESHOLD = '0.95';
        mockEmbeddings([0.9, 0.1]);
        await (await load('embedding'))('hi', undefined, onMiss);
        embedMock.mockRejectedValue(new Error('down'));
        await (await load('embedding'))('hi', undefined, onMiss);
        jevMock.mockResolvedValueOnce({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: 'generic-ack', probabilities: { 'generic-ack': 0.9 } } } });
        await (await load('jev'))('hi', undefined, onMiss);
        expect(reasons).toEqual(['below-threshold', 'error', 'catch-all']);
    });

    it('jev: always offers the generic-ack option', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: 'generic-ack', probabilities: {} } } });
        await (await load('jev'))('hi');
        expect(Object.keys((jevMock.mock.calls[0][1].filler as any).criteria)).toContain('generic-ack');
    });
});

describe('matchFiller overrides', () => {
    // Vectors are 2-D; cosine is a plain dot product in the mock, so scores are easy to set.
    const [A, B] = loadFillers().filter((f) => f.category !== 'catch-all');
    beforeEach(() => {
        vi.clearAllMocks();
        for (const k of ['LATENCY_EMBED_THRESHOLD', 'LATENCY_EMBED_MARGIN', 'LATENCY_EMBED_SCORE_BY', 'LATENCY_JEV_THRESHOLD', 'LATENCY_JEV_MARGIN', 'LATENCY_MODE']) delete process.env[k];
    });
    // A's `when` doc -> [0.5,0], A's examples -> [0.9,0], B's docs -> [0.85,0]; query [1,0].
    function mockBank() {
        embedMock.mockImplementation(async (inputs, kind) => ({
            vectors: inputs.map((d) => kind === 'query' ? [1, 0]
                : d === A.when ? [0.5, 0] : A.examples.includes(d) ? [0.9, 0] : [0.85, 0]),
            ms: 1,
        }));
    }
    const run = async (o: Record<string, unknown>) => {
        const misses: string[] = [];
        const matchFiller = await load('embedding');
        const r = await matchFiller('hi', undefined, (m) => misses.push(m), o);
        return { r, misses };
    };

    it('embedding: margin override rejects a narrow win as low-margin', async () => {
        mockBank();
        expect((await run({ margin: 0.04 })).r?.filler.id).toBe(A.id);
        expect((await run({ margin: 0.06 })).misses).toEqual(['low-margin']);
    });

    it('embedding: scoreBy when-only ranks on the `when` doc, mean-top2 averages the two best docs', async () => {
        mockBank();
        const w = await run({ scoreBy: 'when-only', margin: 0 });
        expect(w.r?.filler.id).toBe(B.id);
        expect(w.r?.score).toBeCloseTo(0.85);
        const m = await run({ scoreBy: 'mean-top2', margin: 0 });
        expect(m.r?.filler.id).toBe(A.id);
        expect(m.r?.score).toBeCloseTo(0.9);
    });

    it('embedding: a best match in a catch-all category is a miss', async () => {
        mockBank();
        const dir = mkdtempSync(path.join(tmpdir(), 'fillers-'));
        const file = path.join(dir, 'f.json');
        writeFileSync(file, JSON.stringify(loadFillers().map((f) => (f.id === A.id ? { ...f, category: 'catch-all' } : f))));
        const { r, misses } = await run({ fillersPath: file });
        expect(r).toBeNull();
        expect(misses).toEqual(['catch-all']);
        rmSync(dir, { recursive: true });
    });

    it('jev: margin is top probability minus the runner-up', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 5, answers: { filler: { choice: A.id, probabilities: { [A.id]: 0.6, [B.id]: 0.5 } } } });
        const matchFiller = await load('jev');
        const misses: string[] = [];
        expect(await matchFiller('hi', undefined, (m) => misses.push(m), { margin: 0.2 })).toBeNull();
        expect(misses).toEqual(['low-margin']);
        expect((await matchFiller('hi', undefined, undefined, { margin: 0.05 }))?.filler.id).toBe(A.id);
    });
});
