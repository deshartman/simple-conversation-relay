# Laya (local System 1) for the `laya` latency mode

`laya-serve` exposes a Jev-compatible `POST /v1/systemone`; the server's `laya` mode reuses the Jev client against it.

## Setup (once)

    uv venv --python 3.12 <LowLatencyReaction>/.laya-venv
    uv pip install --python <LowLatencyReaction>/.laya-venv/bin/python "laya[serve]"

The venv lives outside the repo at `LowLatencyReaction/.laya-venv` (override with `LAYA_VENV`).
Weights come from the Hugging Face cache, `~/.cache/huggingface/hub/models--convaiinnovations--laya`
(`start.sh` runs with `HF_HUB_OFFLINE=1`, `USE_TF=0`).

## Start

    scripts/laya/start.sh                                              # base (english), :8000
    LAYA_CHECKPOINT=typed-decisions LAYA_PORT=8001 scripts/laya/start.sh   # typed-decisions, :8001

Both can run at once. Env: `LAYA_CHECKPOINT=base|typed-decisions`, `LAYA_PORT` (8000), `LAYA_DEVICE` (mps; cpu is ~2x slower),
`LAYA_HOST` (127.0.0.1), `LAYA_TOURNAMENT_GROUP` (64), `LAYA_API_KEY` (optional bearer).
The first MPS call compiles kernels (~13 s); the server warms it (`LATENCY_LAYA_WARM`).

## Point the server at it

    LATENCY_MODE=laya LAYA_BASE_URL=http://localhost:8000 LAYA_MODEL=english
    LATENCY_MODE=laya LAYA_BASE_URL=http://localhost:8001 LAYA_MODEL=typed-decisions

`LAYA_MODEL` matters: laya-serve ignores which checkpoint it was started with and auto-routes each request
(to `english` for English text) unless the request names one.

## Notes

- laya-serve caps a choice at 100 options; the filler question has 102. `LAYA_TOURNAMENT_GROUP` lifts the cap by answering in groups,
  so `probabilities` only covers the finalists.
- Laya probabilities are over-confident: threshold barely separates right from wrong on `dev.json`.
- Fine-tuning and calibration do not fix this: after both, wrong answers on the holdout still score a median 0.991 (right ones 0.995).

## Fine-tuning on the filler bank (`train/`, 2026-11-24): evaluated, not adopted

Why base Laya scores low: options share one `head_max_len` budget (192 tokens on `english`). In a 51-option group that is
about 4 tokens per option, roughly the start of the ID. Measured with Laya's tokenizer, an ID is ~4 tokens, ID plus `what`
~17, a full option with 4 examples ~42 (medians); all 102 options are ~4,300 tokens. Jev reads all of it.

Steps (run from `server/`):

1. `python3 scripts/laya/train/gen_data.py --out <dir>/train.jsonl`: 953 utterances (fillers.json examples,
   `paraphrases.txt`, `negatives.txt` -> `generic-ack`; exact eval-set texts dropped), 1,906 rows. Each utterance gives the
   51-option group that holds its target and a 2-option final, matching the runtime tournament.
2. `laya-train` from the `typed-decisions` checkpoint with `head_max_len` 1024, `max_len` 1280, 3 epochs, choice options
   shuffled (settings are recorded in the checkpoint's `rl_agent_config.json`; the exact command line was not saved).
   76 minutes on the M4 (MPS).
3. `python scripts/laya/train/calibrate_dev.py <ckpt> --write-config`: fits temperatures on `dev.json` only. Both buckets
   hit the 5.0 ceiling.
4. Serve and point the server at it:

       HF_HUB_OFFLINE=1 USE_TF=0 LAYA_EXTRA_MODELS='{"fillerft":"<ckpt>"}' LAYA_MODELS=fillerft LAYA_DEFAULT_MODEL=fillerft \
         LAYA_PORT=8010 LAYA_DEVICE=mps LAYA_TOURNAMENT_GROUP=64 <venv>/bin/laya-serve
       LATENCY_MODE=laya LAYA_BASE_URL=http://localhost:8010 LAYA_MODEL=fillerft

Results (threshold 0.6, margin 0, same eval scripts as `scripts/eval/results/engine-comparison.md`):

| | Dev useful | Holdout useful | Holdout wrong of matches | Coherence | Holdout p50 / p95 |
|---|---|---|---|---|---|
| Laya fine-tuned | 84.8% | 69.3% | 29.5% | 27/40 | 809 / 833 ms |
| Laya base | 31.8% | 30.7% | 64.8% | 15/40 | 216 / 229 ms |
| Embedding | 71.2% | 60.7% | 11.4% | 31/40 | 24 / 61 ms |
| Jev | 97.0% | 88.0% | 7.5% | 39/40 | 230 / 285 ms |

Not adopted: too slow (two passes, close to the 1000 ms `LAYA_TIMEOUT_MS`), wrong answers cannot be filtered by
confidence, and every filler edit needs a retrain. laya-train's own report (78% after) is in-sample, not evidence.

Smaller tournament groups do not help either (base, holdout): groups of 16 gave 27.3% useful at 828 ms, groups of 12
23.3% at 935 ms, against 30.7% at 216 ms with 51. `typed-decisions` fell back on 90% of rows at both sizes.

The checkpoint (1.6 GB) and run outputs are in `/tmp/laya-ft/` and `/tmp/laya-group-eval/`, not in the repo. `/tmp` can be
cleared, so copy them somewhere durable if they are needed again.
