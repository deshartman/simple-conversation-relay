/**
 * Ollama embedding client. POST {base}/api/embed.
 * nomic-embed-text expects a task prefix: "search_document: " for stored text,
 * "search_query: " for the caller's utterance.
 */
export interface EmbedResult { vectors: number[][]; ms: number }

export async function embed(inputs: string[], kind: 'document' | 'query'): Promise<EmbedResult> {
    const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
    const model = process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text';
    const t0 = performance.now();
    const res = await fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: inputs.map((t) => `search_${kind}: ${t}`), keep_alive: '30m' }),
    });
    if (!res.ok) throw new Error(`ollama embed http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { embeddings: number[][] };
    return { vectors: j.embeddings, ms: performance.now() - t0 };
}

export function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
