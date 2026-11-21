---
name: low-latency-reaction
description: Work on the low-latency acknowledgement test bed in this fork of simple-conversation-relay. Use when asked to switch the latency mode, run or tune the filler matcher (embedding or Jev), run the test harness or offline eval, view the /latency/ page, or restart the server for a live call.
---

# Low-latency reaction (feature/system-1)

A caller's prompt starts two things together: the LLM call, and a matcher that picks a short spoken acknowledgement ("Okay.", "Good question."). The acknowledgement is sent as `{type:'text', token, last:false}` so the LLM tokens continue the same utterance. If no match lands within `LATENCY_FILLER_BUDGET_MS` (350), a neutral fallback line is spoken and any late match is dropped. Every turn gets exactly one acknowledgement in `jev` and `embedding` mode; `none` is the baseline.

All paths are under `server/`. Secrets are in `server/.env` (git-ignored): never print them.

## Mode

- `GET /latency/mode` returns `{mode, available}`. `PUT` or `POST` `{"mode":"none|jev|embedding"}` sets it (in memory; default from `LATENCY_MODE`). No auth.
- `GET /latency/` serves `public/latency.html`: the explainer plus a mode selector. Open it at `http://localhost:3007/latency/` (or the ngrok host).
- Always set the mode before a live call, and do not run the harness during one (the harness switches modes and restores the original).

## Run the server

Port 3007, ngrok `https://crelay-des.ngrok.dev`. Restart after code changes:
```
pkill -f "tsx src/server.ts"; pkill -f "npm exec tsx"
cd server && nohup npx tsx src/server.ts > /tmp/scr-server.log 2>&1 &
```
Log lines to read: `filler mode=… source=match|fallback id=… [reason=…] score=… ms=… sent|dropped` and `first LLM token Nms after prompt`. Fallback reasons: `catch-all`, `below-threshold`, `no-match`, `timeout`, `error`, `low-margin`.

## Code map

- `src/latency/mode.ts`, `modeRoute.ts`: mode state, `/latency` routes and page.
- `src/latency/fillers.ts`, `fillers.json`: 101-entry generic dictionary (15 categories, keyed by speech act and tone, never topic). `FILLERS_PATH` overrides it for experiments.
- `src/latency/matchFiller.ts`: `matchFiller`, `rank`, `gate`, `warmFillerBank`. Knobs: `LATENCY_EMBED_THRESHOLD` (0.59), `LATENCY_EMBED_MARGIN` (0.01), `LATENCY_EMBED_SCORE_BY` (`mean-top2`), `LATENCY_JEV_THRESHOLD` (0.5), `LATENCY_JEV_MARGIN`.
- `src/latency/fallbackFillers.ts`: neutral lines, rotated.
- `src/services/ConversationRelaySession.ts`: `sendFiller` and per-turn guards (`turnSeq`, `llmStarted`).

## Measure

- Live-call style, no phone: `npx tsx scripts/harness/run.mts --phrases scripts/harness/phrases.json --modes embedding,jev --host localhost:3007 --no-llm-wait`.
- Offline accuracy: `npx tsx scripts/eval/eval-match.mts --set scripts/eval/holdout.json --mode embedding|jev [--threshold n] [--margin n] [--score-by s] [--fillers path]`. Jev runs are billable (one call per phrase).
- Tests: `npx vitest run` (one known failure: `ServerConfig` "leaves outboundApiKey undefined when unset", caused by an empty `OUTBOUND_API_KEY=` in `.env`). Typecheck: `npm run typecheck`.

## Rules learned

- Judge on `scripts/eval/holdout.json`, never on `dev.json`. Rewording the dictionary to fix dev misses overfit (dev up, holdout down). Tune parameters instead. Further dictionary work needs a new independent set.
- A wrong acknowledgement is worse than a neutral one, so favour fewer wrong matches.
- Fillers must stay generic (no topic, no promises). Emergency phrases (self-harm, medical, danger) need a separate rule ahead of matching; it is not built.

Current status and open items: `../.claude/plans/SYSTEM1-INCORPORATION.md` (sections 7c, 7d, 8), outside this git repo.
