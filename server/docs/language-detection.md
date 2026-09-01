# Automatic Language Detection and Switching

How this server detects the language a caller is speaking and answers them in a matching voice, without the caller or the LLM having to ask for it.

## Behaviour

A caller dials in, is greeted in English, and starts speaking French. From the next utterance onward the assistant replies in French, spoken with the voice configured for `fr-FR`. If they switch to Spanish, it follows. If they switch back to English, it follows back. If they explicitly ask for a language ("can you speak English?"), that request wins and sticks.

## The one thing to understand first

ConversationRelay's automatic detection **reports** the language it heard. It does **not** switch anything.

This is the single most common misreading of the feature, because the `<Language>` element looks like it should close the loop by itself. It doesn't. From the Twilio docs:

> "Adding the `<Language>` element **doesn't set it as** the text-to-speech or speech-to-text language."

> \[with `transcriptionLanguage="multi"`\] "the `lang` will **include the detected language**"

So `<Language>` is a lookup table — in the docs' words, it *"maps a language code to a set of text-to-speech and speech-to-text settings"* — and detection is a read. Something has to sit in the middle and decide to act. On this server, that something is `ConversationRelaySession.autoSwitchTtsLanguage()`.

```
                     WHAT THE PLATFORM GIVES YOU
  caller speaks French
    -> Deepgram (multi) detects
    -> prompt frame arrives carrying  lang: "fr"      <- reports, then stops
    -> active TTS language unchanged; English voice answers

                     WHAT THIS SERVER ADDS
  caller speaks French
    -> prompt frame arrives carrying  lang: "fr"
    -> autoSwitchTtsLanguage("fr")  maps tag -> declared code "fr-FR"
    -> sends  { type: "language", ttsLanguage: "fr-FR" }
    -> <Language code="fr-FR"> is consulted -> its voice + provider are used
    -> French voice answers
```

## Configuration

`server/assets/serverConfig.json`, under `ConversationRelay.Configuration`:

```json
{
    "transcriptionLanguage": "multi",
    "transcriptionProvider": "Deepgram",
    "speechModel": "nova-3-general",
    "ttsLanguage": "multi",
    "ttsProvider": "ElevenLabs",
    "voice": "IKne3meq5aSn9XLyUdCD",
    "languages": [
        { "code": "en-AU", "ttsProvider": "ElevenLabs", "voice": "IKne3meq5aSn9XLyUdCD", "transcriptionProvider": "Deepgram", "speechModel": "nova-3-general" },
        { "code": "fr-FR", "ttsProvider": "ElevenLabs", "voice": "<french voice id>",    "transcriptionProvider": "Deepgram", "speechModel": "nova-3-general" }
    ]
}
```

Non-negotiable pairings — getting these wrong sends an error frame and **disconnects the call**:

| Setting | Requirement |
|---|---|
| `transcriptionLanguage: "multi"` | `transcriptionProvider` **must** be `Deepgram` |
| `ttsLanguage: "multi"` | `ttsProvider` **must** be `ElevenLabs` |
| `transcriptionProvider` / `speechModel` | must be a valid pair (e.g. Deepgram + `nova-3-general`) |
| `ttsProvider` / `voice` | must be a valid pair |

### The `languages` array is the allow-list

It serves two purposes, and the second one is this server's own convention rather than a platform behaviour:

1. **Platform:** it renders as `<Language>` children, defining the voice/provider/model used when a language code becomes active.
2. **This server:** it is the allow-list for automatic switching. A detected language with no declared entry is **left alone** — German is transcribed fine, but TTS won't be dragged somewhere undefined.

Only the parent `<ConversationRelay>` attributes decide what is active at the start of the call. Adding to this array never changes the opening language.

## Code path

| Step | Location |
|---|---|
| Renders `<Language>` children from `languages` | `src/services/TwilioService.ts` — `connectConversationRelay()` |
| Supplies declared codes + opening `ttsLanguage` to the session | `src/server.ts` — the `new ConversationRelaySession({...})` call |
| Builds the `primary tag -> declared code` map | `src/services/ConversationRelaySession.ts` — constructor |
| Reads `lang` off each prompt and switches TTS | `src/services/ConversationRelaySession.ts` — `autoSwitchTtsLanguage()` |
| Explicit caller-requested switch (LLM tool) | `src/tools/switch-language.ts` -> `ConversationRelaySession.switchLanguage()` |
| Tells the LLM to answer in the caller's language | `assets/defaultContext.md` — `[Match the caller's language]` |

`lang` carries the **primary tag only** — `"fr"`, never `"fr-FR"`. That is why the session maps a tag onto a declared code rather than comparing codes directly, and why a caller detected as `fr-CA` still resolves to a declared `fr-FR`.

## Design decisions

**Switching happens in code, not through the LLM.** Detection already produces a reliable answer, so routing it through the model would add a tool round-trip, spend tokens, and introduce a chance of not firing — all to reproduce a four-line mapping. The `switch-language` tool remains for explicit caller requests.

**Only `ttsLanguage` is switched. `transcriptionLanguage` stays on `multi` for the whole call.** Pinning STT to the detected language would *end detection*: a caller who later drifted back to English would be transcribed by a French model, and nothing would signal it. Leaving STT on `multi` keeps every subsequent switch possible. The `switch-language` tool can still set both, because a caller asking for a specific language is asking to be pinned.

**An explicit switch latches off the automatic one.** Without this, a caller who says "please speak English" while continuing to speak French would be flipped straight back to French on the next prompt. `switchLanguage()` sets `manualLanguageOverride`, and automatic switching stops for the rest of the call.

**`ttsLanguage: "multi"` stays on the parent as a fallback.** If a detected language isn't declared, or the `language` frame is suppressed (listen mode gates `text`, `play`, and `language` frames), ElevenLabs still infers the language from the reply text. The switch *upgrades* to a declared voice rather than being the only thing preventing an English voice reading French.

**Switching fires on change only.** Re-sending the active code on every prompt would be pure noise on the wire.

## Verified behaviour

| Detected sequence | `ttsLanguage` frames sent |
|---|---|
| `en, en, fr, fr, fr, es, en` | `en-AU`, `fr-FR`, `es-ES`, `en-AU` — 4 frames for 7 prompts |
| `de`, `ja`, or `lang` absent | none — undeclared languages are left alone |
| `fr`, then caller asks for English, then keeps speaking French | `fr-FR`, `en-AU`, then nothing — the request holds |
| `fr-CA` | `fr-FR` — full tags resolve via primary tag |

## The prompt rule is load-bearing

Switching TTS to `fr-FR` only sets *how* text is spoken. The LLM still decides *what language it writes in*. If it answers in English after the switch, a French voice reads English text — worse than not switching at all.

`assets/defaultContext.md` carries the `[Match the caller's language]` guardrail. Two of its clauses matter more than they look:

- **Wait for a full sentence** in the new language. A single foreign word inside an English sentence is usually a transcription artefact, not a language change.
- **Only call `switch-language` when the caller explicitly asks.** Any other use trips the latch and disables automatic switching for the remainder of the call.

If you rewrite that bullet, keep both.

## Adding a language

1. Append an entry to `languages` in `serverConfig.json` with a `code` and a `voice` valid for its `ttsProvider`.
2. Restart the server (config is read into `CachedAssetsService` at startup).
3. Nothing else. The allow-list, the tag mapping, and the `<Language>` element all derive from that entry.

Verify by placing a call and watching for:

```
[Session] Call SID: CAxxx] Detected 'fr' — switching ttsLanguage to fr-FR
```

## Gotchas

**Duplicate JSON keys fail silently.** `JSON.parse` keeps the *last* occurrence with no warning. A config that declares `transcriptionLanguage` twice — once as `multi`, later as `en-AU` — is an English-only config, and nothing anywhere reports it. This exact bug is why detection appeared broken before this feature existed. To check:

```bash
python3 -c "
import json
found=[]
def dup(pairs):
    seen={}
    for k,v in pairs:
        if k in seen: found.append(k)
        seen[k]=v
    return seen
json.load(open('assets/serverConfig.json'),object_pairs_hook=dup)
print('duplicates:', found or 'none')"
```

**`language` vs `ttsLanguage`/`transcriptionLanguage`.** The `language` attribute sets both at once and sits *lowest* in both precedence lists, so the two specific attributes override it. Setting all three is redundant and misleading; this config sets only the specific two.

**Declaring is not activating.** Adding a `<Language>` element never changes what the call opens with, and detection never activates one on its own.

**Switching to an undeclared code is unspecified.** The Twilio docs neither permit nor forbid it, and don't describe how voice resolution would work. This server therefore only ever switches into codes present in `languages`.

## References

- [`<ConversationRelay>` TwiML reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay) — the `<Language>` noun, the TTS/STT precedence lists, and the `multi` provider constraints.
