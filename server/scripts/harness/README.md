# ConversationRelay test harness

Plays Twilio against `/conversation-relay`: opens a fresh WS per phrase (new callSid), sends `setup` then a `prompt`, records `text` frames.

    npx tsx scripts/harness/run.mts --phrases scripts/harness/phrases.json --modes none,jev,embedding --host localhost:3007

Flags: `--settle-ms 4000` (max wait after prompt), `--quiet-ms 700` (quiet after `last:true`), `--only <category>`, `--limit N`,
`--no-llm-wait` (close ~150ms after first frame; the OpenAI call is still started), `--interrupt-after-ms N` (send `interrupt`),
`--log-file /tmp/scr-server.log` (per-turn lines matching /match|filler|latency/ are attached to each result as `serverLog`).

The run prints the number of sessions (= OpenAI calls) up front. The original `/latency/mode` is restored at the end and on Ctrl-C.
Output: console table + summary, and `out/results-<ts>.{json,csv}` (git-ignored).

Auth: the server checks `X-Twilio-Signature` on the WS upgrade (unless `TWILIO_VALIDATE_WEBHOOKS=false`). The harness reads `AUTH_TOKEN`
from `server/.env` (via dotenv, never printed) and signs `wss://<host>/conversation-relay`, matching `isValidWsUpgrade`.

Filler match: first frame text starts with a `say` from `src/latency/fillers.json`. Category agreement = matched filler category == `expectCategory`.
Limitations: a first frame that merely coincides with a filler prefix is a false positive (unlikely); sequential runs only.
