# Offline filler-matcher eval

Scores `matchFiller`'s internals (`rank` + `gate` in `src/latency/matchFiller.ts`) against a labelled phrase set. No server, WebSocket or OpenAI. Embedding mode needs local Ollama; jev mode needs `JEV_API_KEY` (read from `server/.env` by dotenv, never printed) and is billable.

    npx tsx scripts/eval/eval-match.mts --set scripts/eval/dev.json --mode embedding
    npx tsx scripts/eval/eval-match.mts --set scripts/eval/dev.json --mode jev --concurrency 4

Flags: `--set <phrases.json>` and `--mode embedding|jev` (required); `--fillers <path>` alternative dictionary (validated like `fillers.json`);
`--threshold N`, `--margin N`, `--score-by max|when-only|mean-top2` (embedding only); `--concurrency N` (default 4); `--out <path>` (default `out/eval-<mode>-<set>-<ts>.json`, git-ignored).
The call count is printed up front. Run it with `FILLERS_PATH=<path>` set and the matcher in the server also uses that dictionary.

## Phrase file

Array, or `{ "phrases": [...] }`, of `{ text, expectCategory?, acceptCategories?: string[], ambiguous?: boolean, expectFallback?: boolean }`.
Each phrase needs `expectCategory`, `acceptCategories` or `expectFallback`. `dev.json` is `scripts/harness/phrases.json` plus `acceptCategories` where the matcher's behaviour was reasonable.

## Matcher knobs (defaults preserve the old behaviour)

| Env | Per-call | Meaning |
| --- | --- | --- |
| `FILLERS_PATH` | `fillersPath` | dictionary file instead of bundled `fillers.json`; one embedded bank per dictionary |
| `LATENCY_EMBED_THRESHOLD` (0.6) / `LATENCY_JEV_THRESHOLD` (0.5) | `threshold` | min top-1 score |
| `LATENCY_EMBED_MARGIN` / `LATENCY_JEV_MARGIN` (0 = off) | `margin` | min top-1 minus top-2 (embedding: best vs. second-best *filler*; jev: top two probabilities); miss reason `low-margin` |
| `LATENCY_EMBED_SCORE_BY` (`max`) | `scoreBy` | per-filler score: best doc / the `when` doc only / mean of its two best docs |

A best match whose filler category is `catch-all` is a miss (`catch-all`), in both modes (jev also treats its own `generic-ack` option that way).

## Metrics

Per phrase: CORRECT = matched filler's category is in `acceptCategories` or equals `expectCategory`; WRONG = matched but not accepted; FALLBACK = miss.
For `expectFallback` phrases a miss is CORRECT and any match is WRONG. Errors (e.g. jev timeout, 600ms as in production) count as FALLBACK and are tallied in `errors`.

- `correctRate`, `wrongRate`, `fallbackRate`: share of all phrases.
- `wrongMatchRateAmongMatches` (1 - precision): wrong / (phrases that got a match).
- `usefulRate`: correct / total.
- `p50Ms`, `p95Ms`: time of the ranking call per phrase (embedding: one query embed, bank pre-warmed; jev: the API call).
- Per phrase: top-1 filler/category, `score` (cosine or jev probability), `margin`, matched filler, miss reason, outcome.
- `aggregateExcludingAmbiguous`: same, without `ambiguous` phrases.
- `sweep`: recomputed from stored top-1 scores/margins without any model call. Embedding: thresholds 0.50..0.80 step 0.02 x margins 0/0.02/0.04. Jev: thresholds 0.30..0.95 step 0.05 x margins 0/0.1/0.2. Sweeps assume the run's `--score-by`; catch-all top-1s are never matches.
