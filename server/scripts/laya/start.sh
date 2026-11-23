#!/usr/bin/env bash
# Start laya-serve (Jev-compatible POST /v1/systemone) for the "laya" latency mode.
#   LAYA_CHECKPOINT=base|typed-decisions   (default base)
#   LAYA_PORT=8000                         (use 8001 to run the second checkpoint alongside)
#   LAYA_DEVICE=mps|cpu|cuda               (default mps; measured faster than cpu here)
#   LAYA_VENV=<venv dir>                   (default: <LowLatencyReaction>/.laya-venv)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="${LAYA_VENV:-$here/../../../../.laya-venv}"
case "${LAYA_CHECKPOINT:-base}" in
  base) model=english ;;
  typed-decisions) model=typed-decisions ;;
  *) echo "LAYA_CHECKPOINT must be base or typed-decisions" >&2; exit 1 ;;
esac
export HF_HUB_OFFLINE=1 USE_TF=0
export LAYA_MODELS="$model" LAYA_DEFAULT_MODEL="$model"
export LAYA_PORT="${LAYA_PORT:-8000}" LAYA_DEVICE="${LAYA_DEVICE:-mps}" LAYA_HOST="${LAYA_HOST:-127.0.0.1}"
export LAYA_TOURNAMENT_GROUP="${LAYA_TOURNAMENT_GROUP:-64}"  # lifts the 100-option cap (fillers.json has 101 + catch-all)
exec "$venv/bin/laya-serve"
