import { loadFillers, fillerDocuments } from '../src/latency/fillers.ts';
import { embed, cosine } from '../src/latency/embeddings.ts';
const F = loadFillers();
const docs: {id:string; t:string}[] = F.flatMap(f => fillerDocuments(f).map(t => ({id: f.id, t})));
const bank = (await embed(docs.map(d => d.t), 'document')).vectors;
const tests = [
  "my wife passed away last week", "I'm so overwhelmed I can't stop crying", "I lost my job and can't pay the bill",
  "oh my god I dropped my phone in the toilet", "my card was stolen yesterday", "I just got hit with a huge charge",
  "yes or no, am I going to be charged", "what exactly is the cancellation fee", "I'm going to file a complaint with the regulator",
  "what's my account balance", "this is ridiculous I am so angry", "can I speak to a real person",
];
for (const u of tests) {
  const q = (await embed([u], 'query')).vectors[0];
  const best = new Map<string, number>();
  docs.forEach((d, i) => best.set(d.id, Math.max(best.get(d.id) ?? -1, cosine(q, bank[i]))));
  const top = [...best].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, s]) => `${id} ${s.toFixed(2)}`);
  console.log(u.padEnd(52), '→', top.join(' | '));
}
