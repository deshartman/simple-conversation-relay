# Outbound Calling with Hybrid Human/Machine Discrimination

## Context

Add outbound calling driven by [server/assets/outbound.csv](server/assets/outbound.csv). Each call must distinguish human from answering machine and behave appropriately. Existing `/outboundCall` + `TwilioService.makeOutboundCall()` + `parameterDataMap` handle the call-placement plumbing.

Three findings from code verification that shape this plan:

1. **Tools cannot directly emit spoken text.** [ConversationRelayService.ts:176-179](server/src/services/ConversationRelayService.ts#L176-L179) drops `type:"text"` outgoingMessages returned from tools. Tools speak by mutating service state (e.g., flipping listen mode off) so the LLM's *follow-up* response tokens reach Twilio.
2. **Each `prompt` message triggers a full independent LLM response** at [ConversationRelayService.ts:285](server/src/services/ConversationRelayService.ts#L285) — no batching. Pure listen-mode classification is vulnerable to the silence gap between a machine's greeting and its beep.
3. **`contextKey` custom parameter is already logged but ignored** at [server.ts:221-224](server/src/server.ts#L221-L224). Wiring it through is completing an intended feature, not rewriting core logic.

## Strategy: Hybrid listen-then-probe

- Brief 2-second listen window at call start. If a short (<5 words) transcript arrives, classify as HUMAN and engage.
- Otherwise (no prompt or long machine greeting in the window), disable listen mode and speak a probe: *"Hello? Is this {name}?"*
- If response arrives → human, continue conversation.
- If 4 seconds of silence after the probe → machine, speak voicemail with callback number and end call.

The probe doubles as the voicemail opener if the machine was still playing its greeting — this is deliberate. It costs a slightly awkward "Hello? Is this Des?" at the start of the voicemail but guarantees we never miss the beep.

## Change footprint

**New files:**
1. `server/assets/outboundContext.md`
2. `server/src/tools/leave-voicemail.ts`
3. `server/src/tools/engage-conversation.ts`

**Additive edits (new code blocks, existing lines untouched):**
4. `server/src/server.ts` — new `POST /outboundCampaign` endpoint
5. `server/assets/defaultToolManifest.json` — add 2 tool entries

**Modified existing code (minimal, justified):**
6. `server/src/server.ts` WebSocket handler at line 221-224 — wire `contextKey` + `manifestKey` to `cachedAssetsService.getContext()/getManifest()` before constructing `OpenAIResponseService`. ~6 lines changed.
7. `server/src/services/OpenAIResponseService.ts` — add `setListenMode()` public method (additive to the class).
8. `server/src/tools/set-listen-mode.ts` — fix stub to actually call `responseService.setListenMode()` (3-line bug fix).

**NOT touched:** `ConversationRelayService.ts`, `TwilioService.ts`, `CachedAssetsService.ts`, `ServerConfig.ts`, `serverConfig.json`, `package.json`.

## Files in detail

### outboundContext.md (replaces default when loaded via contextKey)

Instructs the LLM to act as "Alex from [Company]" (hardcoded identity per user decision). Covers:
- **Phase 1 — brief listen (≤2s):** If you receive a short prompt (fewer than 5 words, conversational) within the first 2 seconds, call `engage-conversation` then speak: *"Hi {customer_name}, this is Alex from [Company]. I'm calling about {reason}. Do you have a moment?"*
- **Phase 2 — probe:** If no short human-style prompt arrives, or if a long machine-like prompt arrives ("leave a message", "at the beep"), call `engage-conversation` (turns off listen mode) then speak: *"Hello? Is this {customer_name}?"*
- **Phase 3 — assess probe response:**
  - Any natural response ("Yes", "speaking", "this is Des") → you reached a human. Continue: *"This is Alex from [Company]. I'm calling about {reason}. Do you have a moment?"*
  - Silence detection (existing 20s timer at [serverConfig.json:47](server/assets/serverConfig.json#L47)) will eventually trigger "Still there?" — if THAT fires without response, call `leave-voicemail` and then `end-call`.

The 2-second window is enforced via prompt instruction plus the LLM's own judgment — not via timer code. We rely on the LLM interpreting "if the first transcript is long and machine-like, probe instead" in-context.

### leave-voicemail.ts

```typescript
export default async function(args: { message: string }, responseService?: any) {
  const callback = (process.env.CALLBACK_NUMBER || '').split('').join(' ');
  responseService?.setListenMode?.(false);
  return {
    success: true,
    instructions: `Now say exactly: "${args.message} Please call us back at ${callback}. Thank you." Then call the end-call tool with a brief summary.`
  };
}
```

Returns no `outgoingMessage`. The follow-up LLM response at [OpenAIResponseService.ts:399](server/src/services/OpenAIResponseService.ts#L399) consumes the tool result and generates the spoken text, which now flows through (listen mode off).

### engage-conversation.ts

```typescript
export default async function(args: any, responseService?: any) {
  responseService?.setListenMode?.(false);
  return { success: true, message: 'Listen mode disabled; engaging conversation.' };
}
```

### OpenAIResponseService.setListenMode()

```typescript
setListenMode(enabled: boolean): void {
  this.listenMode = enabled;
  logOut('OpenAIResponseService', `Listen mode set to ${enabled}`);
}
```

### set-listen-mode.ts bug fix

Change the function signature to accept `responseService` as 2nd arg, and before returning call `responseService?.setListenMode(functionArguments.enabled)`.

### server.ts — contextKey wiring (existing code modification)

At [server.ts:221-224](server/src/server.ts#L221-L224), replace the log-only block with:

```typescript
let context = activeAssets.context;
let manifest = activeAssets.manifest;
if (message.customParameters?.contextKey) {
  const overrideContext = cachedAssetsService.getContext(message.customParameters.contextKey);
  if (overrideContext) context = overrideContext;
}
if (message.customParameters?.manifestKey) {
  const overrideManifest = cachedAssetsService.getManifest(message.customParameters.manifestKey);
  if (overrideManifest) manifest = overrideManifest;
}
```

Then pass `context` and `manifest` (instead of `activeAssets.context` / `activeAssets.manifest`) into the `new OpenAIResponseService(...)` call at [server.ts:232-238](server/src/server.ts#L232-L238).

### server.ts — new /outboundCampaign endpoint

Added as a new block; no existing code touched. Reads `outbound.csv`, iterates rows, fire-and-forgets per row:

```typescript
app.post('/outboundCampaign', async (req, res) => {
  const csv = readFileSync(path.join(__dirname, '..', 'assets', 'outbound.csv'), 'utf-8');
  const lines = csv.trim().split('\n').slice(1);
  const queued = [];
  for (const line of lines) {
    const [customer, number, enquiry] = line.split(',').map(s => s.trim());
    const callReference = crypto.randomUUID();
    parameterDataMap.set(callReference, {
      requestData: { customer_name: customer, reason: enquiry, phoneNumber: number }
    });
    twilioService.makeOutboundCall(
      serverConfig.serverBaseUrl,
      number,
      cachedAssetsService!,
      { callReference, contextKey: 'outboundContext' }
    ).catch(err => logError('Campaign', `Call to ${customer} failed: ${err.message}`));
    queued.push({ customer, callReference });
  }
  res.json({ queued: queued.length, calls: queued });
});
```

`contextKey: 'outboundContext'` flows through TwilioService parameters → TwiML `<Parameter>` → setup message customParameters → the new wiring above loads `outboundContext.md` as the instructions for that session.

### defaultToolManifest.json additions

Two entries added:

```json
{
  "type": "function",
  "name": "engage-conversation",
  "description": "Call this when you detect a human has answered the outbound call. Disables listen mode so your next response is spoken to the caller.",
  "parameters": { "type": "object", "properties": {}, "required": [] },
  "strict": false
},
{
  "type": "function",
  "name": "leave-voicemail",
  "description": "Call this when leaving a voicemail message. Disables listen mode and prepares a spoken message with the callback number automatically appended. After this, call end-call.",
  "parameters": {
    "type": "object",
    "properties": {
      "message": { "type": "string", "description": "The voicemail text WITHOUT the callback number. 1-3 sentences." }
    },
    "required": ["message"]
  },
  "strict": false
}
```

## Environment

Add to `.env.dev` and `.env.prod`:

```
CALLBACK_NUMBER=+61...
```

No `ServerConfig.ts` change — `leave-voicemail.ts` reads `process.env.CALLBACK_NUMBER` directly.

## Resolved decisions

- **Agent identity**: hardcoded in `outboundContext.md` as "Alex from [Company]". Replace `[Company]` with your org name when writing the file.
- **Classification**: hybrid (brief listen → probe).
- **Context switching**: wire the `contextKey` parameter (completes an intended feature).
- **Failsafe timeout**: none; rely on existing 20s silence detection.
- **Voicemail length**: uncapped; prompt asks for brevity.
- **Concurrency**: fire-and-forget.

## Accepted v1 quirks

1. **Welcome greeting "Hello there!"** still fires on outbound connections (from [serverConfig.json:4](server/assets/serverConfig.json#L4)). The outbound prompt tells the LLM to ignore it. Would need a `TwilioService` change to fully suppress; not worth it for v1.
2. **Callback number via `process.env`** direct read inside the tool — minor architectural inconsistency vs. reading from `ServerConfig`, accepted for additive-ness.
3. **2-second listen window is LLM-judged, not timer-enforced.** If the LLM is slow to respond on first prompt, we might have listened longer than intended. Observable via logs; tighten the prompt if it misbehaves in practice.

## Verification

1. `cd server && npm run dev` — server starts cleanly.
2. `/conversation` sanity: send a prompt that asks the LLM to call `set-listen-mode({enabled:true})`, then another prompt — confirm no text token reaches the response body (listen mode actually suppresses).
3. Context switch sanity: `curl -X POST .../outboundCall` with `{"properties":{"phoneNumber":"+...","callReference":"test1","contextKey":"outboundContext"}}` — call your own number, verify the LLM introduces itself as Alex (not as a Conversation Relay specialist).
4. Human path: put one row in `outbound.csv` with your own number. `curl -X POST .../outboundCampaign`. Answer with "Hello?". Expect: AI engages with the outbound intro within ~2s.
5. Probe path: answer the same call with silence for 2s. Expect: AI probes "Hello? Is this {name}?".
6. Voicemail path: don't answer; let call go to voicemail. Expect: voicemail contains the intro + callback number spelled digit-by-digit.
7. Logs to watch: `Listen mode set to true` at setup, `Listen mode set to false` after `engage-conversation` or `leave-voicemail` fires, then `Complete response` lines.

## Change footprint summary

| File | Type | Notes |
|---|---|---|
| `server/assets/outboundContext.md` | NEW | ~40 lines |
| `server/src/tools/leave-voicemail.ts` | NEW | ~15 lines |
| `server/src/tools/engage-conversation.ts` | NEW | ~10 lines |
| `server/assets/defaultToolManifest.json` | ADD entries | ~30 lines added |
| `server/src/server.ts` (new endpoint) | NEW BLOCK | ~25 lines added |
| `server/src/server.ts` (contextKey wiring) | MODIFIED | ~8 lines changed at the existing log-only block |
| `server/src/services/OpenAIResponseService.ts` | ADD method | ~4 lines added |
| `server/src/tools/set-listen-mode.ts` | BUG FIX | ~3 lines changed |
| `.env.dev` / `.env.prod` | ADD var | 1 line each |

Core orchestrators untouched.
