/**
 * Coherence classifier: is the caller done talking? Classifies the latest prompt fragment
 * (earlier buffered fragments are context) with the current mode's engine.
 *   question     - a complete ask
 *   statement    - context, so a question may follow
 *   filler       - "um", "so...", "hang on", an unfinished thought
 *   changed-mind - "actually, no...", a correction of what came earlier
 * Throws on infrastructure failure or timeout; the caller fails open.
 */
import { embed, cosine } from './embeddings.js';
import { jevEvaluate } from './jev.js';
import { logOut, logError } from '../utils/logger.js';

export const COHERENCE_CLASSES = ['question', 'statement', 'filler', 'changed-mind'] as const;
export type CoherenceClass = (typeof COHERENCE_CLASSES)[number];
export interface CoherenceResult { cls: CoherenceClass; source: 'jev' | 'embedding'; ms: number; score: number }

const timeoutMs = (): number => {
    const n = Number(process.env.LATENCY_COHERENCE_TIMEOUT_MS);
    return process.env.LATENCY_COHERENCE_TIMEOUT_MS && Number.isFinite(n) && n > 0 ? n : 600;
};

/** What each class means, with examples. Used as Jev criteria and as the embedding exemplar bank. */
export const CLASS_INFO: Record<CoherenceClass, { what: string; examples: string[] }> = {
    question: {
        what: 'A complete question or request the assistant can answer or act on now, even if short.',
        examples: [
            'Why is my bill so high this month?',
            'Can you cancel my subscription?',
            'What time do you close on Saturdays?',
            'I need to change my delivery address.',
            'How do I reset my password?',
            'Where is my order?',
            'Do you offer free returns on that item?',
            'How much does the basic plan cost per month?',
            'Is there a charge for changing my flight?',
            'When does my warranty expire?',
            'Could you book me in for next Monday morning?',
            'I would like to talk to someone about my invoice.',
            'What is the status of my application?',
            'Can I get my money back for the damaged item?',
        ],
    },
    statement: {
        what: 'Background or context the caller is giving, with no ask yet. A question may follow.',
        examples: [
            'I got my bill yesterday.',
            'I have been a customer for about six years.',
            'So I ordered a phone last week.',
            'My internet has been dropping out since Monday.',
            'I was charged twice for the same thing.',
            'I am calling about my account.',
        ],
    },
    filler: {
        what: 'A hesitation, a request to wait, or an unfinished thought: no content yet.',
        examples: ['Um.', 'So...', 'Hang on a second.', 'Let me think.', 'Uh, well, I was just', 'Hold on, one moment.'],
    },
    'changed-mind': {
        what: 'The caller corrects or retracts what they said earlier.',
        examples: [
            'Actually, no.',
            'Wait, never mind, that is not what I meant.',
            'Actually, make that Thursday instead.',
            'No, sorry, I meant the other account.',
            'Scratch that.',
            'Actually, forget what I said.',
        ],
    },
};

// Exemplar bank, embedded once per process.
let bank: Promise<{ vectors: number[][]; owner: CoherenceClass[] }> | undefined;

function loadBank() {
    if (!bank) {
        bank = (async () => {
            const owner: CoherenceClass[] = [];
            const docs: string[] = [];
            for (const c of COHERENCE_CLASSES) for (const e of CLASS_INFO[c].examples) { docs.push(e); owner.push(c); }
            return { vectors: (await embed(docs, 'document')).vectors, owner };
        })().catch((e) => { bank = undefined; throw e; });
    }
    return bank;
}

/** Fire-and-forget: pre-embed the exemplar bank so the first prompt doesn't pay for it. */
export function warmCoherenceBank(): void {
    loadBank().then(
        () => logOut('Latency', 'Coherence bank embedded'),
        (e) => logError('Latency', `Coherence bank warm-up failed: ${e instanceof Error ? e.message : String(e)}`),
    );
}

/** Nearest class by cosine; a class scores its best-matching exemplar. */
export function nearestClass(query: number[], vectors: number[][], owner: CoherenceClass[]): { cls: CoherenceClass; score: number } {
    let best: { cls: CoherenceClass; score: number } = { cls: owner[0], score: -Infinity };
    vectors.forEach((v, i) => {
        const s = cosine(query, v);
        if (s > best.score) best = { cls: owner[i], score: s };
    });
    return best;
}

/** Map a Jev choice answer to a class; throws on an unknown choice. */
export function jevChoiceToClass(a: { choice?: string; probabilities?: Record<string, number> } | undefined): { cls: CoherenceClass; score: number } {
    const choice = a?.choice;
    if (!(COHERENCE_CLASSES as readonly string[]).includes(choice ?? '')) throw new Error(`unexpected Jev choice: ${String(choice)}`);
    return { cls: choice as CoherenceClass, score: Number(a?.probabilities?.[choice!]) };
}

async function viaEmbedding(latest: string): Promise<{ cls: CoherenceClass; score: number }> {
    const { vectors, owner } = await loadBank();
    const q = (await embed([latest], 'query')).vectors[0];
    return nearestClass(q, vectors, owner);
}

async function viaJev(latest: string, context: string[]): Promise<{ cls: CoherenceClass; score: number }> {
    const criteria: Record<string, unknown> = {};
    for (const c of COHERENCE_CLASSES) criteria[c] = { what: CLASS_INFO[c].what, examples: CLASS_INFO[c].examples };
    const state = context.length
        ? `Earlier in this turn, the caller said: ${context.map((c) => `"${c}"`).join(' ')}\nThe caller's latest words: "${latest}"`
        : `The caller's latest words: "${latest}"`;
    const r = await jevEvaluate(
        state,
        { coherence: { type: 'choice', instructions: "Which option best describes the caller's latest words, given what they said earlier?", criteria } },
        timeoutMs(),
    );
    if (!r.ok) throw new Error(r.error);
    return jevChoiceToClass(r.answers.coherence);
}

export async function classifyCoherence(mode: 'jev' | 'embedding', latest: string, context: string[] = []): Promise<CoherenceResult> {
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
        const r = await Promise.race([
            mode === 'embedding' ? viaEmbedding(latest) : viaJev(latest, context),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${timeoutMs()}ms`)), timeoutMs()); }),
        ]);
        return { ...r, source: mode, ms: performance.now() - t0 };
    } finally {
        clearTimeout(timer);
    }
}
