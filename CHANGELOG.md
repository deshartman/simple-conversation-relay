# Changelog

## Release v4.13.0

### Outbound Readiness: Webhook Authentication, Stream Correctness, Automatic Language Detection

Everything merged since v4.12.0. Most of it came out of an outbound-call readiness review: v4.12 had only ever been exercised inbound, and the inbound `defaultContext.md` names none of the nine tools, so whole classes of defect had never been reached. Closes with automatic caller-language detection.

Test suite: **61 -> 121**.

#### 🔒 Security

**Twilio signature validation on every endpoint Twilio actually calls** (`src/middleware/twilio-signature.ts`)
- `/handoff`, `/twilioStatusCallback` and `/connectConversationRelay` were all unauthenticated.
- Host and protocol are pinned to `SERVER_BASE_URL` rather than inferred from the request — behind a tunnel Express sees `http://localhost:3007` while Twilio signed `https://<public-host>`, so inference fails every time.
- Controlled by `TWILIO_VALIDATE_WEBHOOKS`, defaulting to **on** and disabled only by the exact string `false`, so a typo cannot silently switch off signature checking.
- Throws at construction if validation is on with no auth token — failing at startup beats rejecting every webhook at runtime with an unexplained 500.
- **Fixed within this release:** the first implementation passed the auth token inside the options object. `twilio.webhook()` ends with `options.authToken = tokenString ? tokenString : process.env.TWILIO_AUTH_TOKEN`, which overwrites it with either a *positional* argument or `TWILIO_AUTH_TOKEN`. The SDK's own `WebhookOptions` type declares `authToken?: string`, so it typechecked and read correctly while being discarded at runtime — and this project reads `AUTH_TOKEN`, not `TWILIO_AUTH_TOKEN`. Every webhook was rejected, `/handoff` never ran, and status callbacks were dropped. The token is now passed positionally.

**Authenticated, rate-limited `POST /outboundCall`** (`src/middleware/outbound-guards.ts`)
- The endpoint placed calls billed to the Twilio account with no authentication, no rate limit and no number validation. Any POST carrying a phone number reached the carrier. The exposure is toll fraud rather than data leakage, so the fix is an authenticator plus a damage cap.
- Signature validation cannot cover this route: Twilio never calls it. It is our own API, public only because the whole app is tunnelled for Twilio's benefit.
- **Bearer token, failing closed.** SHA-256 digests compared with `timingSafeEqual`, so neither the token nor its length leaks. With no key configured the route answers **503** rather than serving unauthenticated — a forgotten secret must not silently reopen a billable endpoint.
- **E.164 validation**, returning 400 instead of the previous opaque 500 from the Twilio API. No country restriction, which means the rate limit is the only cap on a leaked token.
- **Rolling-minute rate limit**, default 30, counted **globally rather than per-IP**: Twilio spend is shared, and a per-IP limit is bypassed by rotating source addresses. In-memory, so the effective limit multiplies if this is ever scaled out.
- Guards run auth -> validate -> rate limit, so unauthenticated or malformed requests cannot exhaust the quota and deny service to real campaign traffic.

New environment variables: `TWILIO_VALIDATE_WEBHOOKS` (default `true`), `OUTBOUND_API_KEY`, `OUTBOUND_RATE_LIMIT_PER_MINUTE` (default `30`).

#### 🎯 Features

**Automatic caller-language detection and TTS switching** (`ConversationRelaySession.autoSwitchTtsLanguage()`)
- ConversationRelay *reports* the detected language on every prompt when `transcriptionLanguage` is `multi`, but never acts on it — `<Language>` is a lookup table and detection is a read. This closes the loop: the detected primary tag (`fr`) is mapped onto a declared `<Language>` code (`fr-FR`) and TTS is switched, so the reply is spoken with that language's configured voice.
- The `languages` array doubles as the allow-list. A detected language with no declared entry is **left alone** rather than switching TTS somewhere undefined.
- `transcriptionLanguage` deliberately stays on `multi` for the whole call. Pinning STT to the detected language would *end* detection, so a caller who later drifted back to English would be transcribed by the wrong model with nothing to signal it.
- An explicit `switch-language` call (i.e. the caller asked) latches automatic switching off for the rest of the call — otherwise a caller who says "please speak English" while still speaking French would be flipped straight back on the next prompt.
- Switching happens in code, not through the LLM: detection already produces a reliable answer, so a tool round-trip would spend tokens and add a chance of not firing, all to reproduce a four-line mapping.
- Full write-up, including the platform semantics and gotchas: [`server/docs/language-detection.md`](./server/docs/language-detection.md).

**Graceful live-agent handoff with hold music**
- `<Connect>` had no `action` URL, so when the `live-agent-handoff` tool fired, Twilio dropped the call immediately and the caller experienced an abrupt hangup. `action="{serverBaseUrl}/handoff"` plus a `/handoff` route now returns Twilio's demo hold music (3 loops) for `reasonCode: "live-agent-handoff"`. Other end reasons return empty TwiML, preserving the existing clean-hangup UX.

**Status callbacks wired on outbound calls**
- `calls.create()` now registers `statusCallback` / `Method` / `Event` for `initiated`, `ringing`, `answered` and `completed`. Previously nothing pointed at `/twilioStatusCallback`, so an outbound call that rang out, was busy or failed produced no signal at all beyond a WebSocket that never opened.

**Per-call context selection at WebSocket setup**
- `contextKey` was honoured only by `POST /updateResponseService`, i.e. after the call was already running, so the active context was effectively global — an outbound campaign prompt would also be served to inbound callers. An unknown key logs and falls back rather than failing the call.

#### 🐛 Bug Fixes

**Speech correctness** — surfaced by live outbound calls, latent since v4.12
- **Double speech.** `processStream()` recurses on each tool call and every follow-up stream may emit text, so a model that spoke a farewell *and* called `end-call` in one response had the follow-up produce a second farewell. Terminal tools no longer create a follow-up generation. The current stream is still read to completion, because `response.completed` must fire its `last: true` token or the session's deferred terminal frame never flushes and the call stays open. Non-terminal tools keep their follow-up — that is how a tool-then-speak turn produces its speech.
- **Interleaved speech.** `generateResponse()` had no concurrency guard, so two prompts arriving close together started two independent streams feeding the same handler and interleaved tokens mid-sentence. Fixed with cancel-previous semantics (each call claims a generation id; a stream whose generation is stale stops emitting), chosen over queueing because on a voice call a newer utterance should supersede the answer to the previous one rather than queue behind it.

**Listen mode, status callbacks and session cleanup** — six defects, all latent on the shipped `ListenMode.enabled: false`, which is why the 61-test suite stayed green
- **Listen mode could not be turned off; the agent went permanently mute.** `listenMode` existed twice — on the session (gating outgoing frames) and on `OpenAIResponseService` (gating token emission, constructor-set with no setter). The `set-listen-mode` tool only reached the session, so toggling off left the response service stuck `true` and every text delta was discarded upstream. The session is now the sole owner, consistent with it being the sole writer to the WebSocket. *Side effect:* the `/conversation` HTTP endpoint no longer honours listen mode — correct, as it has no WebSocket and wire-frame suppression is meaningless there.
- **Starting in listen mode armed a silent countdown to hangup.** The constructor set `listenMode` but never disarmed silence detection; only the runtime setter did. Reminders are `text` frames and were suppressed, but the terminal `end` frame is not gated, so the call was hung up with `reasonCode: 'unresponsive'` and no audible warning.
- **`/twilioStatusCallback` read `statusCallBack.callSid`;** Twilio posts `CallSid`, so the session lookup always missed and no status was ever injected into the conversation. `TwilioService.evaluateStatusCallback()` already read the correct casing, so the two halves disagreed.
- **`parameterDataMap` was never cleaned up.** Now deleted on ws close/error alongside `wsSessionsMap`, plus a TTL prune at insert to bound the map for outbound calls that are never answered and so never open a WebSocket.
- **`/outboundCall` logged `[object Object]`** instead of the call SID.
- **Log accuracy:** the session's constructed line reported the silence *config* value while the handler could already be disarmed — actively misleading when debugging listen mode. The `setup` frame is also no longer passed to `handleIncoming()` after being fully consumed, which was logging "Duplicate setup ignored" on every single call.

#### 🧪 Testing & Types

- **61 -> 121 tests.** Every behavioural fix above was verified against the pre-fix tree rather than merely asserted green.
- **Test files are now type-checked.** `tsconfig.json` scopes to `src/**` and vitest strips types without checking them, so test files never were — which is how a pre-v4.12 five-argument `OpenAIResponseService` constructor survived unnoticed in its own test file, silently landing the mock manifest in `registry` and `false` in `config` while every assertion said only `toBeDefined()`. Adds `tsconfig.test.json` and `npm run typecheck` covering both.
- Signature-validation tests build requests with the SDK's own `getExpectedTwilioSignature`, exercising the real crypto path, and deliberately report `http://localhost:3007` while signing for `https://<public-host>` so they also prove protocol/host pinning.
- Language-switching tests assert the table in `docs/language-detection.md` rather than trusting it, driven through `handleIncoming` so the `prompt` wiring is covered and not just the mapping.
- **`ServerConfig` tests are now hermetic.** With `NODE_ENV` deleted, `fromEnv()` defaults to development and loaded the developer's real `.env.dev`, so an assertion passed or failed depending on whose machine ran it. They now pin `NODE_ENV=test`.
- Tests use ACMA fictitious numbers rather than a real mobile.
- **SDK typing restored at the TwiML `<Language>` builder site.** The attribute list is keyed off `keyof VoiceResponse.LanguageAttributes`, so a renamed SDK field fails `tsc` here — which is precisely what `crelay.ts`'s deliberately narrow drift guard assumes.

#### ⚠️ Behaviour Change

**`serverConfig.json` now defaults to multi-language.** `transcriptionLanguage` and `ttsLanguage` are both `"multi"`; the redundant `language: "en-AU"` key is gone (it sits lowest in both precedence lists and was already overridden); `fr-FR` and `es-ES` are declared alongside `en-AU`.

- The provider pairings that `multi` requires — **Deepgram** for transcription, **ElevenLabs** for TTS — were already the shipped defaults, so **no new credentials are needed**.
- Existing deployments that pull this release move from `en-AU`-pinned transcription to multi-language transcription. To keep v4.12 behaviour, set `transcriptionLanguage` and `ttsLanguage` back to `en-AU` and trim the `languages` array to that one entry.
- The `fr-FR` and `es-ES` entries ship with the same ElevenLabs multilingual voice as `en-AU`. Set a per-language `voice` if you want distinct ones.
- Note the silent failure mode documented in `language-detection.md`: **duplicate JSON keys in `serverConfig.json` fail silently** — `JSON.parse` keeps the last occurrence with no warning, so a config declaring `transcriptionLanguage` twice is quietly whatever came last.

## Release v4.12.0

### ConversationRelay Session Model + In-Code Tool Registry

Ports CRelay patterns from the upcoming `@twilio/tac-conversationrelay` package (see [twilio-innovation/twilio-agent-connect-typescript PR #54](https://github.com/twilio-innovation/twilio-agent-connect-typescript/pull/54)) into this reference implementation. The WebSocket wire protocol is unchanged — this is an internal architecture refresh.

#### 🎯 Key Features

**Per-WebSocket session class (`ConversationRelaySession`):**
- Replaces `ConversationRelayService`. One session per WebSocket, owning every scrap of per-call state (callSid, listen mode, silence handler, pending terminal frame, in-flight tool promises).
- Sole writer to the WebSocket — `ws.send` is injected as a constructor callback so nothing else in the codebase can bypass listen-mode gating or frame validation.
- First-class outgoing methods: `sendText`, `sendDigits`, `sendPlay`, `switchLanguage`, `endCall`.

**In-code tool registry (`defineTool` + `ToolRegistry`):**
- Tool schema and handler now co-located in each `server/src/tools/*.ts` file via `defineTool({...})`.
- `ToolRegistry` built once at server startup via `buildDefaultRegistry(config, cachedAssetsService)`.
- `defaultToolManifest.json` and `legs/*/toolManifest.json` deleted — the manifest was a split source-of-truth that nothing enforced at compile time.
- Handler signature is now `(args, session) => Promise<Result>`. Per-call state lives on `session`; handlers are stateless, so the process-wide registry is safe across concurrent sessions.
- Incidental fix: `play-media` and `set-listen-mode` were present in `server/src/tools/` but absent from v4.11's manifest — they are now actually exposed to the LLM.

**Zod-validated wire frames:**
- New `server/src/types/crelay.ts` with discriminated-union schemas for every incoming and outgoing frame.
- Incoming frames use `.passthrough()` so unknown future Twilio fields don't hard-fail.
- Compile-time SDK drift guards pinned to `twilio/lib/twiml/VoiceResponse.LanguageAttributes` — a breaking Twilio SDK type change will fail `tsc`.

**Progressive-timeout SilenceHandler:**
- Switched from `setInterval` polling to a progressive `setTimeout` chain. Identical behaviour on the wire (same reminders, same terminal `end` frame with `reasonCode: 'unresponsive'`), but no per-second wakeups and accurate threshold timing.
- Legacy `startMonitoring(onMessage)` API preserved for back-compat.

**Terminal-frame deferral + `inFlightToolCalls`:**
- When a tool returns an `end` frame mid-turn, the session stashes it as `pendingTerminalFrame` and flushes only after the final text token.
- `sendText(last: true)` awaits `inFlightToolCalls` before the terminal flush — closes a race where the LLM's streamed farewell could outrun a tool-dispatched terminal.

#### 🔧 Technical Implementation

**Tool definition (`defineTool`):**
```typescript
export const endCallTool = defineTool<EndCallArgs, EndCallResult>({
    name: 'end-call',
    description: 'end this call now',
    parameters: {
        type: 'object',
        properties: { conversationSummary: { type: 'string', ... } },
        required: ['conversationSummary'],
    },
    handler: args => ({
        success: true,
        message: 'Call ended successfully',
        summary: args.conversationSummary,
        outgoingMessage: { type: 'end', handoffData: JSON.stringify({...}) },
    }),
});
```

**Registry composition (startup):**
```typescript
new ToolRegistry()
    .register(endCallTool)
    .register(liveAgentHandoffTool)
    .register(sendDtmfTool)
    .register(playMediaTool)
    .register(switchLanguageTool)
    .register(setListenModeTool)
    .register(setSilenceDetectionTool)
    .register(createSendSMSTool(serverConfig))
    .register(createChangeContextTool(cachedAssetsService));
```

**Tool-result side-effect conventions:**
- `silenceEnabled: boolean` → session toggles silence handler (replaces the old `outgoingMessage: { type: 'setSilenceDetection' }` pseudo-frame).
- `listenMode: boolean` → session toggles listen-mode gating.
- `outgoingMessage: OutgoingFrame` → validated via Zod, shipped to Twilio (or deferred for terminal `end` frames).

#### ⚠️ Breaking Changes (internal)

- `ConversationRelayService` class removed. Use `ConversationRelaySession`.
- `SetSilenceDetectionMessage` type removed. Tools now return `silenceEnabled: boolean` instead of `outgoingMessage: { type: 'setSilenceDetection', enabled }`.
- `defaultToolManifest.json` and `legs/*/toolManifest.json` removed. Tool schema lives in each tool file via `defineTool`. Per-leg tool subsets are no longer supported — every registered tool is exposed on every call (all-tools-all-legs).
- `OpenAIResponseService` constructor signature changed: takes a `ToolRegistry` instead of `(manifest, loadedTools)`.
- `ResponseHandler` gained an optional `toolCallStart?(promise)` method for in-flight tool tracking.
- WebSocket wire protocol is unchanged — external Twilio consumers are unaffected.

#### 📦 Dependency Updates (all to latest)

Major bumps: `twilio` 5→**6.0.2**, `express` 4→**5.2.1**, `openai` 5→**6.37**, `zod` 3→**4.4.3**, `typescript` 5→**6.0.3**, `@types/node` 22→**25**, `dotenv` 16→**17**. Only runtime change required was `zod` renaming `.error.errors` to `.error.issues` (three call sites).

#### ✅ Verification

- Build: `npm run build` — zero TS errors
- Tests: `npm test` — 61 passed, 3 skipped
- Runtime: inbound call smoke-tested end-to-end (greeting, streaming response, tool calls, interrupt)

---

## Release v4.11.0

### Tool Factory Pattern & Anti-Pattern Elimination (Phase 1 IoC Refactoring)

This release completes Phase 1 of the IoC refactoring plan by eliminating anti-patterns in the tool system and implementing the factory pattern for tools with dependencies. This phase focuses specifically on fixing the 2 problematic tools identified during architecture analysis while leaving the other 7 clean tools unchanged.

#### 🎯 Key Features

**Tool Factory Pattern:**
- **change-context Tool**: Converted to factory pattern with `createChangeContextTool(cachedAssetsService)`
  - Eliminated `_openaiService` and `_contextCacheService` anti-pattern from function arguments
  - Dependencies now captured in closure (CachedAssetsService) and passed as parameters (OpenAIResponseService)
  - Type-safe signature: `(args: ChangeContextArgs, responseService: OpenAIResponseService) => Promise<ChangeContextResponse>`

- **send-sms Tool**: Converted to factory pattern with `createSendSMSTool(config)`
  - Uses ServerConfig instead of direct `process.env` access
  - Maintains self-contained design (creates own Twilio client as intended for LLM tools)
  - Type-safe signature: `(args: SendSMSArgs, _responseService?: any) => Promise<SendSMSResponse>`

**Anti-Pattern Elimination:**
- Removed `_service` parameter anti-pattern from change-context tool
- Eliminated all direct `process.env` access from tools and services
- Removed backwards-compatibility fallbacks from TwilioService
- Eliminated special-case handling for change-context in OpenAIResponseService

**Service Improvements:**
- **TwilioService**: Config parameter now required (not optional), all `process.env` fallbacks removed
- **OpenAIResponseService**: Config parameter now required, consistent tool calling pattern for all tools
- **CachedAssetsService**: Calls tool factories during initialization, passes appropriate dependencies

#### 🔧 Technical Implementation

**Factory Pattern Example (change-context):**
```typescript
export function createChangeContextTool(
    cachedAssetsService: CachedAssetsService
) {
    return async (
        args: ChangeContextArgs,
        responseService: OpenAIResponseService
    ): Promise<ChangeContextResponse> => {
        // cachedAssetsService from closure
        const assets = cachedAssetsService.getAssetsForContextSwitch(args.newContext);

        // responseService from parameter
        await responseService.insertMessage('system', args.handoffSummary);
        await responseService.updateContext(assets.context);
        await responseService.updateTools(assets.manifest);

        return { success: true, ... };
    };
}
```

**Tool Loading with Factories:**
```typescript
// In CachedAssetsService.loadTools()
if (toolName === 'change-context') {
    loadedTools[toolName] = toolModule.createChangeContextTool(this);
} else if (toolName === 'send-sms') {
    loadedTools[toolName] = toolModule.createSendSMSTool(this.config);
} else {
    loadedTools[toolName] = toolModule.default;
}
```

**Tool Function Type:**
```typescript
// Updated signature in CachedAssetsService.d.ts
export type ToolFunction = (
    args: any,
    responseService?: any
) => Promise<ToolResult> | ToolResult;
```

#### ✅ Benefits

**Code Quality:**
- ✅ No hidden dependencies or runtime checking needed
- ✅ Clear dependency contracts via factory function parameters
- ✅ Compile-time dependency validation through TypeScript
- ✅ Tools remain self-contained (send-sms creates own Twilio client)
- ✅ Consistent pattern across all factory-created tools

**Testability:**
- ✅ 32 new comprehensive unit tests added
- ✅ 63 total tests passing (3 skipped)
- ✅ Factory pattern enables easy mocking of dependencies
- ✅ Test coverage for parameter validation, error handling, and execution flow

**Architecture:**
- ✅ Foundation for future IoC phases established
- ✅ Services already have good abstractions (no changes needed)
- ✅ Global Maps remain acceptable for WebSocket pattern
- ✅ Tool system now follows consistent dependency injection pattern

#### 🧪 Test Coverage Added

**change-context.test.ts (16 tests):**
- Factory pattern verification
- Parameter validation (newContext, handoffSummary)
- Context switching workflow
- Error handling (missing context, API failures)
- Dependency injection via closure and parameters

**send-sms.test.ts (11 tests):**
- Factory pattern with ServerConfig
- Verification of no `process.env` access
- SMS sending functionality
- Error handling (Twilio API errors, network failures)
- Self-containment verification (creates own client)

**CachedAssetsService.test.ts (5 tests):**
- Config storage for tool factories
- Integration points for tool loading
- Configuration handling with different environments

#### 📋 Files Modified

**Tools:**
- `src/tools/change-context.ts` - Converted to factory pattern, removed anti-pattern
- `src/tools/send-sms.ts` - Converted to factory pattern, uses ServerConfig

**Services:**
- `src/services/TwilioService.ts` - Removed process.env fallbacks, required config
- `src/services/OpenAIResponseService.ts` - Removed special cases, required config
- `src/services/CachedAssetsService.ts` - Calls tool factories

**Type Definitions:**
- `src/interfaces/CachedAssetsService.d.ts` - Updated ToolFunction type signature

**Tests:**
- `tests/unit/tools/change-context.test.ts` - New comprehensive test suite
- `tests/unit/tools/send-sms.test.ts` - New comprehensive test suite
- `tests/unit/services/CachedAssetsService.test.ts` - New test suite
- `tests/unit/services/TwilioService.test.ts` - Removed backwards compatibility tests
- `tests/unit/services/OpenAIResponseService.test.ts` - Removed backwards compatibility tests

#### 🚀 What's Next

**Phase 2 (Optional): Minimal Container Pattern**
- Introduce lightweight container for service creation
- Centralize dependency management
- Further improve testability

See `.claude/plans/ioc-refactoring-plan.md` for the complete phased approach.

---

## Release v4.10.0

### Centralized Configuration Management (Phase 0 IoC Refactoring)

This release introduces centralized configuration management as the foundation for future Inversion of Control (IoC) refactoring. This phase establishes configuration best practices while maintaining full backwards compatibility with existing code.

#### 🎯 Key Features

**ServerConfig Class:**
- Centralized configuration management with `ServerConfig` class
- `fromEnv()` static factory method for environment-based configuration
- `forTesting()` static factory method for test scenarios with safe defaults
- Environment-specific file loading (.env.dev, .env.prod) based on NODE_ENV
- Fail-fast validation of required environment variables at startup
- Type-safe configuration access throughout the codebase

**Service Integration:**
- Updated `TwilioService` to accept optional `ServerConfig` parameter
- Updated `OpenAIResponseService` to accept optional `ServerConfig` parameter
- Updated `CachedAssetsService` to accept optional `ServerConfig` parameter
- Backwards-compatible migration: services fallback to `process.env` if config not provided
- Gradual adoption pattern allows incremental migration

**Comprehensive Test Suite:**
- Vitest testing framework integration
- 41 passing tests covering ServerConfig, services, and integration
- Unit tests for configuration validation and loading
- Service integration tests with dependency injection
- Test fixtures for different environment configurations
- Fast execution (<400ms for full test suite)

#### 🔧 Technical Implementation

**Configuration Structure:**
```typescript
export class ServerConfig {
    // Server configuration
    public readonly port: number;
    public readonly serverBaseUrl: string;
    public readonly nodeEnv: string;

    // OpenAI configuration
    public readonly openaiApiKey: string;
    public readonly openaiModel: string;

    // Twilio configuration
    public readonly twilioAccountSid: string;
    public readonly twilioAuthToken: string;
    public readonly twilioFromNumber: string;
    public readonly twilioEdge?: string;
    public readonly twilioRegion?: string;

    // Asset loader configuration
    public readonly assetLoaderType: string;

    static fromEnv(): ServerConfig { /* ... */ }
    static forTesting(overrides?: Partial<ServerConfig>): ServerConfig { /* ... */ }
}
```

**Server Startup Flow:**
```typescript
// 1. Load and validate configuration first
serverConfig = ServerConfig.fromEnv();

// 2. Initialize services with configuration
cachedAssetsService = new CachedAssetsService(serverConfig);
twilioService = new TwilioService(serverConfig);

// 3. Pass config to response services
const responseService = new OpenAIResponseService(
    context, manifest, loadedTools, listenMode, serverConfig
);
```

**Testing Support:**
```typescript
// Easy test configuration with overrides
const testConfig = ServerConfig.forTesting({
    port: 4000,
    openaiModel: 'gpt-4-turbo'
});

const service = new TwilioService(testConfig);
```

#### ✅ Benefits

**Immediate Benefits:**
- **Fail-Fast Validation**: Missing configuration detected at startup, not at runtime
- **Type Safety**: `config.openaiModel` instead of `process.env.OPENAI_MODEL || "default"`
- **Single Source of Truth**: All configuration access centralized
- **Testability**: `ServerConfig.forTesting()` eliminates test environment setup
- **Clear Dependencies**: Constructor signatures show what configuration is needed

**Future-Ready Architecture:**
- Foundation for Phase 1 IoC: External client injection
- Foundation for Phase 2: Service factory patterns
- Foundation for Phase 3: Tool factory patterns
- Easy to add Zod validation later
- Supports alternative configuration sources

**Developer Experience:**
- Clear documentation of required configuration
- IDE autocomplete for configuration properties
- Compile-time type checking for configuration usage
- Simple test setup with sensible defaults

#### 📁 New Files

```
server/
├── src/
│   └── config/
│       └── ServerConfig.ts          # Centralized configuration class
└── tests/
    ├── setup.ts                     # Global test setup
    ├── vitest.config.ts             # Vitest configuration
    ├── README.md                    # Test suite documentation
    ├── TEST_SUMMARY.md              # Test results summary
    ├── fixtures/                    # Test environment fixtures
    │   ├── .env.test-complete
    │   ├── .env.test-minimal
    │   └── .env.test-incomplete
    ├── unit/
    │   ├── config/
    │   │   └── ServerConfig.test.ts       # 20 tests
    │   └── services/
    │       ├── TwilioService.test.ts      # 8 tests
    │       └── OpenAIResponseService.test.ts  # 8 tests
    └── integration/
        └── server-initialization.test.ts  # 8 tests
```

#### 📝 Modified Files

- `server/src/services/TwilioService.ts` - Added optional config parameter
- `server/src/services/OpenAIResponseService.ts` - Added optional config parameter
- `server/src/services/CachedAssetsService.ts` - Added optional config parameter
- `server/src/server.ts` - Create config at startup, pass to services
- `server/package.json` - Added test scripts and Vitest dependency

#### 🧪 Test Coverage

**Test Suite Results:**
```
 Test Files  4 passed (4)
      Tests  41 passed | 3 skipped (44)
   Duration  367ms
```

**Coverage by Area:**
- ServerConfig: 20 tests (17 passing, 3 skipped)
- TwilioService: 8 tests (all passing)
- OpenAIResponseService: 8 tests (all passing)
- Integration: 8 tests (7 passing, 1 skipped)

**Test Commands:**
- `npm test` - Run all tests
- `npm run test:watch` - Watch mode
- `npm run test:ui` - Interactive UI
- `npm run test:coverage` - Coverage report

#### 🚀 Migration Guide

**For Existing Code:**
No changes required! Services continue to work with existing `process.env` access. The optional `config` parameter enables gradual adoption.

**For New Code:**
```typescript
// Create config once at startup
const serverConfig = ServerConfig.fromEnv();

// Pass to services
const twilioService = new TwilioService(serverConfig);
const responseService = new OpenAIResponseService(
    context, manifest, tools, listenMode, serverConfig
);
```

**For Tests:**
```typescript
// Create test config with overrides
const testConfig = ServerConfig.forTesting({
    twilioAccountSid: 'test-specific-sid'
});

const service = new TwilioService(testConfig);
```

#### 📚 Documentation

- Comprehensive test suite documentation in `tests/README.md`
- Test results summary in `tests/TEST_SUMMARY.md`
- IoC refactoring plan updated with Phase 0 completion
- Updated README with v4.10.0 references

#### 🔄 What's Next

This release lays the foundation for the full IoC refactoring:
- **Phase 1**: Create IoC container and SessionManager
- **Phase 2**: Inject external clients (OpenAI, Twilio)
- **Phase 3**: Implement tool factory pattern
- **Phase 4**: Complete IoC container with full dependency injection

Each phase builds incrementally on this foundation while maintaining backwards compatibility.

---

## Release v4.9.8

### Environment-Specific Configuration Loading

This release implements environment-specific `.env` file loading with NODE_ENV-based selection, enabling clean separation between development and production configurations.

#### 🎯 Key Features

**NODE_ENV-Based Environment Loading:**
- Automatic environment file selection based on `NODE_ENV` environment variable
- `NODE_ENV=dev` → loads `.env.dev` for development configuration
- `NODE_ENV=prod` → loads `.env.prod` for production configuration
- No NODE_ENV set → falls back to `.env` for backward compatibility
- Cross-platform compatibility with modern Node.js

**Enhanced Configuration Validation:**
- Added `validateRequiredEnvVars()` function to validate presence of critical environment variables
- Validates: `PORT`, `SERVER_BASE_URL`, `OPENAI_API_KEY`, `ACCOUNT_SID`, `AUTH_TOKEN`, `FROM_NUMBER`
- Fails fast with clear error messages listing all missing variables
- Ensures application doesn't start with incomplete configuration

**Updated npm/pnpm Scripts:**
- `dev` script: `NODE_ENV=dev tsx watch src/server.ts` - Development with `.env.dev`
- `start:prod` script: `NODE_ENV=prod node dist/server.js` - Production with `.env.prod`
- `start` script: `node dist/server.js` - Fallback mode with `.env`
- `build` script: `tsc` - TypeScript compilation (unchanged)

#### 🔧 Technical Implementation

**server.ts Enhancements:**
- Added ES module `__dirname` equivalent using `fileURLToPath` and `path.dirname`
- Implemented `loadEnvironmentConfig()` function for NODE_ENV-aware env file loading
- Added path resolution for `.env.dev`, `.env.prod`, and `.env` files
- File existence checking with `existsSync()` before loading
- Error handling for missing files and invalid configurations
- Comprehensive logging of which environment file was loaded

**Environment File Structure:**
```
server/
├── .env          # Fallback/default environment configuration
├── .env.dev      # Development-specific configuration (2054 bytes)
├── .env.prod     # Production-specific configuration (2054 bytes)
└── .env.example  # Template for new developers
```

**Configuration Loading Logic:**
```typescript
// Determine which .env file to load based on NODE_ENV
if (nodeEnv === 'dev') {
    envPath = path.join(serverRoot, '.env.dev');
    envName = '.env.dev';
} else if (nodeEnv === 'prod') {
    envPath = path.join(serverRoot, '.env.prod');
    envName = '.env.prod';
} else {
    envPath = path.join(serverRoot, '.env');
    envName = '.env';
}
```

#### ✅ Use Cases

**Development Workflow:**
- Local development uses `.env.dev` with ngrok URLs and dev API keys
- Hot reload with `pnpm dev` automatically loads development configuration
- Easy testing of different environments by switching NODE_ENV
- No manual env file swapping required

**Production Deployment:**
- Production uses `.env.prod` with production URLs and credentials
- `pnpm start:prod` ensures correct environment is loaded
- Clear distinction between dev and prod configurations
- Reduced risk of using wrong credentials in wrong environment

**Multi-Environment Support:**
- `.env` serves as fallback for quick testing or CI/CD environments
- Each environment can have completely different configurations
- Easy A/B testing of configuration changes
- Support for staging, QA, and other custom environments

#### 📝 Files Modified

- `server/src/server.ts` - Added environment-aware loading logic, validation, and ES module support (lines 13-112)
- `server/package.json` - Updated scripts with NODE_ENV for dev and prod modes, version bump to 4.9.8
- `server/.env.dev` - Development environment configuration (already exists)
- `server/.env.prod` - Production environment configuration (already exists)
- `README.md` - Added Environment Configuration section with usage documentation
- `CHANGELOG.md` - This entry

#### 🛡️ Error Handling

**Missing Environment File:**
```
[Server] Environment file not found: /path/to/.env.dev
Error: Environment file not found: .env.dev
```

**Missing Required Variables:**
```
[Server] Missing required environment variables: OPENAI_API_KEY, AUTH_TOKEN
Error: Missing required environment variables: OPENAI_API_KEY, AUTH_TOKEN
```

**Successful Loading:**
```
[Server] Environment loaded from: .env.dev (NODE_ENV: dev)
[Server] All required environment variables validated
```

#### 🚀 Benefits

**Development Experience:**
- No more manual env file swapping between dev and prod
- Clear separation of development and production configurations
- Hot reload works seamlessly with environment-specific configs
- Easy to test different configurations locally

**Production Safety:**
- Explicit environment selection prevents accidental misconfigurations
- Validation ensures all required variables are present before startup
- Clear logging shows which environment file was loaded
- Fast failure prevents partial initialization with missing config

**Maintainability:**
- Single configuration pattern across all environments
- No hardcoded environment values in code
- Easy to add new environments (staging, QA, etc.)
- Standard Node.js environment variable patterns

**Cross-Platform Compatibility:**
- Works on Unix, Linux, macOS, and Windows PowerShell
- Modern Node.js (v12+) handles `NODE_ENV=value` syntax natively
- Optional `cross-env` support for older Windows environments
- Consistent behavior across all platforms

This enhancement provides a production-ready environment configuration system that follows industry best practices while maintaining backward compatibility through the `.env` fallback mechanism.

---

## Release v4.9.7

### Dynamic Silence Detection Control

This release adds runtime control of silence detection, enabling the LLM to dynamically enable or disable silence monitoring during active calls through a new tool.

#### 🎯 Key Features

**set-silence-detection Tool:**
- New tool allows LLM to toggle silence detection during active conversations
- Enables disabling silence monitoring during activities where callers may not speak (e.g., entering payment information, looking up documents)
- Simple boolean parameter: `enabled` (true to enable, false to disable)
- Returns success confirmation with current silence detection state

**Flag-Based Implementation:**
- Silence timer runs continuously (every 1 second) but checks enabled flag before taking action
- When disabled, timer performs early return without triggering silence messages
- No complex start/stop logic - simple flag check for reliability
- Enabled by default to maintain backward compatibility

**Tool-Driven Architecture:**
- Uses existing outgoingMessage pattern for clean service communication
- Tool returns `outgoingMessage` with type `setSilenceDetection`
- Routes through OpenAIResponseService to ConversationRelayService
- Avoids service coupling by not injecting ConversationRelayService into OpenAIResponseService

#### 🔧 Technical Implementation

**SilenceHandler Enhancement:**
- Added private `enabled: boolean` property (defaults to `true`)
- Modified timer to check `if (!this.enabled) return;` before processing
- Added `set(enabled: boolean)` method to update the flag
- Added `isEnabled()` getter for state inspection
- Timer continues running regardless of enabled state

**set-silence-detection Tool (NEW):**
- File: `src/tools/set-silence-detection.ts`
- Validates `enabled` parameter is boolean
- Returns `SetSilenceDetectionResponse` with `outgoingMessage` for routing
- Provides clear success/failure messaging
- Integrated into both `defaultToolManifest.json` and `PaymentToolManifest.json`

**ConversationRelayService Update:**
- Added `SetSilenceDetectionMessage` import from ConversationRelay interfaces
- Added new case in `toolResult` handler switch statement for type `setSilenceDetection`
- Calls `this.silenceHandler.set(silenceMsg.enabled)` to update flag
- Logs state changes for debugging

**Type Safety:**
- Added `SetSilenceDetectionMessage` interface to `ConversationRelay.d.ts`
- Updated `OutgoingMessage` union type to include `SetSilenceDetectionMessage`
- Proper TypeScript interfaces throughout the routing chain

#### ✅ Use Cases

**Payment Processing:**
- Disable silence detection while collecting card numbers via DTMF
- Prevents timeout messages during legitimate data entry periods
- Re-enable after payment information is captured

**Document Lookup:**
- Disable when caller is searching for documents or account information
- Allow extended silence without interruption
- Re-enable when ready to continue conversation

**IVR Navigation:**
- Disable during automated phone tree navigation
- Prevent false timeouts during menu listening
- Re-enable when reaching interactive conversation

**Multi-Step Forms:**
- Disable when caller is entering multiple pieces of information
- Maintain silence during form completion
- Re-enable when form submission is complete

#### 📝 Files Modified

- `server/src/services/SilenceHandler.ts` - Added enabled flag, set() method, early return logic
- `server/src/tools/set-silence-detection.ts` - NEW tool implementation
- `server/src/services/ConversationRelayService.ts` - Added setSilenceDetection case in toolResult handler
- `server/src/interfaces/ConversationRelay.d.ts` - Added SetSilenceDetectionMessage interface and updated OutgoingMessage union
- `server/assets/defaultToolManifest.json` - Added set-silence-detection tool definition
- `server/assets/PaymentToolManifest.json` - Added set-silence-detection tool definition
- `server/package.json` - Version bump to 4.9.7
- `README.md` - Added "Dynamic Silence Detection Control" documentation section
- `CHANGELOG.md` - This entry

This enhancement provides flexible silence detection control while maintaining the simple, reliable flag-based design pattern. The LLM can now intelligently disable silence monitoring during activities where extended silence is expected and appropriate.

---

## Release v4.9.6

### TwilioService Architecture - LLM Tool Self-Containment

This release establishes a clear architectural pattern for when to use TwilioService versus direct Twilio API calls, particularly for LLM tools.

#### 🏗️ Architectural Decision

**LLM Tool Self-Containment Pattern:**
- LLM tools in `src/tools/` directory should be self-contained and call Twilio APIs directly
- TwilioService is reserved for complex operations requiring non-API level business logic
- This pattern prevents unnecessary service layer coupling and keeps tools portable

#### 🔧 Technical Changes

**TwilioService.sendSMS() Removed:**
- Removed `sendSMS()` method from TwilioService (lines 123-137)
- Method was a simple wrapper with no added business logic
- Direct API calls are more appropriate for simple operations

**send-sms Tool Refactored:**
- Updated `src/tools/send-sms.ts` to call Twilio API directly
- Changed from: `new TwilioService().sendSMS(to, message)`
- Changed to: `twilio(accountSid, authToken).messages.create({...})`
- Tool remains fully functional with improved architectural alignment

**Documentation Updates:**
- Added usage guidelines to TwilioService class documentation (src/services/TwilioService.ts:16-30)
- Added "TwilioService Usage Guidelines" section to README Architecture chapter
- Clear guidance on when to use TwilioService vs. direct API calls

#### ✅ Usage Guidelines

**Use TwilioService when:**
- Making complex API calls that use multiple Twilio services
- Implementation requires non-API level business logic
- Building server endpoints or internal service operations
- **NOT** creating an LLM tool (tools should be self-contained)

**Use Direct Twilio API when:**
- Creating LLM tools in `src/tools/` directory
- Tool operations are simple API calls without business logic
- Ensures tools remain portable and self-contained
- Example: `send-sms.ts`, future payment tools, etc.

#### 📝 Files Modified

- `server/src/services/TwilioService.ts` - Removed sendSMS() method, updated class documentation
- `server/src/tools/send-sms.ts` - Refactored to use direct Twilio API calls
- `server/package.json` - Version bump to 4.9.6
- `README.md` - Added TwilioService Usage Guidelines section
- `CHANGELOG.md` - This entry

This architectural pattern improves code maintainability, reduces unnecessary coupling, and establishes clear guidelines for future tool development.

---

## Release v4.9.5

### Twilio Edge Location Support

This release adds optional support for Twilio Edge Locations, enabling geographic routing of API calls through specific data centers for improved latency and performance.

#### 🌍 Edge Location Configuration

**Environment Variables:**
- **Added**: `TWILIO_EDGE` - Optional edge location identifier (e.g., sydney, dublin, ashburn)
- **Added**: `TWILIO_REGION` - Optional region code (e.g., au1, ie1, us1)

**Configuration Requirements:**
- Both `TWILIO_EDGE` and `TWILIO_REGION` must be specified together
- If not configured, system defaults to Twilio's global low-latency routing
- Edge routing applies to all Twilio API calls (voice, SMS, Sync, etc.)

#### 🔧 Technical Implementation

**TwilioService Enhancement:**
- Modified constructor to conditionally initialize Twilio client with edge/region parameters
- Clean if/else pattern handles both configured and default scenarios
- Only applies edge configuration when both environment variables are set
- Transforms API endpoint from `api.twilio.com` to `api.{edge}.{region}.twilio.com`

**Available Edge Locations:**
- Sydney (Australia): `edge: 'sydney'`, `region: 'au1'` → `api.sydney.au1.twilio.com`
- Dublin (Ireland): `edge: 'dublin'`, `region: 'ie1'` → `api.dublin.ie1.twilio.com`
- Ashburn (US East): `edge: 'ashburn'`, `region: 'us1'` → `api.ashburn.us1.twilio.com`

#### ✅ Benefits

**Performance Improvements:**
- Reduced latency for API calls routed through geographically closer data centers
- Predictable IP address ranges for firewall configuration
- Optimized routing for region-specific deployments

**Deployment Flexibility:**
- Optional configuration maintains backward compatibility
- No code changes required - purely environment variable driven
- Easy switching between edge locations for different deployment environments

**Usage Examples:**
```bash
# Sydney Edge (Australia/Asia-Pacific)
TWILIO_EDGE=sydney
TWILIO_REGION=au1

# Dublin Edge (Europe)
TWILIO_EDGE=dublin
TWILIO_REGION=ie1

# Ashburn Edge (US East)
TWILIO_EDGE=ashburn
TWILIO_REGION=us1
```

#### 📝 Files Modified

- `server/src/services/TwilioService.ts` - Enhanced constructor with conditional edge configuration
- `server/.env.example` - Added TWILIO_EDGE and TWILIO_REGION with documentation
- `README.md` - Added "Twilio Edge Locations (Optional)" section with usage guide

This enhancement is particularly useful for deployments in specific geographic regions (e.g., hosting in Australia) or when predictable IP ranges are required for network security configurations.

---

## Release v4.9.4

### TwiML Generation Fix

This release fixes a critical TwiML parsing error that occurred when making calls through Twilio's Conversation Relay.

#### 🐛 Bug Fix

**Invalid TwiML Attributes:**
- **Fixed**: "Attribute 'parameters' is not allowed to appear in element 'ConversationRelay'" error
- **Fixed**: "Attribute 'languages' is not allowed to appear in element 'ConversationRelay'" error
- **Root Cause**: `languages` and `parameters` arrays from serverConfig.json were being spread as XML attributes on `<ConversationRelay>` element
- **Solution**: Extract and exclude `languages` and `parameters` from config before spreading attributes

**Technical Implementation:**
- Modified `TwilioService.connectConversationRelay()` to destructure and remove `languages` and `parameters` from filtered config
- These properties are now only added as child `<Language>` and `<Parameter>` elements (as intended)
- Prevents `[object Object]` serialization in XML attributes

#### ✅ Benefits

**Correct TwiML Generation:**
- `<ConversationRelay>` element now only contains valid TwiML attributes
- Languages configured via child `<Language>` elements only
- Parameters configured via child `<Parameter>` elements only
- No more TwiML parsing errors when initiating calls

**Files Modified:**
- `server/src/services/TwilioService.ts` - Fixed attribute spreading logic (lines 149-151)

This fix ensures calls can be successfully initiated without TwiML parsing errors from Twilio.

---

## Release v4.9.3

### Unified Response Service for Voice and Messaging

This release introduces a new `/conversation` endpoint that enables the same backend Response Service to be used for both voice (Conversation Relay) and messaging applications.

#### 🎯 Key Changes

**New /conversation Endpoint:**
- **HTTP POST Interface**: Simple JSON request/response endpoint for messaging applications
- **Session Management**: Stateful conversations using session GUIDs
- **Shared Response Service**: Uses same OpenAIResponseService as voice conversations
- **Multi-Turn Support**: Full conversation history maintained across requests

**Technical Implementation:**
- Session storage using `conversationSessionMap` for persistent conversations
- Automatic session creation with `crypto.randomUUID()` when no sessionId provided
- Reuses existing session for conversation continuity when sessionId included
- Accumulates streaming response chunks into complete response string
- Returns: `{ success: true, sessionId: string, response: string }`

#### ✅ Benefits

**Unified Architecture:**
- Same context, manifest, and tool configurations work for both voice and messaging
- Single Response Service implementation serves multiple communication channels
- Consistent AI behavior across voice calls and text conversations

**Flexible Integration:**
- Simple HTTP API for messaging/chat applications
- WebSocket interface for voice applications (Conversation Relay)
- Both interfaces share underlying OpenAI service and tool execution

**Usage Examples:**

**First Message (Creates Session):**
```bash
curl -X POST http://localhost:3000/conversation \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, I need help with my account"}'

# Response: { "success": true, "sessionId": "abc-123-def", "response": "Hello! I'd be happy to help..." }
```

**Follow-up Message (Uses Existing Session):**
```bash
curl -X POST http://localhost:3000/conversation \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "abc-123-def", "message": "What is my balance?"}'

# Response: { "success": true, "sessionId": "abc-123-def", "response": "Let me check that for you..." }
```

#### 🏗️ Architecture Benefits

**Code Reuse:**
- OpenAIResponseService used by both `/conversation-relay` (WebSocket) and `/conversation` (HTTP)
- CachedAssetsService provides same context/manifest to both endpoints
- Tool execution works identically across both communication channels

**Simplified Development:**
- Build messaging applications without WebSocket complexity
- Test conversation flows using simple HTTP requests
- Deploy same AI logic to multiple communication channels

**Session Independence:**
- Voice sessions (wsSessionsMap) and messaging sessions (conversationSessionMap) are independent
- Each communication channel maintains its own session storage
- No conflicts between voice calls and text conversations

This release enables developers to build unified conversational AI applications that work seamlessly across voice and messaging channels using a single backend service architecture.

---

## Release v4.9.2

### Generic Parameter Passing

This release removes hardcoded parameter handling in TwilioService, enabling flexible parameter passing to Conversation Relay sessions.

#### 🎯 Key Changes

**Generic Parameters:**
- `TwilioService.connectConversationRelay()` now accepts `parameters?: Record<string, string>` instead of hardcoded `callReference`
- `/outboundCall` endpoint extracts `phoneNumber` for routing, passes all other properties as parameters
- `/connectConversationRelay` endpoint accepts optional parameters from request body
- Foundation for dynamic context/manifest selection per Conversation Relay instance

**Technical Implementation:**
- Replaced hardcoded TwiML parameter with dynamic loop: `Object.entries(parameters).forEach()`
- Parameters available in WebSocket setup message via `message.customParameters`
- Enables arbitrary key-value pairs to be passed through to Conversation Relay

#### ✅ Benefits

**Flexibility:**
- Pass any custom data to Conversation Relay without code changes
- Support for dynamic context/manifest selection via `contextKey`/`manifestKey` parameters
- Future-proof parameter handling for new use cases

**Usage Example:**
```bash
curl -X POST 'https://server.com/outboundCall' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "properties": {
      "phoneNumber": "+1234567890",
      "callReference": "abc123",
      "contextKey": "supportContext",
      "customerId": "12345"
    }
  }'
```

All properties except `phoneNumber` are passed as Conversation Relay parameters.

---

## Release v4.9.1

### Automatic Port Selection Enhancement

This release improves the developer experience by implementing automatic port retry when the configured port is already in use.

#### 🎯 Port Conflict Resolution

**Automatic Port Retry:**
- Server now automatically attempts the next available port when the configured port is in use
- Eliminates "EADDRINUSE" errors when running multiple server instances
- Seamless port selection without manual configuration changes

**Technical Implementation:**
- Enhanced error handling for both HTTP and WebSocketServer instances
- Intelligent retry logic that increments port numbers until an available port is found
- Proper error handler attachment to prevent duplicate retry attempts

#### ✅ Benefits

**Developer Experience:**
- Run multiple development instances simultaneously without port conflicts
- No need to manually change PORT in .env when testing multiple servers
- Clear logging shows which port was selected when retry occurs

**Technical Improvements:**
- Fixed WebSocketServer error handler registration timing
- Prevented duplicate `server.listen()` calls during retry
- Clean separation between HTTP and WebSocket error handling

#### 🔧 Usage

**Default Behavior:**
```bash
# First instance
npm run dev
# Server started on port 3001

# Second instance (in new terminal)
npm run dev
# Port 3001 is in use, trying 3002
# Server started on port 3002
```

**Configuration:**
- Default port still controlled by `PORT` environment variable in `.env`
- Automatic retry only occurs when port is in use
- Other server errors are handled normally without retry

This enhancement makes local development smoother by eliminating common port conflict issues when running multiple server instances for testing or development purposes.

## Release v4.9.0

### Type System Improvements & Code Quality

This release focuses on internal code quality improvements with better TypeScript type definitions and cleaner service interfaces. No breaking changes or user-facing modifications.

#### 🎯 Type System Enhancements

**New Interface Definition File:**
- **Created**: `server/src/interfaces/CachedAssetsService.d.ts` with clean, reusable type definitions
- **Follows Pattern**: Matches existing interface files (AssetLoader.d.ts, ConversationRelay.d.ts, ResponseService.d.ts)

**Type Definitions Extracted:**
- **`ToolFunction`**: Type for tool execution functions - `(args: any) => Promise<ToolResult> | ToolResult`
- **`ActiveAssets`**: Return type for `getActiveAssets()` method (replaces massive inline type)
- **`CacheStats`**: Return type for `getCacheStats()` method (replaces inline type)
- **`CachedAssets`**: Internal cache structure documentation

**Code Quality Improvements:**
- Removed complex inline type definitions from CachedAssetsService.ts
- Cleaner method signatures with proper interface references
- Better IntelliSense and type inference for developers
- Centralized type definitions for maintainability

#### ✅ Benefits

**Developer Experience:**
- Improved IDE autocompletion and type hints
- Easier to understand service return types
- Better documentation through explicit interfaces
- Consistent type definition patterns across services

**Maintainability:**
- Type changes in one location propagate automatically
- Reduced code duplication
- Clear separation of interface definitions from implementation
- Full TypeScript build verification

#### 🔧 Technical Details

**Files Modified:**
- `server/src/interfaces/CachedAssetsService.d.ts` - New interface file created
- `server/src/services/CachedAssetsService.ts` - Updated to use interface types

**No Breaking Changes:**
- All existing functionality preserved
- API signatures unchanged
- No configuration changes required
- Full backward compatibility

## Release v4.8.0

### Configuration Structure Refinements & Asset Loading Simplification

Building on v4.7.0's configuration redesign, this release includes further structural improvements and significant asset loading simplifications.

#### 🔧 Configuration Structure Updates (Commit 855577a)

**Languages Array Reorganization:**
- **Moved**: `Languages` array from top-level `ConversationRelay.Languages` → nested `ConversationRelay.Configuration.languages`
- **Enhanced**: serverConfig.json with additional Twilio ConversationRelay properties:
  - `interruptSensitivity`, `partialPrompts`, `profanityFilter`
  - `transcriptionLanguage`, `transcriptionProvider`, `ttsLanguage`, `ttsProvider`, `voice`, `speechModel`
  - `parameters` array for dynamic parameter passing

**TypeScript Interface Improvements:**
- **Renamed**: `AssetLoader.ts` → `AssetLoader.d.ts` (proper TypeScript declaration file)
- **Enhanced**: ConversationRelay interfaces to use Twilio's official TypeScript definitions
- **Added**: Proper typing with `ConversationRelayConfig` extending Twilio's `ConversationRelayAttributes`

#### 🚨 Breaking Changes

**Asset Loading Interface Simplification:**
- **Removed**: `loadConversationRelayConfig()` and `loadLanguages()` methods from AssetLoader interface
- **Reason**: Eliminated redundancy - data now accessed directly from serverConfig
- **Migration**: Use `CachedAssetsService.getConversationRelayConfig()` and `CachedAssetsService.getLanguages()` instead

**SyncAssetLoader Architecture Overhaul:**
- **Simplified Structure**:
  - Single `serverConfig` Sync document (replaces Configuration map)
  - `Context` and `ToolManifest` maps for multiple entries only
  - Removed Languages map (now nested in Configuration)
- **Automatic Asset Loading**: Scans local assets directory on startup, loads all files to Sync
- **Eliminated Complexity**: Removed first-time vs restart detection logic

#### ✅ Improvements

**OpenAI Service Architecture (Commit 9a75a2c):**
- **Moved**: OpenAI service creation from individual services to server-level initialization
- **Benefits**: Centralized configuration, better dependency management, easier testing

**Enhanced Development Workflow:**
- **File Asset Loading**: Maintains smart filtering for context (.md + "context") and manifest ("manifest"/"tool") files
- **Sync Asset Loading**: Simple "all local files sync to Sync on startup" approach
- **Mixed Workflow Support**: Local files + direct Sync management both supported

**Consistent Data Access:**
- CachedAssetsService extracts ConversationRelay config and languages directly from serverConfig
- Eliminated duplicate loading paths and potential data inconsistencies
- Maintained backward compatibility for existing getter methods

#### 🔧 Technical Details

**Configuration Path Updates:**
- Languages now accessed via `serverConfig.ConversationRelay.Configuration.languages[]`
- Enhanced type safety with Twilio's official TypeScript interfaces
- Proper parameter and language array structures for TwiML generation

**Asset Loader Consistency:**
- Both FileAssetLoader and SyncAssetLoader provide identical simplified interfaces
- SyncAssetLoader preserves existing Sync content while updating from local files
- Predictable asset loading behavior across different storage backends

#### Migration Notes

**For Existing SyncAssetLoader Users:**
- Languages map will be automatically migrated to nested Configuration structure
- Existing Sync content preserved while local assets are reloaded
- No manual intervention required for standard configurations

**For Custom AssetLoader Implementations:**
- Remove `loadConversationRelayConfig()` and `loadLanguages()` method implementations
- Access this data through CachedAssetsService instead

## Release v4.7.0

### Major Breaking Changes: Complete Configuration System Redesign

This release fundamentally restructures the configuration system, requiring migration of existing configuration files and updates to any custom integrations.

#### 🚨 Breaking Changes

**File & Interface Renames:**
- **Configuration File**: `defaultConfig.json` → `serverConfig.json`
- **TypeScript Interface**: `UsedConfig` → `ServerConfig`
- **Method Names**:
  - `loadUsedConfig()` → `loadServerConfig()`
  - `getUsedConfig()` → `getServerConfig()`
  - `getConversationRelayConfig(key)` → `getConversationRelayConfig()` (no key required)

**Complete Configuration Structure Overhaul:**

*Old Structure:*
```json
{
  "ConversationRelay": { /* mixed settings */ },
  "Languages": [ /* top-level */ ],
  "UsedConfig": {
    "configuration": "defaultConfig",
    "context": "defaultContext",
    "manifest": "defaultToolManifest",
    "assetLoaderType": "file",
    "silenceDetection": { /* ConversationRelay setting */ },
    "listenMode": { /* OpenAI setting */ }
  }
}
```

*New Structure:*
```json
{
  "ConversationRelay": {
    "Configuration": { /* TwilioService settings */ },
    "Languages": [ /* moved from top-level */ ],
    "SilenceDetection": { /* moved from UsedConfig */ }
  },
  "AssetLoader": {
    "context": "defaultContext",
    "manifest": "defaultToolManifest",
    "assetLoaderType": "file"
  },
  "Server": {
    "ListenMode": { /* moved from UsedConfig */ }
  }
}
```

#### ✨ Added

- **Clear Separation of Concerns**: Configuration now organized by actual service ownership
- **Intuitive Naming**: File names, interfaces, and methods use descriptive names
- **Simplified API**: Removed hardcoded configuration keys and map-based storage
- **LLM Flexibility**: AssetLoader section is now LLM-agnostic (works with OpenAI, Flowise, etc.)

#### 🗑️ Removed

- **Configuration Keys**: No more hardcoded 'defaultConfig' keys
- **Misleading Fields**: Removed unused `Server.configuration` reference field
- **Map-Based Config Storage**: ConversationRelay config stored as direct object
- **Mixed Concerns**: Settings now logically grouped by service responsibility

#### 📝 Migration Required

1. **Rename your config file**: `defaultConfig.json` → `serverConfig.json`
2. **Restructure your configuration** using the new format above
3. **Update any custom code** referencing old interface/method names
4. **Update documentation** referencing old configuration paths

## Release v4.6.0

### Major Architecture Redesign: Asset Loading System

This release introduces a complete redesign of the asset loading architecture, enabling flexible configuration management through multiple data sources and eliminating dependencies that prevented standalone tool usage.

#### Breaking Changes
- **Decoupled TwilioService**: Removed CachedAssetsService dependency from TwilioService constructor
- **Parameter-Based Dependency Injection**: TwilioService methods now accept CachedAssetsService as parameters instead of constructor injection
- **New Asset Management Interface**: All asset loading now goes through the AssetLoader interface abstraction

#### Added
- **AssetLoader Interface**: New abstraction layer for loading contexts, manifests, and configuration from different sources
- **CachedAssetsService**: Centralized, high-performance in-memory cache for all assets with automatic loader selection
- **FileAssetLoader**: Load assets directly from local files without requiring Twilio Sync
- **SyncAssetLoader**: Enhanced Sync integration with automatic service/map/document creation
- **Configuration Selection**: Choose between 'file', 'sync', or 'j2' loading via `assetLoaderType` in defaultConfig.json

#### Enhanced
- **Automatic Sync Infrastructure Creation**: SyncAssetLoader automatically creates missing Sync services, maps, and documents from defaultConfig.json
- **Improved Service Independence**: Services can now be instantiated independently (enables tools like send-sms to work standalone)
- **Performance Optimization**: In-memory caching eliminates runtime API calls for asset access
- **Session Independence**: Each ConversationRelay session gets independent asset copies

#### Technical Implementation
- **SyncAssetLoader Enhancement**: Added comprehensive Sync initialization with helper methods from TwilioSyncService
- **Asset Loading Strategy**: Dynamic selection between file-based and Sync-based loading
- **Configuration Management**: Unified approach to contexts, manifests, and configuration across all loaders
- **Service Architecture**: Clean separation between configuration loading and service creation

#### Migration Guide
- **File-based setup**: Set `"assetLoaderType": "file"` in defaultConfig.json - no Sync service required
- **Sync-based setup**: Set `"assetLoaderType": "sync"` in defaultConfig.json - automatic Sync infrastructure creation
- **TwilioService usage**: Methods now require CachedAssetsService parameter (e.g., `connectConversationRelay(serverBaseUrl, cachedAssetsService)`)

#### Benefits
- **Flexible Asset Management**: Choose between file-based or Sync-based configuration storage
- **Standalone Tool Support**: Tools like send-sms can create TwilioService without dependencies
- **Automatic Sync Setup**: No manual Sync infrastructure setup required
- **Development Friendly**: File-based loading perfect for development and testing
- **Production Ready**: Sync-based loading ideal for production deployments with centralized configuration

This release provides maximum flexibility for different deployment scenarios while maintaining full backward compatibility and improving the overall architecture for better maintainability and performance.

## Release v4.5.1

### Silence Mode Call Handling Improvements

#### Enhanced Listen Mode Call Termination
- **Improved Terminal Messaging**: Enhanced call ending behavior in listen mode to ensure proper silence detection handling
- **Better Call Flow**: Optimized the interaction between listen mode and silence detection for smoother call termination
- **Silence Handler Integration**: Improved coordination between OpenAIResponseService listen mode and SilenceHandler for consistent behavior

#### Technical Implementation
- **OpenAIResponseService Enhancement**: Updated silence mode handling in `processStream()` method for better call ending coordination
- **State Management**: Improved listen mode state coordination with silence detection mechanisms
- **Call Termination Logic**: Enhanced terminal message processing to work seamlessly with silence detection

#### Benefits
- **Consistent Call Endings**: Reliable call termination behavior regardless of listen mode state
- **Better User Experience**: Smoother interaction between automated operations and silence detection
- **Improved Reliability**: More predictable behavior when transitioning between listen mode and normal operations

This release refines the listen mode implementation to provide better coordination with silence detection and more reliable call termination behavior.

## Release v4.5.0

### Listen Mode Implementation

#### Automated Operation Configuration System
- **Listen Mode Configuration**: Added configurable listen mode system for automated operations without text responses
  ```json
  "listenMode": {
    "enabled": true
  }
  ```
- **Silent Operation**: When enabled, OpenAI response text processing is suppressed while maintaining full tool execution capability
- **Configuration-Driven Behavior**: Listen mode state controlled through `defaultConfig.json` UsedConfig section
- **Dynamic Control**: Runtime switching capability through `set-listen-mode` tool for operational flexibility

#### OpenAI Response Service Enhancement
- **Early Break Pattern**: Implemented efficient early break logic in `processStream()` method for text suppression
- **Listen Mode Property**: Added `this.listenMode` boolean property for direct state access
- **Response Processing Control**: Text delta events bypassed when listen mode active: `if (this.listenMode) break;`
- **Tool Execution Preservation**: All tool calling and function execution remains fully operational in listen mode

#### CachedAssetsService Integration
- **Configuration Loading**: Extended CachedAssetsService to include listenMode in UsedAssets interface
- **Type Safety**: Added proper TypeScript interface support for listenMode configuration object
- **Service Integration**: Listen mode configuration passed to OpenAIResponseService during initialization
- **Asset Management**: Listen mode settings cached for high-performance access across service instances

#### Dynamic Listen Mode Control Tool
- **set-listen-mode Tool**: New tool for runtime control of listen mode state during active conversations
  - Parameters: `enabled` (boolean) - True for listen-only operation, false for normal responses
  - Response validation and error handling for boolean parameter enforcement
  - Standard tool calling pattern without service injection dependencies
- **Tool Manifest Integration**: Added set-listen-mode to ivrWalkToolManifest for automated IVR operations
- **Runtime Flexibility**: Enables switching between automated and interactive modes during conversations

#### Technical Architecture
- **Service Layer Integration**: Listen mode configuration flows from CachedAssetsService through service constructors
- **Performance Optimization**: Early break pattern prevents unnecessary text processing overhead
- **State Management**: Boolean flag approach for simple and reliable state control
- **Tool Integration**: Standard tool calling patterns maintained for consistency with existing architecture

### Benefits of Listen Mode System

#### Automated Operations
- **Silent Navigation**: Enable automated phone tree navigation without speaking responses
- **Background Processing**: Run automated tasks while preserving all tool execution capabilities
- **Data Collection**: Document system interactions without user-facing responses
- **Testing Scenarios**: Automated testing of conversation flows and tool execution

#### Developer Experience
- **Configuration Control**: Simple boolean configuration for enabling/disabling text responses
- **Runtime Flexibility**: Dynamic switching between automated and interactive modes
- **Tool Consistency**: Standard tool calling patterns without special service injection
- **Type Safety**: Full TypeScript support with proper interface definitions

#### Performance Benefits
- **Reduced Processing**: Early break pattern eliminates unnecessary text response generation
- **Lower Bandwidth**: No text transmission when operating in silent mode
- **Optimized Resources**: Skip text-to-speech processing during automated operations
- **Faster Execution**: Direct state checking without complex method calls

This release provides a comprehensive listen mode system that enables automated operations while maintaining full tool execution capabilities, perfect for IVR navigation, automated testing, and background data collection scenarios.

## Release v4.4.4

### Configuration Loading Fixes

#### Reliable Configuration Updates
- **Always Reload defaultConfig.json**: Fixed issue where UsedConfig changes in `defaultConfig.json` were only applied on first-time setup, not on server restarts
- **Consistent Configuration State**: Server now always applies local configuration file changes on every startup
- **Predictable Behavior**: Configuration changes are immediately effective after server restart

#### Selective Asset Loading
- **Controlled Context Loading**: Disabled automatic loading of all `*Context.md` files from assets directory
- **Only Default Assets**: Now only `defaultContext.md` loads automatically during server startup
- **Manual Upload Required**: Other context files (like `ivrWalkContext.md`) must be uploaded manually using the Asset Upload Utility
- **Cleaner Startup**: Prevents unintended contexts from being automatically loaded into Sync

#### Technical Implementation
- **Removed Auto-Discovery**: Commented out `loadAllContextFiles()` call in startup sequence
- **Conditional Logic Fix**: Removed `loadDefaults` condition for UsedConfig loading
- **Startup Optimization**: Faster startup with only essential default assets loaded

#### Benefits
- **Configuration Reliability**: Changes to `defaultConfig.json` are guaranteed to be applied
- **Explicit Asset Management**: Developers have full control over which contexts are loaded
- **Development Workflow**: Easier testing and configuration management during development
- **Production Stability**: Prevents accidental loading of development/test contexts

## Release v4.4.3

### Enhanced Silence Detection Configuration System

#### Centralized Configuration Architecture
- **Complete Configuration Object**: Replaced simple boolean `silenceDetection: false` with comprehensive configuration object:
  ```json
  "silenceDetection": {
    "enabled": false,
    "secondsThreshold": 20,
    "messages": [
      "Still there?",
      "Just checking you are still there?",
      "Hello? Are you still on the line?"
    ]
  }
  ```
- **Eliminated Hardcoded Values**: Removed hardcoded fallbacks (`SILENCE_SECONDS_THRESHOLD`, `SILENCE_RETRY_THRESHOLD`) from SilenceHandler in favor of centralized JSON configuration
- **Enhanced CachedAssetsService**: Extended to support new silence detection configuration structure with proper TypeScript interfaces

#### Flexible Message Array System
- **Array-Based Message Progression**: Replaced hardcoded retry threshold logic with elegant message array iteration
- **Dynamic Message Count**: Support for any number of escalation messages without code changes
- **Configurable Thresholds**: Easy modification of silence detection timing through JSON configuration
- **Message Index Management**: Proper reset of message progression when conversation resumes

#### Architecture Improvements
- **SilenceDetectionConfig Interface**: New TypeScript interface defining configuration structure with `enabled`, `secondsThreshold`, and `messages` properties
- **Constructor-Based Configuration**: SilenceHandler now accepts configuration object instead of reading environment variables
- **Conditional Service Creation**: ConversationRelayService only creates SilenceHandler when `config.enabled === true`
- **Type-Safe Configuration**: Complete TypeScript support with proper interfaces and type checking

#### Service Integration Enhancements
- **Enhanced getUsedAssets()**: CachedAssetsService now returns silence detection configuration alongside context and manifest
- **Factory Method Updates**: ConversationRelayService.create() passes full configuration object to SilenceHandler constructor
- **Clean Separation**: Clear distinction between configuration loading (CachedAssetsService) and service creation (ConversationRelayService)
- **Default Configuration**: Fallback configuration provided when not specified in JSON

### Benefits of Enhanced Silence Detection

#### Configuration Flexibility
- **No Code Changes Required**: Modify silence thresholds and messages through JSON configuration
- **A/B Testing Support**: Easy testing of different message strategies and timing
- **Dynamic Message Count**: Add or remove escalation messages without recompiling
- **Environment-Specific Settings**: Different configurations for development, staging, and production

#### Improved User Experience
- **Customizable Messaging**: Tailored silence reminder messages for different use cases
- **Configurable Timing**: Adjustable silence thresholds for different conversation types
- **Proper Message Progression**: Logical escalation through configured message sequence
- **Clean Call Termination**: Graceful ending when all reminder messages are exhausted

#### Developer Experience
- **Type Safety**: Complete TypeScript support with IntelliSense and compile-time validation
- **Centralized Configuration**: All silence detection settings in one location
- **Consistent Architecture**: Follows established configuration patterns from existing system
- **Easy Testing**: Simple configuration changes for testing different scenarios

#### Maintainability
- **Eliminated Hardcoded Values**: No more scattered constants or missing environment variables
- **Single Source of Truth**: All silence detection configuration in JSON
- **Clean Service Boundaries**: Clear responsibility separation between services
- **Future Extensibility**: Architecture supports additional silence detection features

This release provides a comprehensive silence detection configuration system that eliminates hardcoded values while providing maximum flexibility for customizing silence handling behavior through simple JSON configuration changes.

### Asset Upload Utility

#### New Developer Tool
- **Manual Asset Upload Script**: Added `scripts/upload-assets.js` utility for manually uploading asset files to Twilio Sync
- **Flexible Path Support**: Accepts any file path (relative, absolute, or current directory) using `path.resolve()` for maximum flexibility
- **File Type Support**: Handles both `.md` files (uploaded to Context map) and `.json` files (uploaded to ToolManifest map)
- **Update or Create Logic**: Automatically updates existing Sync map items or creates new ones using existing `TwilioSyncService` patterns

#### Usage Examples
```bash
# Upload files using relative paths
node scripts/upload-assets.js ./assets/customContext.md
node scripts/upload-assets.js ./assets/customTools.json

# Upload files from current directory
node scripts/upload-assets.js myContext.md

# Upload files using absolute paths
node scripts/upload-assets.js /path/to/file.json
```

#### Technical Implementation
- **Reuses Existing Infrastructure**: Leverages `TwilioSyncService` and existing Sync Maps architecture
- **Environment Variable Consistency**: Uses same credentials (`ACCOUNT_SID`, `AUTH_TOKEN`) as existing services
- **Comprehensive Error Handling**: Validates file existence, JSON syntax, and Twilio credentials
- **Asset Naming Convention**: Derives Sync map keys from filename (without extension)
- **Detailed Logging**: Provides clear feedback on upload success/failure with content statistics

#### Benefits
- **Development Workflow**: Quick asset synchronization during development
- **Configuration Management**: Easy upload of custom contexts and tool manifests
- **No API Dependencies**: Direct file-to-Sync upload without server endpoints
- **Consistent with Server Patterns**: Follows same Twilio client initialization and error handling as main application

## Release v4.4.2

### Performance Optimization Architecture

#### High-Performance Caching Implementation
- **CachedAssetsService**: Implemented in-memory caching system to eliminate runtime Sync API calls
  - Uses Map-based storage for instant context and manifest retrieval
  - Provides deep copies to ensure session independence
  - Implements `getUsedAssets()`, `getContext()`, `getManifest()`, and `getAssetsForContextSwitch()` methods
- **Startup-Only Sync Operations**: Modified TwilioSyncService to only push defaults and load cache at startup
  - Eliminates per-session Sync API overhead
  - Maintains cloud storage benefits while providing local performance
- **Service Architecture Optimization**: Reduced service creation overhead with direct cache access
  - OpenAIResponseService now receives CachedAssetsService directly
  - ConversationRelayService simplified to pass CachedAssetsService reference only

#### Self-Contained Context Switching
- **Enhanced change-context Tool**: Tool now performs context switching directly without service boundary crossing
  - Receives OpenAI and CachedAssetsService references via dependency injection
  - Performs context switching internally: `openaiService.updateContext()` and `openaiService.updateTools()`
  - Inserts handoff summary into conversation before switching contexts
- **Service Reference Injection**: Added pattern for tools requiring direct service access
  - Special handling in OpenAIResponseService for change-context tool
  - Injects `_openaiService` and `_contextCacheService` parameters for self-contained operation

#### Code Cleanup and Interface Simplification
- **Removed ContextLoader Interface**: Eliminated unused interface as part of architecture simplification
- **Updated Service Dependencies**: Simplified service creation patterns with direct cache access
- **Enhanced WebSocket Logic**: Streamlined server initialization with CachedAssetsService integration

### Performance Benefits

#### Runtime Performance
- **Eliminated Sync API Calls**: In-memory cache provides instant access to contexts and manifests
- **Reduced Service Creation Overhead**: Direct parameter passing without complex loading mechanisms
- **Faster Context Switching**: Self-contained tool execution without service boundary crossing
- **Lower Memory Usage**: Optimized architecture reduces memory footprint

#### Startup Performance
- **One-Time Sync Operations**: All Sync interactions happen only at startup
- **Batch Configuration Loading**: All contexts and manifests loaded into cache simultaneously
- **Persistent Cache**: In-memory cache persists for entire server lifetime

#### Developer Experience
- **Simplified Architecture**: Cleaner service boundaries with direct cache access
- **Self-Contained Tools**: Context switching tools handle their own execution flow
- **Better Error Handling**: Simplified error paths with direct service access
- **Maintainable Code**: Reduced complexity with fewer abstraction layers

This release provides significant performance improvements while maintaining full backward compatibility and preserving all existing functionality.

## Release v4.4.1

### Language Configuration Optimization

#### Enhanced Language Configuration Structure
- **Removed Redundant ConversationRelay Language Fields**: Eliminated duplicate language settings from ConversationRelay object as Languages array overrides these values
- **Streamlined Configuration**: Removed `language`, `ttsLanguage`, `transcriptionProvider`, `transcriptionLanguage`, `speechModel`, `ttsProvider`, `voice` from ConversationRelay level
- **Complete Language Element Support**: Updated Languages array to use only supported Twilio Language element parameters
- **Proper Parameter Structure**: Languages now include only `code`, `ttsProvider`, `voice`, `transcriptionProvider`, `speechModel` as per Twilio documentation

#### Configuration Cleanup Benefits
- **Follows Twilio Best Practices**: Language elements properly override ConversationRelay defaults without redundancy
- **Cleaner Configuration Structure**: No duplicate or conflicting language settings between levels
- **Better Maintainability**: Single source of truth for language-specific settings in Languages array
- **Documentation Compliance**: Configuration structure now matches official Twilio ConversationRelay documentation

#### Language Switching Enhancement
- **Dynamic Language Support**: Proper language switching with `switch-language` tool now works seamlessly
- **Multi-Language Configuration**: Support for multiple language variants (en-AU, en-US) with distinct TTS voices
- **Real-Time Language Changes**: Users can request language changes during calls with immediate effect

This release optimizes the language configuration structure to eliminate redundancy and ensure full compliance with Twilio's ConversationRelay Language element specifications, providing cleaner configuration management and better language switching capabilities.

## Release v4.4.0

### Direct Parameter Configuration Migration

#### Complete Migration from File-Based to Direct Parameter Configuration
- **Architectural Simplification**: Migrated from file-based configuration (`server/assets/`) to direct parameter passing for context and tool manifests
- **Streamlined Service Creation**: Services now receive context and manifest content directly as parameters instead of loading from files
- **Improved Performance**: Eliminated file I/O overhead by passing configuration data directly to services
- **Enhanced Flexibility**: Context and manifest data can now come from any source (files, databases, APIs, etc.)

#### Service Architecture Improvements
- **Direct Parameter Passing**: All services now accept context and manifest content as direct parameters
  - `OpenAIResponseService.create(context: string, manifest: object)` - Context and manifest passed directly
  - `ConversationRelayService.create(sessionData, context, manifest)` - Factory method with direct parameters
  - `FlowiseResponseService.create(context: string, manifest: object)` - Updated to match interface
- **Content-Based Interface**: ResponseService interface updated to work with content instead of file paths
  - `updateContext(context: string): Promise<void>` - Updates context from string content
  - `updateTools(manifest: object): Promise<void>` - Updates tools from manifest object
- **Eliminated File Dependencies**: Services no longer depend on file system operations for configuration
- **Type Safety Enhancement**: Context as `string`, toolManifest as `object` across all services

#### Code Cleanup and Optimization
- **Removed Unused Infrastructure**: Eliminated unused AssetsLoader infrastructure
  - Removed `AssetsLoader.ts` - Factory pattern loader no longer needed
  - Removed `SyncAssetsLoader.ts` - Sync implementation no longer needed
  - Removed `AssetsLoader.d.ts` - Interface no longer needed
  - Removed entire `/server/src/loaders/` directory - No longer needed
- **Simplified Service Creation**: Direct parameter passing eliminates complex loading mechanisms
- **Cleaner Dependencies**: Services have cleaner, more predictable dependencies

#### Service Integration Updates
- **WebSocket Handler**: Services created with context and manifest passed directly from calling code
- **Factory Pattern Enhancement**: Service creation methods now accept content parameters directly
- **Error Handling**: Simplified error handling without file system dependencies
- **Memory Efficiency**: Reduced memory overhead by eliminating unused loader infrastructure

### Migration Benefits

#### Performance Improvements
- **Faster Service Creation**: No file I/O operations during service initialization
- **Reduced Memory Footprint**: Eliminated unused loader classes and infrastructure
- **Lower Latency**: Direct parameter passing without intermediate loading steps
- **Simplified Call Stack**: Cleaner execution path without loader abstraction layers

#### Developer Experience
- **Simpler API**: Direct parameter passing is more intuitive than file-based configuration
- **Better Testability**: Easy to test with mock context and manifest data
- **Flexible Data Sources**: Context and manifest can come from any source, not just files
- **Cleaner Architecture**: Eliminated unnecessary abstraction layers and complexity

#### Maintainability
- **Reduced Codebase**: Removed unused loader infrastructure reduces maintenance burden
- **Clearer Dependencies**: Services have explicit, direct dependencies on their configuration data
- **Better Separation of Concerns**: Configuration sourcing is separated from service logic
- **Future-Proof**: Architecture supports any configuration source without service changes

#### Type Safety & Reliability
- **Compile-Time Validation**: TypeScript enforces correct parameter types for all services
- **Predictable Behavior**: Direct parameter passing eliminates file system error scenarios
- **Consistent Interface**: All services follow the same parameter-based creation pattern
- **Enhanced Debugging**: Simpler execution path makes debugging more straightforward

This release represents a fundamental simplification of the service architecture, moving from complex file-based configuration loading to straightforward direct parameter passing, providing better performance, maintainability, and flexibility while maintaining full functional compatibility.

## Release v4.3.1

### Complete CCRelay Method Support

#### Added Remaining Twilio WebSocket Message Types
- **switch-language Tool**: Implemented support for dynamic language switching during calls
  - Takes optional `ttsLanguage` and `transcriptionLanguage` parameters
  - Validates that at least one language parameter is provided  
  - Returns `SwitchLanguageMessage` type for WebSocket routing
  - Supports Twilio's language switching capabilities for both text-to-speech and speech-to-text
- **play-media Tool**: Added support for playing audio media from URLs
  - Takes required `source` URL parameter for media playback
  - Supports optional `loop`, `preemptible`, `interruptible` parameters
  - Returns `PlayMediaMessage` type for WebSocket routing
  - Enables playing audio files during conversation sessions

#### Tool Implementation Enhancements
- **Consistent Tool Patterns**: Both new tools follow established patterns from existing tools
- **Type Safety**: Proper TypeScript interfaces and validation for all parameters
- **Error Handling**: Comprehensive validation with descriptive error messages
- **Logging Integration**: Full logging support using existing logger utilities
- **OutgoingMessage Integration**: Both tools return proper OutgoingMessage types for WebSocket routing

#### Complete Twilio Coverage
- **Full API Support**: System now supports all major Twilio Conversation Relay WebSocket message types:
  - `text` - Text-to-speech synthesis (existing)
  - `sendDigits` - DTMF tone transmission (existing)  
  - `end` - Session termination (existing)
  - `language` - Language switching (new)
  - `play` - Media playback (new)
- **Documentation Updates**: Updated README.md to reflect new tools in project structure and tool listings
- **Consistent Architecture**: All tools follow the same patterns for maintainability and developer experience

### Benefits of Complete CCRelay Support

#### Enhanced Conversation Capabilities
- **Multi-Language Support**: Dynamic language switching enables serving customers in different languages during the same call
- **Rich Media Integration**: Audio playback capabilities for playing hold music, announcements, or instructional content
- **Complete Twilio Integration**: Full utilization of Twilio's Conversation Relay WebSocket API capabilities

#### Developer Experience
- **Comprehensive Toolset**: All official Twilio Conversation Relay features available as easy-to-use tools
- **Consistent Patterns**: Predictable tool structure makes it easy to understand and extend functionality
- **Type-Safe Implementation**: Full TypeScript support with proper interfaces and validation

#### Architectural Benefits
- **Future-Proof**: Complete API coverage ensures compatibility with Twilio's full feature set
- **Maintainable**: Consistent tool patterns make the codebase easier to maintain and extend
- **Well-Documented**: Updated documentation reflects complete tool coverage and usage patterns

This release completes the Twilio Conversation Relay API integration, providing developers with access to all official WebSocket message types through a consistent, type-safe tool interface.

## Release v4.3.0

### Tool Type-Driven Architecture Migration

#### Complete Event-Driven to Tool Type-Driven Transformation
- **Architectural Paradigm Shift**: Migrated from event-driven tool system to pure tool type-driven architecture using OutgoingMessage types
- **Enhanced Type Safety**: Replaced generic "crelay" routing with specific OutgoingMessage type-based routing (`sendDigits`, `end`, `text`, etc.)
- **Terminal Tool Timing Fix**: Implemented proper timing for terminal tools to ensure OpenAI response is delivered before call termination
- **Clean Separation of Concerns**: Eliminated all remaining event-driven concepts from tool execution and response handling

#### Tool Response Architecture Overhaul
- **OutgoingMessage Integration**: CRelay-specific tools now return proper `OutgoingMessage` types directly in their response
- **Generic vs. CRelay Tools**: Clear distinction between generic LLM tools (send-sms) and CRelay-specific tools (send-dtmf, end-call, live-agent-handoff)
- **Type-Driven Routing**: ConversationRelayService routes based on `outgoingMessage.type` instead of generic event types
- **Interface Imports**: CRelay tools import OutgoingMessage interfaces while generic tools remain dependency-free

#### Tool Response Pattern Updates
- **send-dtmf.ts**: Returns `SendDigitsMessage` type with immediate WebSocket delivery
- **end-call.ts**: Returns `EndSessionMessage` type with delayed delivery after OpenAI response
- **live-agent-handoff.ts**: Returns `EndSessionMessage` type with delayed delivery after OpenAI response  
- **send-sms.ts**: Remains generic tool with no OutgoingMessage dependencies

#### Service Architecture Clean-Up
- **OpenAIResponseService**: Completely agnostic about ConversationRelay concepts, passes all tool results generically
- **ConversationRelayService**: Contains all OutgoingMessage knowledge and routing logic based on message types
- **Terminal Message Timing**: Proper sequencing ensures user hears confirmation before call ends for terminal actions

#### Routing Logic Implementation
- **Immediate Delivery**: `sendDigits`, `play`, `language` types sent immediately to WebSocket
- **Delayed Delivery**: `end` type stored and sent after OpenAI response completion (`response.last === true`)
- **Standard Processing**: `text` type and tools without outgoingMessage processed normally by OpenAI
- **Type-Safe Switching**: Comprehensive switch statement handles all OutgoingMessage types appropriately

#### Code Cleanup and Documentation
- **Removed Event Remnants**: Eliminated all remaining references to event emission and "crelay" terminology
- **Updated Documentation**: Changed `@emits` to `@calls` throughout service documentation
- **Interface Cleanup**: Removed obsolete `crelayData` field from ToolResult interface
- **Comment Updates**: Updated all comments to reflect dependency injection patterns instead of event-driven patterns

### Benefits of Tool Type-Driven Architecture

#### Architectural Improvements
- **Pure Dependency Injection**: Complete elimination of event system in favor of direct function calls
- **Type-Safe Routing**: OutgoingMessage types provide compile-time safety for WebSocket message handling
- **Clear Tool Categories**: Explicit separation between generic LLM tools and conversation relay tools
- **Proper Timing Control**: Terminal tools now deliver responses before ending calls

#### Developer Experience
- **Better Type Safety**: OutgoingMessage interfaces provide full IntelliSense and compile-time checking
- **Cleaner Tool Development**: Clear patterns for different tool types with proper interface imports
- **Reduced Complexity**: Eliminated event system complexity in favor of straightforward return value routing
- **Enhanced Debugging**: Type-driven routing makes message flow easier to trace and debug

#### Performance & Reliability
- **Eliminated Event Overhead**: Direct function calls replace event emission for better performance
- **Proper Terminal Timing**: Users now hear confirmation messages before calls end for better UX
- **Reduced Memory Usage**: No event listener registration or cleanup overhead
- **Type Safety**: Compile-time validation prevents runtime routing errors

This migration represents the final step in moving from event-driven to pure dependency injection architecture, providing a clean, type-safe, and maintainable foundation for tool development and message routing.

## Release v4.2.1

### Unified Handler Architecture Refactoring

#### Consolidated Handler Interfaces
- **Unified ResponseHandler**: Replaced 4 individual setter methods (`setContentHandler`, `setToolResultHandler`, `setErrorHandler`, `setCallSidHandler`) with single `createResponseHandler(handler: ResponseHandler)` method
- **Unified ConversationRelayHandler**: Replaced 3 individual setter methods (`setOutgoingMessageHandler`, `setCallSidEventHandler`, `setSilenceEventHandler`) with single `createConversationRelayHandler(handler: ConversationRelayHandler)` method
- **Better Encapsulation**: Handler methods now use clean names like `content()`, `toolResult()`, `error()`, `callSid()` instead of event-style naming

#### Interface Architecture Improvements
- **ResponseHandler Interface**: Created unified interface with `content()`, `toolResult()`, `error()`, and `callSid()` methods
- **ConversationRelayHandler Interface**: Created unified interface with `outgoingMessage()`, `callSid()`, and `silence()` methods
- **Eliminated Circular Dependencies**: Removed circular dependency issues by using `createResponseHandler()` method instead of constructor injection

#### Service Implementation Updates
- **OpenAIResponseService**: Updated to use single `responseHandler` property and `createResponseHandler()` method
- **FlowiseResponseService**: Updated to use unified handler pattern for consistency
- **ConversationRelayService**: Updated to create unified handler objects and use `createConversationRelayHandler()` method
- **Server.ts Integration**: Updated WebSocket server to use unified handler objects instead of individual setter calls

#### Dependency Injection Enhancements
- **Cleaner Constructor Pattern**: Services now accept handlers through create methods rather than multiple setter calls
- **Better Type Safety**: Unified handlers provide stronger type contracts and better IntelliSense support
- **Simplified Service Setup**: Single handler object creation replaces multiple handler registration calls
- **Improved Maintainability**: Related handler methods are now grouped together in single interfaces

### Benefits of Unified Handler Architecture

#### Code Organization
- **Better Cohesion**: All related handler methods grouped in single interface objects
- **Cleaner APIs**: Single `createXxxHandler()` method instead of multiple setters eliminates setup complexity
- **Reduced Coupling**: Handler interfaces are self-contained and don't require multiple method calls

#### Developer Experience
- **Simplified Setup**: Single handler object creation replaces multiple setter method calls
- **Better Type Safety**: Unified interfaces provide comprehensive type checking for all handler methods
- **Enhanced IntelliSense**: IDE support improved with consolidated handler method definitions
- **Cleaner Dependencies**: Clear handler contracts make service relationships more transparent

#### Architectural Benefits
- **Eliminated Circular Dependencies**: `createResponseHandler()` pattern prevents construction-time circular dependency issues
- **Single Responsibility**: Each handler interface focuses on one specific communication domain
- **Better Separation of Concerns**: Clear distinction between different types of handler responsibilities
- **Future Extensibility**: Unified pattern makes it easier to add new handler methods without interface proliferation

This refactoring maintains full backward compatibility while providing a cleaner, more maintainable dependency injection architecture that eliminates multiple setter methods in favor of consolidated handler objects.

## Release v4.2.1 (Previous)

### Handler Type Organization Refactoring

#### Handler Type Relocation
- **Improved Organization**: Moved handler types from centralized `handlers.ts` to their respective interface files for better code organization
- **Enhanced Cohesion**: Handler types are now co-located with the interfaces they support, improving maintainability and discoverability
- **Cleaner Dependencies**: Reduced coupling between interface files by eliminating the central handler types dependency

#### File Structure Changes
- **Removed**: `server/src/types/handlers.ts` - Centralized handler types file eliminated
- **Enhanced**: `server/src/interfaces/ResponseService.d.ts` - Now includes `ContentHandler`, `ToolResultHandler`, and `ErrorHandler` types
- **Enhanced**: `server/src/interfaces/ConversationRelay.d.ts` - Now includes `OutgoingMessageHandler`, `CallSidEventHandler`, and `SilenceEventHandler` types
- **Updated**: All import statements updated to reference handler types from their respective interface files

#### Interface Method Updates
- **Type Safety Enhancement**: Updated interface method signatures to use proper type names instead of inline function types
- **Consistency Improvement**: All service implementations now use strongly-typed handler parameters consistently
- **Better IntelliSense**: Improved IDE support with proper type definitions co-located with interface documentation

#### Import Statement Updates
- **ConversationRelayService**: Updated to import handler types from `../interfaces/ConversationRelay.js`
- **OpenAIResponseService**: Updated to import handler types from `../interfaces/ResponseService.js`  
- **FlowiseResponseService**: Updated to import handler types from `../interfaces/ResponseService.js`
- **Eliminated Unused Imports**: Removed unnecessary import of `ToolResultEvent` in FlowiseResponseService

### Benefits of Handler Type Reorganization

#### Code Organization
- **Better Cohesion**: Handler types are now located next to the interfaces they support
- **Improved Discoverability**: Developers can find all related types and interfaces in a single file
- **Cleaner Architecture**: Eliminates the need for a centralized types file that creates unnecessary dependencies

#### Maintainability
- **Easier Updates**: Changes to handler signatures can be made alongside interface updates
- **Better Documentation**: Handler types benefit from proximity to interface documentation
- **Reduced Coupling**: Interface files are now self-contained with their associated types

#### Developer Experience
- **Enhanced IntelliSense**: IDE can provide better autocomplete and documentation when types and interfaces are co-located
- **Cleaner Imports**: Developers import both interfaces and their handler types from the same location
- **Better Code Navigation**: Related types and interfaces are in the same file for easier navigation

This refactoring maintains full backward compatibility while providing better code organization and improved developer experience through enhanced type locality and reduced coupling between interface files.

## Release v4.2.0

### Dependency Injection Architecture Migration

#### Complete Event-Driven to Dependency Injection Transformation
- **Architectural Paradigm Shift**: Migrated from EventEmitter-based communication to Dependency Injection pattern across all service layers
- **Enhanced Type Safety**: Replaced magic string events with strongly-typed handler functions for compile-time validation
- **Performance Optimization**: Eliminated EventEmitter overhead with direct function calls for faster service communication
- **Improved Testability**: Handler functions enable easier mocking, stubbing, and unit testing compared to event-based testing

#### ResponseService Interface DI Implementation
- **Handler Function Architecture**: Replaced EventEmitter inheritance with handler setter methods:
  - `setContentHandler(handler: ContentHandler): void` - For LLM streaming responses
  - `setToolResultHandler(handler: ToolResultHandler): void` - For tool execution results  
  - `setErrorHandler(handler: ErrorHandler): void` - For error event handling
  - `setCallSidHandler(handler: CallSidEventHandler): void` - For call-specific events
- **Service Implementations**: Updated OpenAIResponseService and FlowiseResponseService to use handler pattern
- **Type-Safe Communication**: Direct handler invocation with `this.contentHandler?.(response)` instead of `this.emit('responseService.content', response)`

#### ConversationRelayService DI Enhancement
- **Handler Integration**: Added support for ResponseService handlers through dependency injection
- **Outgoing Message Management**: Implemented `setOutgoingMessageHandler()` for WebSocket message transmission
- **Silence Event Handling**: Added `setSilenceEventHandler()` for silence detection and call termination events
- **Event Elimination**: Removed all `this.emit()` calls in favor of direct handler invocations

#### Server.ts WebSocket Integration
- **Selective DI Adoption**: Converted ConversationRelayService events to handlers while preserving WebSocket server events
- **Handler Registration**: Replaced `conversationRelaySession.on('conversationRelay.outgoingMessage', ...)` with `conversationRelaySession.setOutgoingMessageHandler(...)`
- **Call SID Event Handling**: Updated dynamic call-specific events to use static handlers with callSid parameters
- **Preserved WebSocket Architecture**: Maintained `ws.on('message')`, `ws.on('close')`, `ws.on('error')` event-driven pattern

#### Type System Enhancements
- **Handler Type Definitions**: Created comprehensive handler type system in `handlers.ts`:
  ```typescript
  export type ContentHandler = (response: ContentResponse) => void;
  export type ToolResultHandler = (toolResult: ToolResultEvent) => void;
  export type ErrorHandler = (error: Error) => void;
  export type CallSidEventHandler = (callSid: string, responseMessage: any) => void;
  export type OutgoingMessageHandler = (message: OutgoingMessage) => void;
  export type SilenceEventHandler = (message: OutgoingMessage) => void;
  ```
- **Interface Updates**: Enhanced ResponseService and ConversationRelay interfaces with handler setter methods
- **Type Safety**: Proper type conversion from `ContentResponse` to `OutgoingMessage` for cross-service communication

#### Resource Management
- **Handler Cleanup**: Implemented proper handler cleanup in service destructors to prevent memory leaks
- **Optional Chaining**: Used `?.()` operator for safe handler invocation when handlers may not be set
- **Service Lifecycle**: Enhanced cleanup methods to clear all handlers and prevent resource leaks

### Benefits of Dependency Injection Architecture

#### Performance Improvements
- **Direct Function Calls**: Eliminated EventEmitter dispatch overhead for faster service communication
- **Reduced Memory Footprint**: No event listener registration and cleanup overhead
- **Optimized Call Stack**: Direct handler invocation without event system intermediation

#### Type Safety & Developer Experience  
- **Compile-Time Validation**: TypeScript enforces correct handler signatures and prevents runtime errors
- **IntelliSense Support**: Full IDE autocompletion and documentation for handler functions
- **Elimination of Magic Strings**: No more `'responseService.content'` strings that can break silently

#### Testing & Maintainability
- **Easier Mocking**: Handler functions are simple to mock compared to complex event listener testing
- **Unit Test Isolation**: Individual handlers can be tested independently without event system complexity
- **Cleaner Dependencies**: Clear handler contracts make service dependencies explicit and manageable

#### Architectural Benefits
- **Single Responsibility**: Each handler focuses on one specific communication channel
- **Interface Segregation**: Services only implement handlers they actually need
- **Dependency Inversion**: Services depend on handler abstractions, not concrete implementations
- **Better Separation of Concerns**: Clear distinction between service logic and communication mechanisms

This migration represents a fundamental architectural improvement providing better performance, type safety, and maintainability while maintaining full functional compatibility with existing WebSocket and HTTP endpoints.

## Release v4.1.2

### Interface Method Splitting

#### ResponseService Interface Enhancement
- **Method Separation**: Split `updateContextAndManifest(contextFile: string, toolManifestFile: string)` into two separate methods:
  - `updateContext(contextFile: string): Promise<void>` - Updates only the context file
  - `updateTools(toolManifestFile: string): Promise<void>` - Updates only the tool manifest file
- **Better Separation of Concerns**: Each method now has a single, clear responsibility
- **Granular Control**: Applications can now update context or tools independently as needed

#### ConversationRelay Interface Enhancement
- **Consistent API**: Applied the same method splitting to the ConversationRelay interface
- **Interface Alignment**: Both ResponseService and ConversationRelay interfaces now have matching method signatures
- **Type Safety**: Updated interface declarations in both interface and class definitions

#### Implementation Updates
- **OpenAIResponseService**: Split the complex `updateContextAndManifest()` implementation into:
  - `updateContext()` - Handles context file loading, instruction updates, and conversation reset
  - `updateTools()` - Handles tool manifest loading and dynamic tool reloading
- **FlowiseResponseService**: Updated stub implementation with separate methods
- **ConversationRelayService**: Replaced single proxy method with two separate proxy methods
- **Server.ts**: Updated call site to use both methods sequentially

#### Factory Method Updates
- **OpenAIResponseService.create()**: Now calls both `updateContext()` and `updateTools()` separately
- **FlowiseResponseService.create()**: Updated to use the new method signatures
- **Backward Compatibility**: All existing functionality is preserved

### Benefits
- **Single Responsibility Principle**: Each method focuses on one specific update operation
- **Improved Flexibility**: Context and tools can be updated independently
- **Better Code Organization**: Clearer separation between context and tool management
- **Enhanced Maintainability**: Easier to test and modify individual components
- **Consistent API Design**: Uniform method signatures across all service interfaces

This refactoring maintains full backward compatibility while providing more granular control over service configuration updates.

## Release v4.1.1

### Service Naming Refactoring

#### OpenAI Service Renaming
- **Service Clarity**: Renamed `OpenAIService` to `OpenAIResponseService` for better clarity and consistency
- **File Renaming**: Updated `OpenAIService.ts` to `OpenAIResponseService.ts` in the services directory
- **Import Updates**: Updated all import statements throughout the codebase to reference the new service name
- **Class References**: Updated all class instantiations and references from `OpenAIService` to `OpenAIResponseService`
- **Logging Updates**: Updated all logging messages to use the new service name for consistency

#### Documentation Updates
- **README.md**: Updated service references and project structure documentation to reflect the new naming
- **CHANGELOG.md**: Added comprehensive release notes for the renaming refactoring
- **Version Bump**: Updated package.json version to 4.1.1

### Benefits
- **Improved Clarity**: The new name better reflects the service's role as a response service implementation
- **Consistent Naming**: Aligns with the service architecture patterns established in previous releases
- **Better Code Readability**: More descriptive class names improve code understanding
- **Maintainability**: Consistent naming conventions across the codebase

This refactoring maintains full backward compatibility while improving code clarity and consistency with established naming patterns.

## Release v4.1.0

### Service Architecture Refactoring

#### ConversationRelayService Enhancement
- **Enhanced Encapsulation**: Moved all OpenAI service creation and management into ConversationRelayService
- **Async Factory Pattern**: Added static `create()` factory method for proper async initialization of ConversationRelayService
- **Proxy Methods**: Added `insertMessage()` and `updateContextAndManifest()` proxy methods for clean API access
- **Event Management**: Improved event forwarding from `responseService.${callSid}` to `conversationRelay.${callSid}`

#### Server.ts Simplification
- **Removed Direct OpenAI Service Creation**: Eliminated lines 146-151 and 155-160 from server.ts 
- **Updated WSSession Interface**: Removed `sessionResponseService` dependency from WebSocket sessions
- **Cleaner Architecture**: Server.ts now focuses purely on WebSocket/HTTP handling without LLM service management
- **Method Migration**: All `sessionResponseService` calls now use `conversationRelaySession` proxy methods
- **Variable Naming Consistency**: Renamed `sessionConversationRelay` to `conversationRelaySession` throughout server.ts for consistent naming conventions

#### Interface Updates
- **Enhanced ResponseService Interface**: Added `updateContextAndManifest()` method to the interface definition
- **Type Safety**: Improved type checking with proper role parameter types for `insertMessage()`
- **Event Consistency**: Standardized event naming from `responseService.${callSid}` to `conversationRelay.${callSid}`

#### Outgoing Message Interface Enforcement
- **Added Twilio Outgoing Message Interfaces**: Implemented comprehensive TypeScript interfaces for all Twilio WebSocket outgoing message types based on official documentation
- **Enhanced Type Safety**: Added `OutgoingMessage` union type covering `TextTokensMessage`, `PlayMediaMessage`, `SendDigitsMessage`, `SwitchLanguageMessage`, and `EndSessionMessage`
- **Method Signature Updates**: Updated `outgoingMessage()` method to accept structured `OutgoingMessage` types instead of generic strings
- **Separation of Concerns**: Clear distinction between `outgoingMessage()` for Twilio commands and `insertMessage()` for conversation context
- **Removed Any Types**: Replaced `any` type annotations with proper `OutgoingMessage` types in WebSocket event handlers

#### Interface Naming Refactoring
- **Resolved Naming Conflicts**: Renamed `ConversationRelayService.d.ts` to `ConversationRelay.d.ts` to eliminate naming conflicts between interface and class
- **Interface Renaming**: Updated interface name from `ConversationRelayService` to `ConversationRelay` for better separation
- **Import Updates**: Updated all import statements to use the new file name and removed unnecessary aliasing (`as IConversationRelayService`)
- **Type Safety Improvements**: Eliminated TypeScript compilation errors caused by naming conflicts

### Benefits
- **Single Responsibility**: ConversationRelayService now manages all LLM service interactions
- **Improved Maintainability**: Clear separation between WebSocket handling and conversation management
- **Better Encapsulation**: All OpenAI service logic contained within a single service class
- **Consistent API**: Uniform access to response service functionality through proxy methods
- **Enhanced Type Safety**: Comprehensive TypeScript interfaces ensure compile-time validation of all Twilio WebSocket messages
- **Better Developer Experience**: IntelliSense support and type checking for all outgoing message structures
- **Cleaner Interface Separation**: Clear distinction between interface definitions and class implementations

This refactoring provides better code organization and maintainability while maintaining full backward compatibility.

## Release v4.0.1

### Bug Fixes

#### Fixed Duplicate Function Call Error
- **Issue**: OpenAI Response API was rejecting requests with "400 Duplicate item found" error after tool execution
- **Root Cause**: The `store: true` parameter caused conflicts between Response API's internal state management and manual `inputMessages` management
- **Solution**: Removed `store: true` and `previous_response_id` from all Response API calls, letting manual conversation state management handle everything
- **Impact**: Tool calls (like SMS) now work correctly with multiple interruptions and follow-up responses

#### Technical Details
- Response API with `store: true` maintains conversation state internally
- Manual function call management in `inputMessages` conflicted with API's stored state
- Removing conversation storage eliminated both "duplicate item" and "no tool output" errors
- System now uses traditional accumulative `inputMessages` approach without API storage conflicts

This fix ensures reliable tool execution in conversation flows with multiple user interactions and interruptions.

## Release v4.0.0

This release introduces a major architectural refactor that fundamentally changes how LLM services are implemented and managed, moving from inheritance-based to interface-based architecture while fixing critical design issues.

### 🚨 Breaking Changes

#### Interface-Based Architecture (Composition over Inheritance)
- **Removed**: `ResponseService.ts` base class - the inheritance-based approach has been completely removed
- **Added**: `ResponseService.d.ts` interface defining the contract for all LLM service implementations
- **Changed**: OpenAIService now implements the ResponseService interface instead of extending a base class
- **Benefits**: Better TypeScript support, cleaner separation of concerns, easier testing and mocking

#### Factory Pattern for Async Initialization
- **Fixed**: Invalid async constructor pattern in OpenAIService
- **Changed**: Constructor is now private and synchronous-only
- **Added**: Static `create()` factory method for proper async initialization
- **Migration**: Replace `new OpenAIService(contextFile, toolManifestFile)` with `await OpenAIService.create(contextFile, toolManifestFile)`

#### Service Removal
- **Removed**: Complete removal of DeepSeek service support
- **Simplified**: System now focuses exclusively on OpenAI integration
- **Environment**: DEEPSEEK_API_KEY and DEEPSEEK_MODEL environment variables are no longer used

#### API Standardization
- **Changed**: Method `insertMessageIntoContext()` renamed to `insertMessage()` for consistency with interface
- **Standardized**: All ResponseService implementations now follow the same method signatures
- **Improved**: Better error handling and type safety across all service methods

### Technical Improvements

#### Enhanced Type Safety
- **Interface Contracts**: All LLM services must implement the ResponseService interface
- **Type Definitions**: Comprehensive TypeScript interfaces for ContentResponse, ToolResult, and ToolResultEvent
- **Event Standardization**: Consistent event emission patterns across all services

#### Import Structure Updates
- **Interface Imports**: Updated from concrete class imports to interface definitions
- **Path Updates**: ConversationRelayService now imports from `../interfaces/ResponseService.js`
- **Cleaner Dependencies**: Better separation between interfaces and implementations

### Migration Guide

#### For OpenAIService Usage:
```typescript
// Before (v3.x)
const service = new OpenAIService(contextFile, toolManifestFile);

// After (v4.0)
const service = await OpenAIService.create(contextFile, toolManifestFile);
```

#### For Custom LLM Providers:
```typescript
// Before (v3.x)
class CustomService extends ResponseService {
  constructor() {
    super();
    // initialization
  }
}

// After (v4.0) - Note: v4.2.0 removes EventEmitter inheritance for pure DI
class CustomService extends EventEmitter implements ResponseService {
  private constructor() {
    super();
    // sync initialization only
  }
  
  static async create(): Promise<CustomService> {
    const service = new CustomService();
    await service.initialize();
    return service;
  }
  
  // Implement all ResponseService interface methods
  async generateResponse(role: 'user' | 'system', prompt: string): Promise<void> { ... }
  async insertMessage(role: 'system' | 'user' | 'assistant', message: string): Promise<void> { ... }
  interrupt(): void { ... }
  cleanup(): void { ... }
}
```

#### For Method Name Updates:
```typescript
// Before (v3.x)
await responseService.insertMessageIntoContext('system', message);

// After (v4.0)
await responseService.insertMessage('system', message);
```

### Architecture Benefits

- **Composition over Inheritance**: More flexible and maintainable design pattern
- **Interface Segregation**: Clear contracts for service implementations
- **Dependency Inversion**: Depend on interfaces, not concrete implementations
- **Better Testing**: Easier to mock and test service interactions
- **Type Safety**: Compile-time checking of service method implementations

This release represents a fundamental improvement in the codebase architecture, providing better maintainability, type safety, and extensibility while removing deprecated service providers.

## Release v3.4.0

### Features

#### Centralized Type Definitions
- **Added**: Centralized type definitions in `server/src/interfaces/ConversationRelay.d.ts`
- **Consolidated**: `IncomingMessage` interface from 2 duplicate definitions across files
- **Added**: `OutgoingMessage` union type with proper TypeScript typing (replaces `any`)
- **Consolidated**: `SessionData` interface from 2 duplicate definitions
- **Consolidated**: `ToolEvent` interface from 5+ duplicate definitions across tool files
- **Consolidated**: `ToolResult` interface centralized from ResponseService
- **Impact**: Eliminates interface duplication, improves type safety, enables better IDE support

#### Enhanced File Loading Visibility
- **Added**: Comprehensive logging for context and manifest file loading
- **Shows**: Which context and tool manifest files are loaded on session initialization
- **Shows**: File statistics (character count for context, tool count for manifests)
- **Shows**: Both initial loading and dynamic file updates
- **Impact**: Full visibility into configuration file loading for debugging and monitoring

### Technical Improvements
- **Updated**: All 8 affected files to use centralized type definitions
- **Enhanced**: Import statements use `import type` for better build optimization
- **Maintained**: Full backward compatibility with existing functionality
- **Verified**: All TypeScript compilation passes without errors

## Release v3.3.3

### Bug Fixes

#### Fixed OpenAI Message Timing for Tool Calls
- **Issue**: Tool results (especially terminal actions like end-call) were being sent to cCRelay before OpenAI finished streaming its response, causing callers to hear tool responses instead of the intended OpenAI message
- **Root Cause**: In the event-driven architecture, `toolEvent.emit('crelay', data)` sent messages immediately to WebSocket without waiting for OpenAI response completion
- **Solution**: Added message classification in `ConversationRelayService` to delay terminal messages (`type: 'end'`) until OpenAI response completes (`response.last === true`)
- **Impact**: Callers now properly hear OpenAI messages first, then terminal tool actions execute, ensuring correct conversation flow

#### Technical Details
- Added `pendingTerminalMessage` property to store terminal messages temporarily
- Enhanced `responseService.toolResult` event handler to classify messages by type:
  - Terminal messages (`type: "end"`) → stored for delayed execution
  - Immediate messages (`type: "sendDigits"`, `"play"`, `"language"`) → sent immediately
- Enhanced `responseService.content` event handler to send pending messages when `response.last === true`
- Maintains complete event-driven architecture with no changes to tools or ResponseService
- Backward compatible with existing behavior for all non-terminal messages

This fix ensures proper message sequencing while preserving v3.0's event architecture: OpenAI response streams to caller → then terminal actions execute.

## Release v3.3.2

### Bug Fixes

#### Fixed Duplicate Function Call Error
- **Issue**: OpenAI Response API was rejecting requests with "400 Duplicate item found" error after tool execution
- **Root Cause**: The `store: true` parameter caused conflicts between Response API's internal state management and manual `inputMessages` management
- **Solution**: Removed `store: true` and `previous_response_id` from all Response API calls, letting manual conversation state management handle everything
- **Impact**: Tool calls (like SMS) now work correctly with multiple interruptions and follow-up responses

#### Technical Details
- Response API with `store: true` maintains conversation state internally
- Manual function call management in `inputMessages` conflicted with API's stored state
- Removing conversation storage eliminated both "duplicate item" and "no tool output" errors
- System now uses traditional accumulative `inputMessages` approach without API storage conflicts

This fix ensures reliable tool execution in conversation flows with multiple user interactions and interruptions.

## Release v3.3.1

### Development & Documentation Updates

- **Updated Development Script**: Changed from `tsc && nodemon` to `tsx watch src/server.ts` for faster development cycles
- **OpenAI Version Upgrade**: Updated OpenAI package version in package.json
- **AbortController Documentation**: Added technical comparison section in README explaining AbortController vs. boolean flag approaches for interrupt handling

## Release v3.3

This release enhances type safety and API alignment by migrating from custom streaming event interfaces to OpenAI's native typed streaming events, providing better maintainability and future-proofing.

### Migration to OpenAI Native Streaming Events

The system has been updated to use OpenAI's native `ResponseStreamEvent` types instead of custom `ResponseAPIEvent` interfaces, bringing several key benefits:

- **Enhanced Type Safety**: Full TypeScript support with OpenAI's official event types
- **Better API Alignment**: Direct use of OpenAI's streaming event specifications
- **Improved Maintainability**: Reduced custom code in favor of official SDK types
- **Future-Proof Architecture**: Automatic compatibility with OpenAI's evolving streaming API

### Key Changes

- **Native Event Types**: Replaced custom `ResponsesAPIEvent` interface with OpenAI's `ResponseStreamEvent` union type
- **Proper Event Handling**: Updated event processing to use correct OpenAI event names (e.g., `response.completed` instead of `response.done`)
- **Type-Safe Streaming**: Full TypeScript support for all streaming events including `ResponseCreatedEvent`, `ResponseTextDeltaEvent`, `ResponseCompletedEvent`, etc.
- **Enhanced Error Detection**: Better error handling through properly typed event structures

### Technical Details

The migration involved:
- Importing `ResponseStreamEvent` from `openai/resources/responses/responses.mjs`
- Removing the custom `ResponsesAPIEvent` interface
- Updating event type checking to use OpenAI's official event type names
- Ensuring proper type safety throughout the streaming pipeline

### Benefits

- **Reduced Maintenance**: No need to maintain custom event interfaces that duplicate OpenAI's functionality
- **Better Documentation**: Direct access to OpenAI's official type documentation
- **Automatic Updates**: Future OpenAI SDK updates will automatically provide new event types
- **Type Safety**: Compile-time checking ensures correct event handling

This change aligns the codebase with OpenAI's official streaming API documentation and provides better long-term maintainability while maintaining full backward compatibility.

## Release v3.2

This release introduces a significant architectural improvement with the migration from the toolType-based system to a ToolEvent-based system, providing enhanced flexibility and cleaner separation of concerns for tool execution.

### Migration to ToolEvent System

The system has been updated to use a ToolEvent-based architecture instead of the previous toolType system, bringing several key benefits:

- **Enhanced Tool Isolation**: Tools now receive a ToolEvent object that provides controlled access to emit events, logging, and error handling
- **Improved Event Management**: Clear separation between tool execution and event emission through the ToolEvent interface
- **Better Error Handling**: Tools can now emit errors and log messages through the ToolEvent system
- **Cleaner Architecture**: Removal of complex toolType switching logic in favor of event-driven communication

### Key Changes

- **ToolEvent Interface**: Tools now receive a ToolEvent object with `emit()`, `log()`, and `logError()` methods
- **Event-Driven Communication**: Tools emit events using `toolEvent.emit(eventType, data)` instead of returning toolType objects
- **Simplified Tool Logic**: Tools focus on their core functionality while delegating communication to the ToolEvent system
- **Enhanced Logging**: Built-in logging capabilities through the ToolEvent interface

### Technical Improvements

- **ResponseService Enhancement**: The `createToolEvent()` method provides tools with a controlled interface for event emission
- **Event Processing**: Tools emit events that are processed by the ResponseService and forwarded to ConversationRelayService
- **Backward Compatibility**: The system maintains compatibility while providing a more robust foundation for tool development
- **Type Safety**: Enhanced TypeScript interfaces for ToolEvent and tool responses

### Tool Implementation Changes

Tools now follow this pattern:

```typescript
export default function (functionArguments: ToolArguments, toolEvent?: ToolEvent): ToolResponse {
    // Tool logic here
    
    if (toolEvent) {
        // Emit events for WebSocket transmission
        toolEvent.emit('crelay', {
            type: "action",
            data: actionData
        });
        toolEvent.log(`Action completed: ${JSON.stringify(actionData)}`);
    }
    
    // Return simple response for conversation context
    return {
        success: true,
        message: "Action completed successfully"
    };
}
```

This migration provides a more maintainable and extensible architecture for tool development while maintaining full backward compatibility.

## Release v3.1

This release introduces a significant architectural improvement with the migration from OpenAI's ChatCompletion API to the Response API, providing enhanced flexibility and future-proofing for LLM integrations.

### Migration to Response API

The system has been updated to use OpenAI's Response API instead of the ChatCompletion API, bringing several key benefits:

- **Enhanced Robustness**: The Response API provides more reliable streaming capabilities and better error handling
- **Improved Flexibility**: Support for additional response formats and processing options  
- **Future-Proof Architecture**: Better alignment with OpenAI's evolving API ecosystem
- **Multi-Provider Support**: Foundation for easier integration of additional LLM providers beyond OpenAI

### Key Changes

- **ResponseService Architecture**: The OpenAIService has been enhanced with a new ResponseService base class that abstracts LLM interactions
- **Unified Interface**: All LLM providers now implement a consistent interface through the ResponseService pattern
- **Enhanced Error Handling**: Improved error detection and recovery mechanisms
- **Streaming Optimization**: Better handling of streaming responses with interrupt capabilities

### Technical Improvements

- Migrated from ChatCompletion API to Response API for all OpenAI interactions
- Implemented ResponseService base class for consistent LLM provider abstraction
- Enhanced streaming response handling with improved interrupt capabilities
- Improved error handling and recovery mechanisms across all LLM interactions
- Maintained full backward compatibility while providing foundation for future enhancements

This migration maintains full backward compatibility while providing a more robust foundation for future enhancements and multi-provider LLM support.

## Release v3.0

- Converted the entire project from JavaScript to TypeScript
- Added type definitions for all components
- Implemented interfaces for data structures
- Added return type declarations
- Enhanced JSDoc comments with TypeScript-specific documentation
- Added tsconfig.json for TypeScript configuration

## Release v2.4

NOTE: - Updated the Voices in the TwilioService.ts file to reflect What is available now as of March 2025. New 11Labs voices are coming soon.

This release introduces a structured tool response system to improve tool integration and response handling:

### Enhanced Tool Response Architecture
- Implemented a standardized response format with `toolType` and `toolData` properties
- Created a type-based routing system for different kinds of tool responses
- Added support for four distinct response types: "tool", "crelay", "error", and "llm"
- Improved separation between conversation flow and direct actions

This architecture enables more flexible tool integration by clearly defining how each tool's response should be processed:
- Standard tools return results to the LLM for conversational responses
- Conversation Relay tools bypass the LLM for direct WebSocket communication
- Error responses are handled gracefully within the conversation context
- Future extensibility is built in with the reserved "llm" type

The new system improves reliability, reduces complexity, and creates a clear separation of concerns between different types of tool operations.

## Release v2.3

This release adds interrupt handling capabilities to improve the conversational experience:

### Interrupt Handling
- Added support for handling user interruptions during AI responses
- Implemented interrupt detection and processing in ConversationRelayService
- Added interrupt() and resetInterrupt() methods to ResponseService for controlling response streaming
- Enhanced streaming response generation to check for interruptions and stop gracefully
- Improved user experience by allowing natural conversation flow with interruptions

When a user interrupts the AI during a response:
1. The system detects the interruption and sends an 'interrupt' message with the partial utterance
2. ConversationRelayService processes this message and calls responseService.interrupt()
3. ResponseService sets an isInterrupted flag that stops the current streaming response
4. The system can then process the user's new input immediately

The interrupt mechanism works by:
- Setting the isInterrupted flag to true in the ResponseService
- Breaking out of the streaming loop in generateResponse
- Allowing the system to process the new user input
- Automatically resetting the interrupt flag at the beginning of each new response generation

This feature enables more natural conversations by allowing users to interrupt lengthy responses, correct misunderstandings immediately, or redirect the conversation without waiting for the AI to finish speaking.

## Release v2.2

This release adds the ability to dynamically update conversation contexts and tool manifests during an active call:

### Dynamic Context & Manifest Updates
- Added new `/updateResponseService` endpoint to change conversation context and tool manifest files during active calls
- Enables real-time switching between different conversation scenarios without ending the call
- Supports seamless transitions between different AI behaviors and tool sets

#### Using the Update Endpoint

To update the context and manifest files for an active call, send a POST request to the `/updateResponseService` endpoint:

```bash
curl -X POST \
  'https://your-server-url/updateResponseService' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "callSid": "CA1234...",           # The active call's SID
    "contextFile": "MyContext.md",     # New context file to load
    "toolManifestFile": "MyToolManifest.json"  # New tool manifest to load
  }'
```

This allows you to:
- Switch conversation contexts mid-call
- Update available tools based on conversation flow
- Adapt AI behavior for different phases of the call
- Maintain call continuity while changing conversation parameters

## Release v2.1

This release brings significant enhancements to the conversation relay system:

### Dynamic Context & Manifest Loading
- Implemented a flexible context loading system that allows switching conversation contexts and tool sets at runtime
- Added support for multiple context files (e.g., defaultContext.md, MyContext.md) to handle different use cases
- Enhanced tool manifest system with dynamic loading capabilities, allowing tools to be loaded based on context
- Environment variables (LLM_CONTEXT, LLM_MANIFEST) now control which context and tools are loaded
- Improved separation of concerns by isolating different conversation scenarios with their own contexts

### Added DeepSeek Response Service
- Integrated DeepSeek as an alternative LLM provider alongside OpenAI
- Implemented DeepSeekService extending the base ResponseService for consistent behavior
- Added configuration support through DEEPSEEK_API_KEY and DEEPSEEK_MODEL environment variables
- Maintains full compatibility with existing tool execution and conversation management features
- Enables easy switching between LLM providers through service configuration

### Added Twilio Status Callback Endpoint
- New `/twilioStatusCallback` endpoint for handling Twilio event notifications
- Real-time status updates are now propagated to the conversation context
- Implemented event-based system to route callbacks to appropriate conversation sessions
- Status updates are automatically inserted into conversation context for LLM awareness
- Enhanced call monitoring and state management through Twilio's callback system
