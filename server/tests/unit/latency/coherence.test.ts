import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/latency/embeddings.js', () => ({
    embed: vi.fn(),
    cosine: (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1],
}));
vi.mock('../../../src/latency/jev.js', () => ({ jevEvaluate: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({ logOut: vi.fn(), logError: vi.fn() }));

import { embed } from '../../../src/latency/embeddings.js';
import { jevEvaluate } from '../../../src/latency/jev.js';

const embedMock = vi.mocked(embed);
const jevMock = vi.mocked(jevEvaluate);

// Bank: statement exemplars point along [1,0], everything else along [0,1].
function mockEmbeddings(queryVec: number[]) {
    embedMock.mockImplementation(async (inputs, kind) => ({
        vectors: kind === 'query' ? [queryVec] : inputs.map((d) => (d === 'I got my bill yesterday.' ? [1, 0] : [0, 1])),
        ms: 1,
    }));
}
const load = async () => { vi.resetModules(); return import('../../../src/latency/coherence.js'); };

describe('classifyCoherence', () => {
    beforeEach(() => { vi.clearAllMocks(); delete process.env.LATENCY_COHERENCE_TIMEOUT_MS; });

    it('embedding: maps to the class of the nearest exemplar', async () => {
        mockEmbeddings([0.9, 0.1]);
        const { classifyCoherence } = await load();
        const r = await classifyCoherence('embedding', 'my bill came');
        expect(r.cls).toBe('statement');
        expect(r.source).toBe('embedding');
        expect(r.score).toBeCloseTo(0.9);
    });

    it('embedding: only embeds the latest piece, ignoring context', async () => {
        mockEmbeddings([0, 1]);
        const { classifyCoherence } = await load();
        await classifyCoherence('embedding', 'latest', ['earlier']);
        expect(embedMock.mock.calls.filter((c) => c[1] === 'query').map((c) => c[0])).toEqual([['latest']]);
    });

    it('embedding: embeds the bank once', async () => {
        mockEmbeddings([1, 0]);
        const { classifyCoherence } = await load();
        await classifyCoherence('embedding', 'a');
        await classifyCoherence('embedding', 'b');
        expect(embedMock.mock.calls.filter((c) => c[1] === 'document')).toHaveLength(1);
    });

    it('embedding: a failed bank load rejects', async () => {
        embedMock.mockRejectedValue(new Error('ollama down'));
        const { classifyCoherence } = await load();
        await expect(classifyCoherence('embedding', 'a')).rejects.toThrow('ollama down');
    });

    it('jev: maps the chosen option, passing earlier pieces as context', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 1, answers: { coherence: { choice: 'changed-mind', probabilities: { 'changed-mind': 0.8, question: 0.1 } } } });
        const { classifyCoherence } = await load();
        const r = await classifyCoherence('jev', 'actually no', ['cancel it']);
        expect(r).toMatchObject({ cls: 'changed-mind', source: 'jev', score: 0.8 });
        const [state, questions] = jevMock.mock.calls[0];
        expect(String(state)).toContain('"cancel it"');
        expect(String(state)).toContain('"actually no"');
        expect(Object.keys((questions as any).coherence.criteria)).toEqual(['question', 'statement', 'filler', 'changed-mind']);
    });

    it('jev: an error result rejects', async () => {
        jevMock.mockResolvedValue({ ok: false, error: 'http 500', ms: 1 });
        const { classifyCoherence } = await load();
        await expect(classifyCoherence('jev', 'a')).rejects.toThrow('http 500');
    });

    it('jev: an unknown choice rejects', async () => {
        jevMock.mockResolvedValue({ ok: true, model: 'm', ms: 1, answers: { coherence: { choice: 'bogus' } } });
        const { classifyCoherence } = await load();
        await expect(classifyCoherence('jev', 'a')).rejects.toThrow(/unexpected Jev choice/);
    });

    it('times out after LATENCY_COHERENCE_TIMEOUT_MS', async () => {
        process.env.LATENCY_COHERENCE_TIMEOUT_MS = '30';
        jevMock.mockReturnValue(new Promise(() => {}));
        const { classifyCoherence } = await load();
        await expect(classifyCoherence('jev', 'a')).rejects.toThrow(/timeout after 30ms/);
        expect(jevMock.mock.calls[0][2]).toBe(30);
    });
});
