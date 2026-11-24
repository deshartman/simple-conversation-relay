---
name: low-latency-reaction
description: Work on the low-latency acknowledgement and Handler test bed in this fork of simple-conversation-relay. Use when asked to switch the latency mode, set the Handler, question wait or test delay, run or tune the filler matcher or coherence classifier (embedding or Jev), run the test harness or offline evals, read the latency log lines, view the /latency/ page, or restart the server for a live call.
---

# Low-latency reaction (branch `v4.low-latency`)

A caller's prompt starts two things together: the LLM call, and a matcher that picks a short spoken acknowledgement ("Okay.", "Good question."). The acknowledgement is sent as `{type:'text', token, last:false}` so the LLM tokens continue the same utterance. If no match lands within `LATENCY_FILLER_BUDGET_MS` (400), a neutral fallback line is spoken and any late match is dropped. Every turn gets exactly one acknowledgement in `jev` and `embedding` mode; `none` is the baseline.

All paths are under `server/`. Secrets are in `server/.env` (git-ignored): never print them.

## The Handler

A component that handles every piece the caller says, between the acknowledgement and the LLM:
1. Acknowledges the piece (the matched filler, or the neutral fallback).
2. Plays the hold sound (`public/media/hold.wav`, built by `scripts/make-hold-clip.mts`: 1 s of silence plus `typing.mp3`) as one `play {preemptible, interruptible}` per turn. The LLM's first token preempts it.
3. Classifies the piece (`src/latency/coherence.ts`): `question` (send now), `statement` (wait), `filler` (wait, then send what there is), `changed-mind` (send the whole buffer now). A classifier timeout or error sends at once.
4. Waits up to `question_wait` for more words, then sends one prompt to the LLM.
5. Merge (retract): a new piece that arrives before the first LLM token is merged into the unanswered question. If the LLM already has it, a `retract` event stops that stream and drops the unanswered user message.
6. Take-back: an interrupt before the first LLM token is NOT forwarded to the LLM service. The pending question is taken back and the next piece is merged. If none arrives, it is re-sent after max(`question_wait`, `LATENCY_TAKEBACK_WAIT_MS`).

Settings interact:
- Handler off: no hold, no waiting, no merge or take-back. Each piece goes straight to the LLM; only the mode's acknowledgement remains.
- `question_wait` 0 (the default): hold and merge/take-back stay on, only the wait for more words is off.
- Mode `none`: no acknowledgement, and the Handler needs one, so it is effectively baseline. Use `jev` or `embedding` to test the Handler.

## Runtime settings

All in memory, no auth, reset on every server restart. `GET` returns the value; `PUT` or `POST` sets it and returns the new value plus `previous` (400 on a bad value).

| Endpoint | Body | Reply | Valid |
|---|---|---|---|
| `/latency/mode` | `{"mode":"none\|jev\|embedding\|laya"}` | `{mode, previous}` (GET: `{mode, available}`) | one of the four. `laya` needs a local laya-serve (`server/scripts/laya/README.md`); evaluated, not recommended |
| `/latency/handler` | `{"enabled":true}` | `{enabled, previous}` | boolean |
| `/latency/question-wait` | `{"ms":2000}` | `{ms, previous}` | integer 0..10000, 0 = off |
| `/latency/delay` | `{"ms":4000}` | `{ms, previous}` | integer 0..20000. TEST ONLY: delays the LLM call so the hold is audible |

`GET /latency/` serves `public/latency.html`: the explainer plus controls for all four. Open it at `http://localhost:3007/latency/` (or the ngrok host).

Restore the usual test settings after every restart (do not run the harness during a live call; it switches modes and restores the original):
```
curl -s -X PUT localhost:3007/latency/mode -H 'content-type: application/json' -d '{"mode":"jev"}'
curl -s -X PUT localhost:3007/latency/handler -H 'content-type: application/json' -d '{"enabled":true}'
curl -s -X PUT localhost:3007/latency/question-wait -H 'content-type: application/json' -d '{"ms":2000}'
curl -s -X PUT localhost:3007/latency/delay -H 'content-type: application/json' -d '{"ms":4000}'
```

## Env knobs

Defaults only: each runtime setting above overrides its env var until restart. Set in `server/.env`; `.env.example` lists them.
- `LATENCY_MODE` (`none`), `LATENCY_HANDLER` (on; `off|false|0` = off), `LATENCY_QUESTION_WAIT_MS` (0), `LATENCY_TEST_LLM_DELAY_MS` (0).
- `LATENCY_FILLER_BUDGET_MS` (400): no match by then, speak the neutral fallback.
- `LATENCY_HOLD_URL` (unset: `https://$SERVER_BASE_URL/media/hold.wav`; empty: hold off), `LATENCY_HOLD_LOOP` (1).
- `LATENCY_COHERENCE_TIMEOUT_MS` (600), `LATENCY_TAKEBACK_WAIT_MS` (4000).
- `LATENCY_JEV_WARM` (on; `off|false|0` = off): HEAD request at call start and on switch to `jev`, so the first Jev call does not pay the TLS handshake.

## Run the server

Port 3007, ngrok `https://crelay-des.ngrok.dev`. Restart after code changes:
```
pkill -f "tsx src/server.ts"; pkill -f "npm exec tsx"
cd server && nohup npx tsx src/server.ts > /tmp/scr-server.log 2>&1 &
```
Run ONE server on 3007 and no stray `tsx watch`: a second one steals the port or the calls.

## Log lines to read

- `filler mode=… source=match|fallback id=… [reason=…] score=… ms=… sent|dropped` and `first LLM token Nms after prompt`. Fallback reasons: `catch-all`, `below-threshold`, `no-match`, `timeout`, `error`, `low-margin`.
- `hold sent url=… loop=…`, `hold skipped reason=stale|llm-started|listen-mode|handler-off|disabled`, `hold preempted Nms after hold sent`.
- `coherence class=… source=… ms=… action=send|wait`, `coherence flush reason=class|timeout|error|off pieces=N`, `coherence merge state=… pieces=N`.
- `interrupt before answer: took back pending question …` (take-back), `retracted unanswered prompt` (service dropped the unanswered user message), `stream stopped by interrupt (generation N)`.
- `jev warm ms=… status=404`: the 404 is expected, the HEAD only opens the socket.

## Code map

- `src/latency/mode.ts`, `modeRoute.ts`: mode state, `/latency` routes and page.
- `src/latency/fillers.ts`, `fillers.json`: 101-entry generic dictionary (15 categories, keyed by speech act and tone, never topic). `FILLERS_PATH` overrides it for experiments.
- `src/latency/coherence.ts`: `classifyCoherence` (Jev choice question with earlier pieces as context, or an embedding bank of 32 phrases that sees only the latest piece).
- `src/latency/matchFiller.ts`: `matchFiller`, `rank`, `gate`, `warmFillerBank`. Knobs: `LATENCY_EMBED_THRESHOLD` (0.59), `LATENCY_EMBED_MARGIN` (0.01), `LATENCY_EMBED_SCORE_BY` (`mean-top2`), `LATENCY_JEV_THRESHOLD` (0.5), `LATENCY_JEV_MARGIN`.
- `src/latency/fallbackFillers.ts`: neutral lines, rotated.
- `src/services/ConversationRelaySession.ts`: `sendFiller`, `maybeStartHold`, `routePrompt` / `flushPrompt` (Handler), and per-turn guards (`turnSeq`, `llmStarted`). `OpenAIResponseService.ts` handles the `retract` event.

## Measure

- Live-call style, no phone: `npx tsx scripts/harness/run.mts --phrases scripts/harness/phrases.json --modes embedding,jev --host localhost:3007 --no-llm-wait`.
- Offline accuracy: `npx tsx scripts/eval/eval-match.mts --set scripts/eval/holdout.json --mode embedding|jev [--threshold n] [--margin n] [--score-by s] [--fillers path]`. Jev runs are billable (one call per phrase).
- Coherence accuracy: `npx tsx scripts/eval/eval-coherence.mts --mode jev|embedding` (set `scripts/eval/coherence.json`, 40 phrases; Jev is billable). Jev 39/40 at ~194 ms median, embedding 31/40 at ~80 ms (often reads questions as statements, costing a needless wait). Recommend Jev.
- Tests: `npx vitest run` (296 passing, 1 known failure: `ServerConfig` "leaves outboundApiKey undefined when unset", caused by an empty `OUTBOUND_API_KEY=` in `.env`). Typecheck: `npm run typecheck`.

## Rules learned

- Judge on `scripts/eval/holdout.json`, never on `dev.json`. Rewording the dictionary to fix dev misses overfit (dev up, holdout down). Tune parameters instead. Further dictionary work needs a new independent set.
- A wrong acknowledgement is worse than a neutral one, so favour fewer wrong matches.
- Run ONE server on port 3007. A stray `tsx watch` or second instance breaks live calls.
- An interrupt before the first LLM token must not be forwarded to the LLM service: it kills the stream and loses the answer. Take the question back instead.
- Send at most one `play` per turn (`holdTurn`).
- Give take-back and the first-Jev-call timings room: the first Jev call can exceed 350 ms, hence budget 400 and the warm-up; a taken-back caller's words came about 3 s later, hence 4000.
- The ConversationAgent project's `typing.mp3` (the clip inside `hold.wav`) has no recorded licence. Confirm it before anything leaves the test bed.
- Fillers must stay generic (no topic, no promises). Emergency phrases (self-harm, medical, danger) need a separate rule ahead of matching; it is not built.

Current status and open items: `../.claude/plans/MEDIA-PLAYBACK.md` (sections 9 and 10-10e: hold, coherence, merge, take-back, call evidence) and `../.claude/plans/SYSTEM1-INCORPORATION.md`, both outside this git repo.
