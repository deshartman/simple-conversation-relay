/** Smoke test + latency probe: npx tsx scripts/probe.ts  (reads server/.env) */
import 'dotenv/config';
import { jevEvaluate } from '../src/latency/jev.js';
import { embed, cosine } from '../src/latency/embeddings.js';

const intents = ['check my account balance', 'talk to a human agent', 'cancel my subscription'];
const utterance = 'can I speak to a real person please';

const docs = await embed(intents, 'document');
console.log(`embed docs (cold): ${docs.ms.toFixed(0)}ms, dims=${docs.vectors[0].length}`);
for (let i = 0; i < 3; i++) {
    const q = await embed([utterance], 'query');
    const scores = docs.vectors.map((v) => cosine(q.vectors[0], v));
    const best = scores.indexOf(Math.max(...scores));
    console.log(`embed query #${i + 1}: ${q.ms.toFixed(0)}ms -> "${intents[best]}" (${scores[best].toFixed(3)})`);
}

const questions = {
    intent: {
        type: 'choice' as const,
        instructions: 'What does the caller want?',
        criteria: Object.fromEntries(intents.map((i) => [i, i])),
    },
};
for (let i = 0; i < 4; i++) {
    const r = await jevEvaluate(`Caller said: "${utterance}"`, questions);
    console.log(r.ok ? `jev #${i + 1}: ${r.ms.toFixed(0)}ms -> ${r.answers.intent.choice} (p=${r.answers.intent.probabilities[r.answers.intent.choice]?.toFixed(2)}) [${r.model}]` : `jev #${i + 1}: FAIL ${r.error}`);
}
