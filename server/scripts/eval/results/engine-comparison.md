# Latency engine comparison

Date: 2026-11-23  |  Machine: Apple M4, macOS 26.6.2  |  laya 0.5.2, torch 2.15.0, Ollama 0.34.4 (Docker)

one session, back to back, concurrency 1, each engine committed default threshold/margin, no tuning on holdout; p50/p95 are client-side ranking-call ms.

## Filler matching (correct / wrong / fallback; useful rate; wrong among matches; p50 / p95 ms)

| Engine | Set | C / W / F | Useful | Wrong of matches | Errors | p50 | p95 |
|---|---|---|---|---|---|---|---|
| jev | dev (66) | 64 / 1 / 1 | 97.0% | 1.5% | 0 | 237 | 325 |
| jev | holdout (150) | 132 / 10 / 8 | 88.0% | 7.5% | 0 | 230 | 285 |
| embedding | dev (66) | 47 / 1 / 18 | 71.2% | 2.1% | 0 | 17 | 58 |
| embedding | holdout (150) | 91 / 10 / 49 | 60.7% | 11.4% | 0 | 24 | 61 |
| laya-base | dev (66) | 21 / 37 / 8 | 31.8% | 63.8% | 0 | 208 | 220 |
| laya-base | holdout (150) | 46 / 83 / 21 | 30.7% | 64.8% | 0 | 216 | 229 |
| laya-typed | dev (66) | 18 / 25 / 23 | 27.3% | 58.1% | 0 | 220 | 235 |
| laya-typed | holdout (150) | 48 / 60 / 42 | 32.0% | 60.0% | 0 | 224 | 235 |

## Coherence (40 phrases)

| Engine | Score | question | statement | filler | changed-mind | Errors | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|
| jev | 39/40 | 10/10 | 9/10 | 10/10 | 10/10 | 0 | 188 | 236 |
| embedding | 31/40 | 6/10 | 6/10 | 10/10 | 9/10 | 0 | 21 | 45 |
| laya-base | 15/40 | 0/10 | 8/10 | 1/10 | 6/10 | 0 | 82 | 87 |
| laya-typed | 12/40 | 0/10 | 2/10 | 0/10 | 10/10 | 0 | 89 | 102 |

## Deployment

| Engine | Location | Cost | RAM | Disk | Warm-up |
|---|---|---|---|---|---|
| jev | remote (api.typesafe.ai, HTTPS) | billable per call (Jev API) | n/a (remote) | none locally (hosted) | TLS keep-alive warm via HEAD (~tens of ms); no model load |
| embedding | local (Ollama nomic-embed-text in Docker, CPU) | free (local compute) | 538 MB | 274 MB (nomic-embed-text) | bank embed on first use (+1 warm-up embed); model loads on first request, unloads after ~5 min idle |
| laya-base | local (laya-serve on MPS, :8000, model english) | free (local compute) | 231 MB | 804 MB (model.safetensors) | server ready ~5 s after launch; first MPS call ~0.3 s with warm Metal cache (~13 s on a never-compiled machine per README) |
| laya-typed | local (laya-serve on MPS, :8001, model typed-decisions) | free (local compute) | 282 MB | 807 MB (typed-decisions/) | server ready ~5.0 s after launch; first call 0.33 s, then ~30 ms direct (measured on typed-decisions) |

Jev billable calls: 257 (66 dev + 150 holdout + 40 coherence + 1 coherence warm-up).

## Caveats

- Laya filler matching puts all 102 filler options in one choice question, split into tournament groups of 64 (LAYA_TOURNAMENT_GROUP); the model card says accuracy degrades above ~20 options, so Laya is run outside its intended regime here and 'probabilities' only cover the finalists.
- Thresholds (jev 0.5, embedding 0.6, laya 0.6) were chosen on dev only; holdout was not used for tuning. Laya probabilities are over-confident, so its threshold barely separates right from wrong.
- laya-serve warns that the checkpoint ships invalid temperatures (values outside [0.5, 5]) so confidence from affected entries is uncalibrated; this likely hurts thresholding.
- Coherence 'question' scored 0/10 on both Laya checkpoints. Client, labels and response mapping were verified correct (valid responses, choice names match); probabilities are near-uniform (top ~0.3-0.45). Retrying without the per-class 'examples' lists flipped one probe to question, so the long examples payload may hurt, but prompts were not reworded: Laya receives the same question text as Jev.
- Latency is not like-for-like: Jev p50 includes network+TLS to a hosted API; Laya includes local HTTP to MPS-backed laya-serve; embedding runs Ollama on CPU inside Docker (Ollama has no GPU access on macOS Docker). Coherence per-call times are lower than filler times because the coherence question has 4 options vs 102.
- Laya RSS is the server process only (MPS/unified-memory weights are partly outside RSS), sampled after the runs with both checkpoints running; the Ollama figure is the whole Docker container (docker stats), not the model alone.
- Dev/holdout sets are small (66/150), so differences of a few points are within noise. Only one run per engine; no repeat variance measured.
- ServerConfig.test 'leaves outboundApiKey undefined when unset' fails because the local server/.env sets OUTBOUND_API_KEY to an empty string; it passes on v4.low-latency in a clean worktree without .env and fails there too once .env is copied in. Not caused by the laya changes.
