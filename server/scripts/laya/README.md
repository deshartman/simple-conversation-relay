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
