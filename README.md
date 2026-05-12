# Simple Conversation Relay

This is a reference implementation aimed at introducing the key concepts of Conversation Relay. The key here is to ensure it is a workable environment that can be used to understand the basic concepts of Conversation Relay. It is intentionally simple and only the minimum has been done to ensure the understanding is focussed on the core concepts.

## Release v4.12.0 - ConversationRelay Session Model + In-Code Tool Registry

Ports CRelay patterns from the upcoming `@twilio/tac-conversationrelay` package. The WebSocket wire protocol is unchanged — this is an internal architecture refresh.

**🎯 Key Changes:**
- **Per-WebSocket session class** (`ConversationRelaySession`) owns all per-call state and is the sole writer to the WebSocket.
- **In-code tool registry**: tools are defined in their `server/src/tools/*.ts` file via `defineTool({...})` and registered once at startup via a `ToolRegistry`. `defaultToolManifest.json` is gone — schema and handler are now co-located.
- **Zod-validated wire frames** with compile-time SDK drift guards pinned to the Twilio SDK types.
- **Progressive-timeout `SilenceHandler`** — same wire behaviour, cheaper timer, no per-second wakeups.
- **Terminal-frame deferral + in-flight tool tracking** so a tool-dispatched `end` frame can't race ahead of the LLM's streamed farewell.
- **All tools now exposed**: `play-media` and `set-listen-mode` were present in `server/src/tools/` but absent from v4.11's JSON manifest; they now register with the rest.

**⚠️ Breaking (internal):** `ConversationRelayService` removed (use `ConversationRelaySession`). `SetSilenceDetectionMessage` type removed — tools return `silenceEnabled: boolean`. Per-leg tool subsets no longer supported (all-tools-all-legs).

**📦 Dependency bumps:** `twilio` 5→6, `express` 4→5, `openai` 5→6, `zod` 3→4, `typescript` 5→6, `@types/node` 22→25, `dotenv` 16→17.

**🧪 Testing:**
- `npm test` - Run full test suite (61 tests)
- `npm run test:watch` - Watch mode
- `npm run test:ui` - Interactive UI
- `npm run test:coverage` - Coverage report

See the [CHANGELOG.md](./CHANGELOG.md) for detailed release history.

## Prerequisites

- Node.js ≥ v20 (required by `twilio` v6)
- pnpm (or npm)
- ngrok
- TypeScript (installed as a dev dependency; no global install needed)

## Server

### Project Structure

```
.
├── server/                # WebSocket server for conversation relay
│   ├── .env.example      # Example environment configuration
│   ├── package.json      # Server dependencies and scripts
│   ├── tsconfig.json     # TypeScript configuration
│   ├── assets/
│   │   ├── defaultContext.md    # Default LLM system prompt (markdown)
│   │   ├── serverConfig.json    # TwiML config, silence detection, active context key
│   │   └── legs/                # Optional per-leg context.md overrides
│   └── src/
│       ├── server.ts                    # Express + WebSocket entrypoint
│       ├── config/
│       │   └── ServerConfig.ts          # Centralised env + config (v4.10)
│       ├── interfaces/                  # Type definitions (.d.ts)
│       │   ├── ConversationRelay.d.ts   # Re-exports + TwiML types + SessionData
│       │   ├── ResponseService.d.ts     # ResponseService + ResponseHandler interfaces
│       │   ├── AssetLoader.d.ts
│       │   └── CachedAssetsService.d.ts
│       ├── services/
│       │   ├── ConversationRelaySession.ts  # Per-WebSocket session (v4.12)
│       │   ├── OpenAIResponseService.ts     # OpenAI Responses API + ToolRegistry
│       │   ├── CachedAssetsService.ts       # Context cache + server config (v4.12 slim)
│       │   ├── FileAssetLoader.ts           # Load assets from disk
│       │   ├── SyncAssetLoader.ts           # Load assets from Twilio Sync
│       │   ├── SilenceHandler.ts            # Progressive-timeout silence detection (v4.12)
│       │   └── TwilioService.ts             # TwiML + outbound + status callback
│       ├── tools/                       # CR tools (v4.12: defineTool + ToolRegistry)
│       │   ├── define-tool.ts           # defineTool() factory
│       │   ├── tool-registry.ts         # ToolRegistry class
│       │   ├── index.ts                 # buildDefaultRegistry() — startup wiring
│       │   ├── end-call.ts
│       │   ├── live-agent-handoff.ts
│       │   ├── send-dtmf.ts
│       │   ├── send-sms.ts              # Factory: createSendSMSTool(config)
│       │   ├── play-media.ts
│       │   ├── switch-language.ts
│       │   ├── set-listen-mode.ts
│       │   ├── set-silence-detection.ts
│       │   └── change-context.ts        # Factory: createChangeContextTool(cache)
│       ├── types/
│       │   └── crelay.ts                # Zod schemas for CR wire frames + SDK drift guards
│       └── utils/
│           └── logger.ts
```

The server handles WebSocket connections and manages conversation relay functionality. It includes GPT service integration for natural language processing and Twilio integration for voice call handling.

### Running the Server

1. Navigate to the server directory:
```bash
cd server
```

2. Install dependencies:
```bash
# Using pnpm (recommended)
pnpm install

# Or using npm
npm install
```

3. For development, start the development server:
```bash
# Using pnpm
pnpm dev

# Or using npm
npm run dev
```

For production, build and start the server:
```bash
# Using pnpm
pnpm build
pnpm start

# Or using npm
npm run build
npm start
```

4. Ensure the server is running on port 3007 (or configured port in `.env`).

**Note:** If the configured port is already in use, the server will automatically retry on the next available port (e.g., 3002, 3003, etc.). This allows running multiple server instances simultaneously for testing and development.

5. Optionally, expose the server using ngrok:
```bash
ngrok http --domain server-yourdomain.ngrok.dev 3007
```

### How It Works

1. **Initialization**: Silence monitoring starts after the initial setup message, ensuring the system is ready for conversation.

2. **Message Tracking**:
   - The system tracks the time since the last meaningful message
   - Info-type messages are intentionally ignored to prevent false resets
   - Valid messages (prompt, interrupt, dtmf) reset both the timer and retry counter

3. **Response Sequence** (configured in `serverConfig.json` under `ConversationRelay.SilenceDetection`):
   - After `secondsThreshold` seconds of silence (default 20): sends the next reminder from the `messages` array (e.g. "Still there?")
   - After all reminders have fired and silence persists: ends the call with `reasonCode: 'unresponsive'`
   - v4.12: the handler uses a progressive `setTimeout` chain (not per-second polling), so it's idle between breaches

4. **Cleanup**: The session stops its silence handler and clears all per-call state when the WebSocket closes.

## Twilio Configuration

### Twilio Phone Number Configuration

1. Configure your Twilio phone number to point to the "connectConversationRelay" endpoint:
   - Go to your Twilio Console > Phone Numbers > Active Numbers
   - Select your phone number
   - Under "Voice & Fax" > "A Call Comes In"
   - Set it to "Webhook" and enter:
     ```
     https://server-yourdomain.ngrok.dev/connectConversationRelay
     ```
   - Method: HTTP POST

### TwiML Configuration

The server **dynamically generates TwiML** using configuration stored in Twilio Sync Maps. Instead of hardcoded values, all conversation relay parameters are loaded from your Sync configuration:

```typescript
// TwiML is generated dynamically from Sync Maps configuration
const config = await this.getConversationRelayConfig(); // Loads from Sync Maps
const languages = await this.getLanguages(); // Loads language settings

const conversationRelay = connect.conversationRelay({
    url: `wss://${serverBaseUrl}/conversation-relay`,
    transcriptionProvider: config.transcriptionProvider,  // From Sync Maps
    speechModel: config.speechModel,                      // From Sync Maps
    interruptible: config.interruptible,                  // From Sync Maps
    ttsProvider: config.ttsProvider,                      // From Sync Maps
    voice: config.voice,                                  // From Sync Maps
    dtmfDetection: config.dtmfDetection,                  // From Sync Maps
    welcomeGreeting: config.welcomeGreeting               // From Sync Maps
});
```

**Configuration Management:**
- **File Mode (`"assetLoaderType": "file"`)**: Configuration loaded from `serverConfig.json`
- **Sync Mode (`"assetLoaderType": "sync"`)**:
  - Configuration stored in Sync `serverConfig` document
  - Local `serverConfig.json` automatically synced to Sync on startup
  - Configuration can be updated via Sync API without server restarts
- **Language Support**: Languages array nested in `ConversationRelay.Configuration.languages[]`
- **Enhanced Properties**: Full Twilio ConversationRelay TwiML properties supported

### Twilio Edge Locations (Optional)

Twilio Edge Locations allow you to route API calls through specific data centers for improved latency and performance. This is particularly useful when your infrastructure or users are located in specific geographic regions.

**Configuration:**

Add these optional environment variables to your `.env` file:

```bash
TWILIO_EDGE=sydney      # Edge location (e.g., sydney, dublin, ashburn)
TWILIO_REGION=au1       # Region code (e.g., au1, ie1, us1)
```

**Available Edge Locations:**

| Location | Edge Value | Region Value | Hostname |
|----------|------------|--------------|----------|
| Sydney (Australia) | `sydney` | `au1` | `api.sydney.au1.twilio.com` |
| Dublin (Ireland) | `dublin` | `ie1` | `api.dublin.ie1.twilio.com` |
| Ashburn (US East) | `ashburn` | `us1` | `api.ashburn.us1.twilio.com` |

**Important Notes:**
- Both `TWILIO_EDGE` and `TWILIO_REGION` must be specified together
- If not configured, the system defaults to Twilio's global low-latency routing
- Edge routing applies to all Twilio API calls (voice, SMS, Sync, etc.)

**When to Use:**
- Your infrastructure is deployed in a specific region (e.g., hosting in Australia)
- You need predictable IP address ranges for firewall configuration
- You want to optimize latency for users in a particular geographic area

### WebSocket Connection Flow

1. When a call is received, Twilio initiates a WebSocket connection to `wss://server-yourdomain.ngrok.dev/conversation-relay`
2. The server receives a 'setup' message containing call details and custom parameters
3. The server creates service instances and begins processing incoming messages
4. Each WebSocket connection maintains its own isolated session in a wsSessionsMap

## OpenAI Context Configuration

The server supports flexible context and manifest management through both local files and Twilio Sync storage:

### Asset Loading Approaches

**File-Based Loading (`"assetLoaderType": "file"`):**
- **Contexts**: All `.md` files and files containing "context" in the name
- **Manifests**: All `.json` files containing "manifest" or "tool" in the name (excluding `serverConfig.json`)
- **Best for**: Development, version control of assets, simple deployments

**Sync-Based Loading (`"assetLoaderType": "sync"`):**
- **Hybrid Approach**: Local files automatically synced to Twilio Sync on startup
- **Runtime Management**: Contexts and manifests can be managed directly in Sync
- **Persistence**: Sync-managed content preserved between server restarts
- **Best for**: Production deployments, dynamic asset management, multi-environment setups

### Context Documents

Context documents are stored as **string content** in Sync Maps with unique keys:

**Context Structure:**
- **AI Assistant Persona** - Define the AI's role and personality
- **Conversation Guidelines** - Set tone, style, and behavior rules
- **Response Formatting** - Specify how responses should be structured
- **Process Instructions** - Detail specific conversation flows and steps
- **Domain Knowledge** - Include relevant business context and rules

**Key Sections to Configure:**
1. **Objective** - Define the AI's primary role and tasks
2. **Style Guardrails** - Set conversation tone and behavior boundaries
3. **Response Guidelines** - Specify formatting and delivery requirements
4. **Instructions** - Detail specific process steps and workflows

### Tools (v4.12: in-code registry)

Tools are defined in code under `server/src/tools/` using the `defineTool({ name, description, parameters, handler })` factory. The `defaultToolManifest.json` / `legs/*/toolManifest.json` files have been removed — schema (what OpenAI sees) and handler (what runs) are now co-located in each tool file. `buildDefaultRegistry(config, cache)` in `server/src/tools/index.ts` registers all tools once at startup, and the same `ToolRegistry` is handed to every `ConversationRelaySession`.

**Available Tools (9 total, all registered by default):**
1. `end-call` — Gracefully terminates the current call
2. `live-agent-handoff` — Transfers the call to a human agent
3. `send-dtmf` — Sends DTMF tones during the call
4. `send-sms` — Sends SMS messages during the call (factory: captures `ServerConfig`)
5. `switch-language` — Changes TTS and/or transcription languages
6. `play-media` — Plays audio media from URLs
7. `set-listen-mode` — Toggles outbound text/play/language suppression for listen-only mode
8. `set-silence-detection` — Enables/disables the silence reminder timer mid-call
9. `change-context` — Switches the LLM's system prompt mid-call (factory: captures `CachedAssetsService`)

**Adding a new tool:**
1. Create `server/src/tools/my-tool.ts` that exports a `defineTool({...})` record (or a factory returning one, if it needs DI).
2. Add one `.register(myTool)` line in `server/src/tools/index.ts`.

No JSON editing, no filename/manifest-name coupling. Type parameters on `defineTool<TArgs, TResult>` tie the handler's args type to the declared schema — a mismatch fails at compile time.

**Tool-result side-effect conventions:** handlers can return any combination of:
- `outgoingMessage: { type: 'end' | 'sendDigits' | 'play' | 'language' | 'text', ... }` — Zod-validated and shipped to Twilio (or deferred for terminal `end` frames).
- `listenMode: boolean` — toggles session listen-mode suppression.
- `silenceEnabled: boolean` — toggles session silence detection.
- Any other fields — passed back to the LLM as the function-call output.

### Language Switching Example

The system supports dynamic language switching during active calls using the `switch-language` tool. Users can request language changes naturally, and the system will immediately switch both text-to-speech and speech-to-text languages.

**Example Conversation Flow:**
```
User: "Can you switch to Australian English?"

System Processing:
[SwitchLanguage] Switch language function called with arguments: {
  "ttsLanguage": "en-AU",
  "transcriptionLanguage": "en-AU"
}

[Conversation Relay] Sending immediate message: {
  "type": "language",
  "ttsLanguage": "en-AU",
  "transcriptionLanguage": "en-AU"
}

AI Response: "No worries, I've switched to Australian English now.
Is there something specific you'd like to know about how the system works,
or do you want a general walk-through?"
```

**Supported Language Configurations:**
- **en-AU**: Australian English with ElevenLabs voice `IKne3meq5aSn9XLyUdCD`
- **en-US**: US English with ElevenLabs voice `tnSpp4vdxKPjI9w0GnoV`

**Technical Implementation:**
- Language switching uses Twilio's `SwitchLanguageMessage` WebSocket message type
- Changes are applied immediately without call interruption
- Both TTS (text-to-speech) and transcription languages are updated simultaneously
- System maintains conversation context across language switches

### Dynamic Context Loading

**Per-Call Configuration:**
```typescript
// WebSocket setup message with custom configuration
{
  "type": "setup",
  "customParameters": {
    "contextKey": "customerServiceContext"
  }
}
```

**Runtime Configuration Updates:**
```bash
# Swap the system prompt for an active call
curl -X POST '/updateResponseService' \
  --data '{
    "callSid": "CA1234...",
    "contextKey": "escalationContext"
  }'
```

> Note: `manifestKey` is accepted by `/updateResponseService` for backward compatibility but is ignored. Tools in v4.12 are registered once in code (all-tools-all-legs); the registry is not swapped mid-call.

### Quick Start Configuration Examples

**Initial Setup (Automatic):**
```bash
# 1. Start the server (automatically creates defaults)
npm run dev

# 2. Make a test call (uses defaultContext and defaultToolManifest automatically)
# No additional setup required!
```

**Adding a Custom Context:**

1. Drop a new `.md` file into `server/assets/` (or `server/assets/legs/`). Contexts are discovered at startup by the `FileAssetLoader`.
2. Either set it as the default by editing `serverConfig.json`'s `AssetLoader.activeContextKey`, or switch to it at runtime via `POST /updateResponseService` with `contextKey`.

**Configuration Examples by Use Case:**

**Context Keys:**
- `defaultContext` - General purpose conversation (shipped)
- `customerServiceContext` - Customer support scenarios
- `salesContext` - Sales and lead qualification
- `technicalSupportContext` - Technical troubleshooting

## Environment Configuration

### Environment-Specific Configuration (v4.9.8)

The server supports environment-specific `.env` files using NODE_ENV-based selection for clean separation between development and production configurations.

**Environment Files:**
- `.env.dev` - Development configuration (local development, ngrok URLs, dev API keys)
- `.env.prod` - Production configuration (production URLs, production credentials)
- `.env` - Fallback configuration (backward compatibility, CI/CD)

**Usage:**
```bash
# Development mode (uses .env.dev)
pnpm dev

# Production mode (uses .env.prod)
pnpm build
pnpm start:prod

# Fallback mode (uses .env)
pnpm start
```

**How It Works:**
- Development script sets `NODE_ENV=dev` → loads `.env.dev`
- Production script sets `NODE_ENV=prod` → loads `.env.prod`
- No NODE_ENV → falls back to `.env`

**Benefits:**
- No manual env file swapping between environments
- Clear separation of dev/prod configurations
- Reduced risk of using wrong credentials
- Validated environment variables on startup

### Environment Variables

Create environment files (`.env.dev`, `.env.prod`, or `.env`) in the server directory with the following variables:

```bash
# Server Configuration
PORT=3007                                    # Server port number
SERVER_BASE_URL=your_server_url              # Base URL for your server (e.g., ngrok URL)

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key          # OpenAI API key for GPT integration
OPENAI_MODEL=gpt-4o                         # OpenAI model to use for conversations

# Twilio Configuration (required for Sync Maps and voice services)
ACCOUNT_SID=your_twilio_account_sid         # Twilio Account SID for Sync and voice operations
AUTH_TOKEN=your_twilio_auth_token           # Twilio Auth Token for authentication
API_KEY=your_twilio_api_key                 # Twilio API Key for enhanced authentication
API_SECRET=your_twilio_api_secret           # Twilio API Secret for enhanced authentication
FROM_NUMBER=your_twilio_phone_number        # Twilio phone number for calls/SMS
```

**Validation:**
The server validates all required environment variables on startup:
- `PORT`, `SERVER_BASE_URL`, `OPENAI_API_KEY`
- `ACCOUNT_SID`, `AUTH_TOKEN`, `FROM_NUMBER`

If any required variables are missing, the server will fail fast with a clear error message listing all missing variables.

### Required Twilio Services

The system requires the following Twilio services to be enabled in your account:
- **Voice** - For handling phone calls and conversation relay
- **Sync** - For storing and retrieving configuration data (context documents and tool manifests)
- **SMS** (optional) - For send-sms tool functionality

## Asset Loading System (v4.6.0)

The system now supports **flexible asset loading** with two distinct approaches to manage contexts, manifests, and configuration. Choose the approach that best fits your deployment scenario.

### 🔧 Asset Loading Options

**Configure in `server/assets/serverConfig.json`:**
```json
{
  "AssetLoader": {
    "assetLoaderType": "file",  // or "sync"
    "context": "defaultContext",
    "manifest": "defaultToolManifest"
  }
}
```

### 📁 Option 1: File-Based Loading (Recommended for Development)

**Perfect for**: Development, testing, simple deployments, getting started

**Setup Steps:**
1. Set `"assetLoaderType": "file"` in `serverConfig.json`
2. Place your asset files in `server/assets/`
3. Start the server - no external dependencies required!

**Required Files:**
- `server/assets/serverConfig.json` - Main configuration
- `server/assets/defaultContext.md` - Conversation context
- `server/assets/defaultToolManifest.json` - Tool definitions

**Benefits:**
- ✅ No Twilio Sync required
- ✅ Perfect for development and testing
- ✅ Simple deployment
- ✅ Version control friendly
- ✅ No external dependencies

### ☁️ Option 2: Sync-Based Loading (Recommended for Production)

**Perfect for**: Production deployments, centralized configuration, multiple servers

**Setup Steps:**
1. Set `"assetLoaderType": "sync"` in `serverConfig.json`
2. Configure Twilio credentials in `.env`
3. Start the server - Sync infrastructure is created automatically!

**Automatic Setup Process:**
1. **Service Creation**: Creates ConversationRelay Sync service automatically
2. **Map Creation**: Creates Contexts, Manifests, Configuration, Languages maps
3. **Document Creation**: Creates ServerConfig document
4. **Asset Population**: Loads initial data from `serverConfig.json`

**Benefits:**
- ✅ Centralized configuration management
- ✅ Real-time updates without server restart
- ✅ Multi-server deployments
- ✅ Automatic infrastructure creation
- ✅ Cloud-based persistence

### 🔄 How Asset Loading Works

**File-Based Loading:**
1. **Direct File Access**: Reads assets directly from `server/assets/` folder
2. **In-Memory Caching**: Loads into CachedAssetsService for high performance
3. **Session Independence**: Each conversation gets independent asset copies

**Sync-Based Loading:**
1. **Sync API Access**: Retrieves assets from Twilio Sync services/maps/documents
2. **Automatic Infrastructure**: Creates missing Sync resources on startup
3. **In-Memory Caching**: Caches in CachedAssetsService for performance
4. **Dynamic Updates**: Changes in Sync are available immediately

### Configuration Keys

**Default Keys:**
- `defaultContext` - Default conversation context document
- `defaultToolManifest` - Default tool definitions object

**Custom Keys:**
- Any custom key can be used to store and retrieve specialized configurations
- Keys are specified via `contextKey` and `manifestKey` parameters in WebSocket setup

### Dynamic Configuration Loading

**WebSocket Setup with Custom Keys:**
```json
{
  "type": "setup",
  "customParameters": {
    "contextKey": "customerServiceContext",
    "manifestKey": "customerServiceTools"
  }
}
```

**API-Based Configuration Updates:**
```bash
# Update context for active call
curl -X POST 'https://your-server/updateResponseService' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "callSid": "CA1234...",
    "contextKey": "newContext",
    "manifestKey": "newManifest"
  }'
```

### Sync Maps Structure

**Context Documents** (stored as strings):
- `defaultContext`: Default conversation context
- `customerServiceContext`: Customer service specific context
- `salesContext`: Sales conversation context

**Tool Manifests** (stored as objects):
- `defaultToolManifest`: Standard tool set
- `customerServiceTools`: Customer service specific tools
- `salesTools`: Sales specific tools

### Managing Additional Configurations

**🔧 Adding Custom Contexts and Manifests:** The system provides default configurations out-of-the-box, but you must add your own custom contexts and manifests directly to Twilio Sync to meet your specific business requirements.

#### Required Setup for Custom Configurations

**IMPORTANT**: The system includes only basic default files for demonstration. For production use, you must upload your own context documents and tool manifests to Twilio Sync Maps:

1. **Upload Your Custom Context**: Add your business-specific context documents to Sync
   ```bash
   curl -X POST 'https://your-server/api/sync/context' \
     --header 'Content-Type: application/json' \
     --data-raw '{"myBusinessContext": "Your custom context content here..."}'
   ```

2. **Upload Your Custom Manifest**: Add your custom tool configurations to Sync
   ```bash
   curl -X POST 'https://your-server/api/sync/toolmanifest' \
     --header 'Content-Type: application/json' \
     --data-raw '{"myBusinessTools": {"tools": [...]}}'
   ```

3. **Set as Active Configuration**: Configure the system to use your custom configurations
   ```bash
   curl -X POST 'https://your-server/api/sync/serverconfig' \
     --data-raw '{"AssetLoader": {"context": "myBusinessContext", "manifest": "myBusinessTools"}}'
   ```

4. **Verify Configuration**: Confirm your configurations are loaded
   ```bash
   curl 'https://your-server/api/sync/serverconfig'
   ```

#### Configuration Management Architecture

**📋 How Configuration Works:**
- **Default Files**: Basic `defaultContext.md` and `defaultToolManifest.json` included for initial setup only
- **Sync Maps Storage**: All configurations stored in Twilio Sync Maps for cloud access
- **In-Memory Caching**: CachedAssetsService provides high-performance access after startup
- **Direct Upload Required**: You must upload your own contexts/manifests to Sync for production use
- **Per-Call Override**: Individual calls can specify custom `contextKey`/`manifestKey` via WebSocket parameters
- **Runtime Updates**: Active calls can be updated using the `/updateResponseService` endpoint

### Benefits of Sync Maps Configuration

- **Cloud-Native**: Leverages Twilio's enterprise infrastructure
- **Real-Time Updates**: Configuration changes available immediately
- **Dynamic Loading**: Different configurations per call without restarts
- **Centralized Management**: Single source of truth across all instances
- **Key-Based Access**: Simple key lookup for configuration retrieval
- **Scalable Storage**: No local file dependencies or management overhead
- **Automatic Setup**: Default configurations loaded automatically from local files

## Asset Upload Utility

The system includes a convenient utility script for manually uploading asset files to Twilio Sync. This utility accepts any file path and provides a simple way to upload individual context documents and tool manifests without using the server's API endpoints.

### Usage

```bash
# From the server directory
node scripts/upload-assets.js <filepath>
```

### Supported File Types

- **`.md` files** → Uploaded to Context map (with content wrapper)
- **`.json` files** → Uploaded to ToolManifest map

### Examples

```bash
# Upload files using relative paths
node scripts/upload-assets.js ./assets/customerServiceContext.md
node scripts/upload-assets.js ./assets/customTools.json

# Upload files from current directory
node scripts/upload-assets.js myContext.md
node scripts/upload-assets.js myManifest.json

# Upload files using absolute paths
node scripts/upload-assets.js /path/to/specialContext.md
```

### How It Works

1. **File Path Resolution**: Accepts any file path (relative or absolute) and resolves it correctly
2. **File Validation**: Checks that the file exists at the specified path and has a supported extension
3. **JSON Parsing**: For `.json` files, validates JSON syntax before upload
4. **Automatic Naming**: Uses filename (without extension) as the Sync map key
5. **Update or Create**: Updates existing Sync map items or creates new ones
6. **Detailed Logging**: Provides clear feedback on upload success/failure

### Asset Naming Convention

The utility automatically derives the Sync map key from the filename:

- `customerServiceContext.md` → Context map key: `customerServiceContext`
- `customTools.json` → ToolManifest map key: `customTools`
- `specializedContext.md` → Context map key: `specializedContext`

### Prerequisites

- Twilio credentials must be configured in your `.env` file (`ACCOUNT_SID` and `AUTH_TOKEN`)
- Server must be built (`npm run build`) to generate compiled JavaScript files
- Asset files must exist at the specified file path

### Error Handling

The utility provides clear error messages for common issues:

- **Missing file**: `Error: File not found: /path/to/file`
- **Invalid extension**: `Error: Only .md and .json files are supported`
- **Invalid JSON**: `Error: Invalid JSON in filename.json`
- **Missing credentials**: `Error: Missing Twilio credentials`

This utility is perfect for:
- **Development workflow**: Quick asset synchronization during development
- **Configuration updates**: Push changes to existing custom assets
- **Custom deployments**: Upload your specialized contexts and manifests
- **Testing scenarios**: Easily upload different configurations for testing

**Note**: Default assets (`defaultContext.md`, `defaultToolManifest.json`) are automatically uploaded on server startup, so manual upload is only needed for custom assets.

## Silence Detection Configuration

Version 4.4.3 introduces a comprehensive silence detection configuration system that eliminates hardcoded values and provides maximum flexibility for customizing silence handling behavior.

### Configuration Structure

Silence detection is configured through the `ConversationRelay.SilenceDetection` object in `serverConfig.json`:

```json
{
  "ConversationRelay": {
    "SilenceDetection": {
      "enabled": false,
      "secondsThreshold": 20,
      "messages": [
        "Still there?",
        "Just checking you are still there?",
        "Hello? Are you still on the line?"
      ]
    }
  },
  "AssetLoader": {
    "context": "defaultContext",
    "manifest": "defaultToolManifest",
    "assetLoaderType": "file"
  }
}
```

### Configuration Properties

- **`enabled`** (boolean): Controls whether silence detection is active
  - `true`: Silence detection operates normally
  - `false`: No silence monitoring or timeout messages

- **`secondsThreshold`** (number): Seconds of silence before triggering response
  - Default: `20` seconds
  - Configurable based on conversation type and user expectations

- **`messages`** (array): Progressive reminder messages sent to user
  - Array-based progression: System iterates through messages in order
  - Flexible count: Add or remove messages without code changes
  - Call termination: When all messages are exhausted, the call ends gracefully

### How Silence Detection Works

1. **Silence Monitoring**: System tracks time since last meaningful message
2. **Message Progression**: When threshold exceeded, sends first message from array
3. **Escalation**: Subsequent silence periods trigger next messages in sequence
4. **Conversation Reset**: Valid user responses reset message index to beginning
5. **Call Termination**: After all messages exhausted, call ends with "unresponsive" reason

### Dynamic Silence Detection Control (v4.9.7)

Version 4.9.7 introduces runtime control of silence detection, allowing the LLM to enable or disable silence monitoring during active calls. This is particularly useful for scenarios where the caller may not speak for extended periods.

**Key Features:**
- **Runtime Control**: Enable/disable silence detection during active calls using the `set-silence-detection` tool
- **Flag-Based Design**: Timer continues running but checks an enabled flag before taking action
- **Tool-Driven Architecture**: Uses the existing outgoingMessage pattern for clean service communication
- **No Service Coupling**: Avoids dependency injection between services

**Common Use Cases:**
- **Payment Processing**: Disable silence detection while collecting card information via DTMF
- **Document Lookup**: Disable monitoring when caller is searching for documents or information
- **IVR Navigation**: Disable during automated phone tree navigation
- **Form Input**: Disable when caller is entering multiple pieces of information

**How It Works:**
1. **Continuous Timer**: The silence timer runs continuously throughout the call (checking every 1 second)
2. **Flag Check**: Before triggering any silence messages, the timer checks if silence detection is enabled
3. **Early Return**: If disabled (`enabled: false`), the timer returns immediately without taking action
4. **Tool Control**: The LLM can call `set-silence-detection` tool to dynamically toggle the enabled flag
5. **Service Communication**: Tool returns an `outgoingMessage` with type `setSilenceDetection` that routes through OpenAIResponseService to ConversationRelayService

**Technical Implementation:**
```typescript
// In SilenceHandler.ts - Timer checks enabled flag
setInterval(() => {
    if (!this.enabled) return; // Skip if disabled
    // ... normal silence detection logic
}, 1000);

// Tool response format
{
    success: true,
    message: "Silence detection enabled",
    outgoingMessage: {
        type: 'setSilenceDetection',
        enabled: true
    }
}

// ConversationRelayService routes the message
case "setSilenceDetection":
    if (this.silenceHandler) {
        this.silenceHandler.set(silenceMsg.enabled);
    }
    break;
```

**Using the set-silence-detection Tool:**
```json
{
  "type": "function",
  "name": "set-silence-detection",
  "description": "Enables or disables silence detection monitoring during the call. Use this to temporarily disable silence detection during activities where the caller may not speak for extended periods (e.g., entering payment information, looking up documents).",
  "parameters": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "description": "Set to true to enable silence detection, false to disable it"
      }
    },
    "required": ["enabled"]
  }
}
```

**Example Conversation Flow:**
```
AI: "I'll need your credit card number. Please enter it now."
[AI calls set-silence-detection tool with enabled: false]
[Caller enters digits via DTMF - no silence warnings triggered]
AI: "Thank you, I've received your card number. Now please enter the security code."
[Caller continues entering data without silence interruptions]
AI: "Perfect, your payment is processing."
[AI calls set-silence-detection tool with enabled: true]
[Silence detection resumes normal operation]
```

**Benefits:**
- **Better User Experience**: No interruptions during legitimate silence periods
- **Flexible Control**: LLM decides when silence detection is appropriate
- **Simple Implementation**: Flag-based design avoids complex timer management
- **Type-Safe**: Proper TypeScript interfaces throughout the message routing chain

### Configuration Examples

**Development/Testing Configuration:**
```json
"silenceDetection": {
  "enabled": true,
  "secondsThreshold": 5,
  "messages": ["Quick test - still there?"]
}
```

**Customer Service Configuration:**
```json
"silenceDetection": {
  "enabled": true,
  "secondsThreshold": 30,
  "messages": [
    "I'm sorry, I didn't catch that. Are you still there?",
    "Hello? Can you hear me?",
    "We seem to have lost connection. I'll end this call now."
  ]
}
```

**No Timeout Configuration:**
```json
"silenceDetection": {
  "enabled": false,
  "secondsThreshold": 20,
  "messages": []
}
```

### Benefits of Enhanced Configuration

- **No Code Changes**: Modify thresholds and messages through JSON configuration
- **A/B Testing**: Easy testing of different message strategies and timing
- **Environment-Specific**: Different configurations for development, staging, production
- **User Experience**: Customizable messaging tailored to specific use cases
- **Type Safety**: Full TypeScript support with compile-time validation

## Listen Mode Configuration

Version 4.5.0 introduces Listen Mode, a powerful feature that enables automated operations by suppressing text responses while maintaining full tool execution capability. This is particularly useful for automated tasks, IVR navigation, and background data collection.

### Configuration Structure

Listen mode is configured through the `Server.ListenMode` object in `serverConfig.json`:

```json
{
  "ConversationRelay": {
    "Configuration": {},
    "Languages": []
  },
  "AssetLoader": {
    "context": "defaultContext",
    "manifest": "defaultToolManifest",
    "assetLoaderType": "file"
  },
  "Server": {
    "ListenMode": {
      "enabled": true
    }
  }
}
```

### Configuration Properties

- **`enabled`** (boolean): Controls whether listen mode is active
  - `true`: Text responses are suppressed, only tool execution occurs
  - `false`: Normal text responses are generated (default behavior)

### How Listen Mode Works

1. **Silent Operation**: When enabled, the system processes audio transcription and executes tools but suppresses all text-to-speech responses
2. **Tool Execution Preserved**: All tool functionality remains fully operational (DTMF sending, SMS, call control, etc.)
3. **Audio Processing**: System continues to transcribe and process incoming audio normally
4. **Early Break Processing**: Efficient implementation using early break patterns to skip text response generation

### Dynamic Control

Listen mode can be controlled dynamically during active conversations using the `set-listen-mode` tool:

```json
{
  "type": "function",
  "name": "set-listen-mode",
  "description": "Enable/disable listen mode to control text response generation",
  "parameters": {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "description": "True for listen-only operation, false for normal responses"
      }
    },
    "required": ["enabled"]
  }
}
```

### Usage Examples

**Enable Listen Mode for Automated Operations:**
```javascript
// During a call, enable silent mode
toolCall('set-listen-mode', { enabled: true });
// System now operates silently, executing tools without speaking
```

**Disable Listen Mode for Interactive Conversation:**
```javascript
// Switch back to normal interactive mode
toolCall('set-listen-mode', { enabled: false });
// System resumes normal text responses
```

### Common Use Cases

#### Automated IVR Navigation
- **Silent Navigation**: Navigate phone tree systems without generating speech responses
- **DTMF Control**: Send touch-tone signals while remaining silent
- **Data Collection**: Document navigation paths and menu options
- **Terminal Detection**: Automatically detect and handle end conditions

#### Background Processing
- **Automated Testing**: Run conversation flow tests without audio output
- **Data Mining**: Collect information while operating silently
- **System Monitoring**: Monitor call flows without user-facing responses

#### Development and Testing
- **Debug Mode**: Test tool execution without generating responses
- **Performance Testing**: Measure tool execution performance without TTS overhead
- **Integration Testing**: Validate tool functionality in isolated mode

### Technical Implementation

Listen mode integrates seamlessly with the existing architecture:

- **CachedAssetsService**: Loads listen mode configuration from Sync Maps
- **OpenAIResponseService**: Implements early break pattern to skip text processing
- **Tool Integration**: All tools continue to function normally in listen mode
- **Runtime Control**: Dynamic switching through standard tool calling patterns

### Benefits

#### Performance
- **Reduced Processing**: Skip unnecessary text generation for automated tasks
- **Lower Bandwidth**: No text transmission when operating silently
- **Faster Execution**: Optimized processing flow for automated operations

#### Flexibility
- **Runtime Control**: Switch between silent and interactive modes during calls
- **Configuration Driven**: Control behavior through simple boolean configuration
- **Tool Preservation**: Maintain full tool functionality while suppressing responses

#### Developer Experience
- **Simple Configuration**: Single boolean parameter controls entire feature
- **Standard Integration**: Uses existing tool calling patterns for control
- **Type Safety**: Full TypeScript support with proper interface definitions

This listen mode system provides a comprehensive solution for automated operations while maintaining the full power and flexibility of the conversation relay system.

## Fly.io Deployment

To deploy the server to Fly.io:

1. Navigate to the server directory:
```bash
cd server
```

2. For new deployments, use the `--no-deploy` option:
```bash
fly launch --no-deploy
```

Take note of the server URL under app = 'XXXXXX' and update your .env file accordingly.

```
SERVER_BASE_URL=XXXXXX.fly.dev
```

3. Ensure your `fly.toml` file has the correct port configuration, aligned with your .env PORT variable:
```toml
[http]
  internal_port = 3007
```

4. Add the volume mount configuration:
```toml
[mounts]
  source = "assets"
  destination = "/assets"
```

5. Import your environment variables as secrets:
```bash
fly secrets import < .env
```

6. Deploy your application:
```bash
fly deploy
```

## Dependencies

### Server Dependencies
- express - Web application framework
- express-ws - WebSocket support for Express
- openai - OpenAI API client for GPT integration
- dotenv - Environment configuration
- winston - Logging framework
- uuid - Unique identifier generation

### Server Tools

The server includes several built-in tools for call management:

1. `end-call` - Gracefully terminates the current call
2. `live-agent-handoff` - Transfers the call to a human agent  
3. `send-dtmf` - Sends DTMF tones during the call
4. `send-sms` - Sends SMS messages during the call
5. `switch-language` - Changes TTS and/or transcription languages
6. `play-media` - Plays audio media from URLs

## Conversation Endpoint (Messaging/Chat)

The `/conversation` endpoint provides a simple HTTP POST interface for messaging and chat applications, enabling the same backend Response Service to be used for both voice (Conversation Relay) and text-based conversations.

**🎯 Key Features:**
- **Unified Architecture**: Same OpenAIResponseService powers both voice and text conversations
- **HTTP POST Interface**: Simple JSON request/response for messaging applications
- **Session Management**: Stateful conversations with automatic GUID-based session tracking
- **Shared Configuration**: Same context, manifest, and tools work across both channels
- **Multi-Turn Conversations**: Full conversation history maintained across requests

**✅ Benefits:**
- Build messaging applications without WebSocket complexity
- Test conversation flows using simple HTTP requests
- Deploy same AI logic to multiple communication channels (voice + text)
- Consistent AI behavior across voice calls and text conversations
- Same tool execution (send-sms, etc.) works in both voice and messaging contexts

```
POST /conversation
```

### Request Format

```typescript
interface ConversationRequest {
  sessionId?: string;      // [OPTIONAL] Session ID for continuing conversation
  message: string;         // [REQUIRED] Message to send to OpenAI
  role?: 'user' | 'system'; // [OPTIONAL] Message role (defaults to 'user')
}
```

### Response Format

```typescript
interface ConversationResponse {
  success: boolean;
  sessionId: string;       // Session ID for conversation continuity
  response: string;        // OpenAI's response text
  error?: string;          // Error message if request failed
}
```

### Example Usage

```bash
# First message (creates new session)
curl -X POST http://localhost:3000/conversation \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, I need help"}'

# Follow-up message (uses existing session)
curl -X POST http://localhost:3000/conversation \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Tell me more"
  }'
```

### Architecture

The `/conversation` endpoint shares the same underlying architecture as the `/conversation-relay` WebSocket endpoint:
- **OpenAIResponseService**: Same response generation and tool execution
- **CachedAssetsService**: Same context, manifest, and tool configurations
- **Session Independence**: Voice sessions (wsSessionsMap) and messaging sessions (conversationSessionMap) are independent

This unified architecture enables developers to build conversational AI applications that work seamlessly across voice and messaging channels using a single backend service.

### Twilio Function for SMS Integration

To handle incoming SMS messages and forward them to the `/conversation` endpoint, you can create a Twilio Function that acts as a bridge between Twilio's SMS service and your conversation relay server.

**📱 Key Features:**
- **Automatic SMS Routing**: Forwards incoming SMS to the conversation endpoint
- **Session Management**: Uses phone number as session ID for stateful conversations
- **Error Handling**: Graceful fallback messages if server is unavailable
- **Long Message Support**: Handles SMS responses over 1600 characters

#### Twilio Function Code

```javascript
exports.handler = async function(context, event, callback) {
  const twiml = new Twilio.twiml.MessagingResponse();

  try {
    // Extract SMS details
    const fromNumber = event.From;
    const messageBody = event.Body;

    // Use phone number as session ID for stateful conversations
    const sessionId = fromNumber.replace(/[^0-9]/g, ''); // Remove non-numeric chars

    // Your conversation relay server URL
    const serverUrl = context.SERVER_URL || 'https://your-server.com';
    const conversationEndpoint = `${serverUrl}/conversation`;

    // Prepare request payload
    const payload = {
      message: messageBody,
      sessionId: sessionId,
      role: 'user'
    };

    // Make request to conversation endpoint
    const response = await fetch(conversationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.success && data.response) {
      // Handle long messages by splitting into 1600 char segments
      const maxLength = 1600;
      const responseText = data.response;

      if (responseText.length > maxLength) {
        // Split into multiple messages
        for (let i = 0; i < responseText.length; i += maxLength) {
          twiml.message(responseText.substring(i, i + maxLength));
        }
      } else {
        twiml.message(responseText);
      }
    } else {
      twiml.message('Sorry, I encountered an error processing your message.');
    }

  } catch (error) {
    console.error('Error:', error);
    twiml.message('Sorry, I\'m temporarily unavailable. Please try again later.');
  }

  return callback(null, twiml);
};
```

#### Configuration Steps

1. **Create the Function:**
   - Navigate to Twilio Console → Functions & Assets → Services
   - Create a new Service (e.g., "SMS Conversation Handler")
   - Add a new Function with the code above
   - Set the Function path (e.g., `/sms-handler`)

2. **Add Environment Variables:**
   ```
   SERVER_URL = https://your-server.com
   ```
   Replace with your actual conversation relay server URL.

3. **Deploy the Function:**
   - Click "Deploy All" to make the Function live
   - Copy the Function URL (e.g., `https://your-service-1234.twil.io/sms-handler`)

4. **Configure Your SMS Phone Number:**
   - Go to Phone Numbers → Active Numbers
   - Select your phone number
   - Under "Messaging Configuration"
   - Set "A Message Comes In" to your Function URL
   - Method: HTTP POST

#### How It Works

1. **SMS Received**: User sends SMS to your Twilio phone number
2. **Function Triggered**: Twilio invokes your Function with SMS data
3. **Forward to Server**: Function sends message to `/conversation` endpoint
4. **Session Continuity**: Phone number is used as session ID to maintain conversation context
5. **AI Response**: Server generates response using OpenAI
6. **Reply via SMS**: Function sends AI response back to user via SMS

#### Benefits

- **Unified AI Logic**: Same conversation context and tools work across SMS and voice
- **Stateful Conversations**: Each phone number maintains its own conversation history
- **Automatic Message Splitting**: Long responses are automatically split into multiple SMS
- **Error Resilience**: Graceful handling of server errors with user-friendly messages

#### Testing

Send an SMS to your configured Twilio phone number:

```
User: Hello, what can you help me with?
AI: [Response from your conversation endpoint]

User: Tell me more
AI: [Contextual response based on conversation history]
```

The system maintains conversation context per phone number, enabling natural multi-turn conversations over SMS.

## Outbound Calling

The system supports initiating outbound calls via an API endpoint:

```
POST /outboundCall
```

### Request Format

All properties except `phoneNumber` are passed as Conversation Relay parameters and accessible via `message.customParameters` in the WebSocket session.

```typescript
interface RequestData {
  properties: {
    phoneNumber: string;      // [REQUIRED] Destination phone number in E.164 format (extracted for routing)
    [key: string]: any;       // [OPTIONAL] All other fields passed as Conversation Relay parameters
  }
}
```

**Common Parameters:**
- `callReference` - Unique reference to associate with the call
- `contextKey` - Select specific conversation context for this call
- `manifestKey` - Select specific tool manifest for this call
- Any custom fields - Available in WebSocket session via `message.customParameters`

### Example Usage

```bash
curl -X POST \
  'https://server-yourdomain.ngrok.dev/outboundCall' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "properties": {
      "phoneNumber": "+1234567890",
      "callReference": "abc123",
      "firstname": "Bob",
      "lastname": "Jones"
    }
  }'
```

---

# Architecture

## Service Architecture

The server uses dependency inversion for multi LLM operators and a clean dependency injection architecture with handler interfaces for service communication.

### Server Services

The server is organized into modular services:

1. **ConversationRelayService** - Manages the core conversation flow and WebSocket communication
2. **OpenAIResponseService** - Implements the ResponseService interface for OpenAI integration
3. **SilenceHandler** - Manages silence detection and response with configurable thresholds
4. **TwilioService** - Manages Twilio-specific functionality and call control operations

### TwilioService Usage Guidelines

The TwilioService follows a specific architectural pattern to maintain clean separation between service-level operations and self-contained LLM tools:

**Use TwilioService when:**
- Making complex API calls that use multiple Twilio services
- Implementation requires non-API level business logic
- Building server endpoints or internal service operations
- **NOT** creating an LLM tool (tools should be self-contained)

**Don't use TwilioService (use direct Twilio API) when:**
- Creating LLM tools in the `src/tools/` directory
- Tools should call the Twilio API directly for self-contained execution
- This ensures tools remain portable and don't depend on service layer coupling
- **Example**: `src/tools/send-sms.ts` uses direct `twilio.messages.create()` call instead of TwilioService

This architectural decision ensures LLM tools remain self-contained and portable, avoiding unnecessary service layer dependencies while complex business logic resides appropriately in the service layer.

### Handler Interfaces

**ResponseHandler** - Handles LLM service responses:
```typescript
export interface ResponseHandler {
    content(response: ContentResponse): void;
    toolResult(toolResult: ToolResultEvent): void;
    error(error: Error): void;
    callSid(callSid: string, responseMessage: any): void;
}
```

**ConversationRelayHandler** - Handles conversation relay events:
```typescript
export interface ConversationRelayHandler {
    outgoingMessage(message: OutgoingMessage): void;
    callSid(callSid: string, responseMessage: any): void;
    silence(message: OutgoingMessage): void;
}
```

### Service Setup

Services use unified handler creation methods:

```typescript
// Create service instances
const responseService = await OpenAIResponseService.create(contextFile, toolManifest);
const conversationRelay = new ConversationRelayService(responseService, sessionData);

// Set up response handler
const responseHandler = {
    content: (response) => { /* handle content */ },
    toolResult: (toolResult) => { /* handle tool results */ },
    error: (error) => { /* handle errors */ },
    callSid: (callSid, responseMessage) => { /* handle call events */ }
};
responseService.createResponseHandler(responseHandler);

// Set up conversation relay handler
const conversationRelayHandler = {
    outgoingMessage: (message) => ws.send(JSON.stringify(message)),
    callSid: (callSid, responseMessage) => { /* handle call events */ },
    silence: (silenceMessage) => ws.send(JSON.stringify(silenceMessage))
};
conversationRelay.createConversationRelayHandler(conversationRelayHandler);
```

### Handler Implementation

Services communicate through unified handler interfaces:

```typescript
// ResponseService using unified handler
this.responseHandler.content(response);
this.responseHandler.toolResult(toolResult);
this.responseHandler.error(error);
```

### Architecture Benefits

#### 🚀 Performance
- **Direct Function Calls**: Fast, direct handler invocation with minimal overhead
- **Optimized Memory Usage**: Lightweight handler objects
- **Low Latency**: Immediate function calls for responsive service communication

#### 🛡️ Type Safety & Developer Experience
- **Compile-Time Validation**: TypeScript enforces correct handler signatures
- **IntelliSense Support**: Full IDE autocompletion and documentation
- **Strong Type Contracts**: Clear, enforceable contracts between services

#### 🧪 Testing & Maintainability
- **Easy Mocking**: Simple function mocking for unit tests
- **Clear Dependencies**: Explicit handler dependencies make service relationships transparent
- **Better Debugging**: Direct call stacks make debugging straightforward

#### 🏗️ Clean Architecture
- **Single Responsibility**: Each handler focuses on one specific communication channel
- **Interface Segregation**: Services only implement handlers they actually need
- **Dependency Inversion**: Services depend on handler abstractions, not concrete implementations

### TypeScript Interface Enforcement

The system includes comprehensive TypeScript interfaces for all Twilio WebSocket message types:

#### Outgoing Message Types
- **`TextTokensMessage`**: For sending text to be converted to speech
- **`PlayMediaMessage`**: For playing audio from URLs
- **`SendDigitsMessage`**: For sending DTMF digits
- **`SwitchLanguageMessage`**: For changing TTS and transcription languages
- **`EndSessionMessage`**: For terminating conversation sessions

These are unified under the `OutgoingMessage` union type, ensuring compile-time validation:

```typescript
const textMessage: TextTokensMessage = {
    type: 'text',
    token: 'Hello, how can I help you?',
    last: true,
    interruptible: true
};

await conversationRelaySession.outgoingMessage(textMessage);
```

### Tool Type-Driven Architecture

The system implements a pure tool type-driven architecture using OutgoingMessage types for routing:

#### Tool Categories

1. **Generic LLM Tools** - Standard tools processed by OpenAI (e.g., `send-sms`)
2. **CRelay Tools with Immediate Delivery** - WebSocket tools sent immediately (e.g., `send-dtmf`)  
3. **CRelay Tools with Delayed Delivery** - Terminal tools sent after OpenAI response (e.g., `end-call`, `live-agent-handoff`)

#### Tool Response Patterns

**Generic LLM Tool (send-sms.ts):**
```typescript
export default async function (functionArguments: SendSMSFunctionArguments): Promise<SendSMSResponse> {
    // Tool logic here
    const result = await twilioService.sendSMS(args.to, args.message);
    
    // Return simple response for OpenAI to process
    return {
        success: true,
        message: `SMS sent successfully`,
        recipient: args.to
    };
}
```

**CRelay Tool with Immediate Delivery (send-dtmf.ts):**
```typescript
import { SendDigitsMessage } from '../interfaces/ConversationRelay.js';

export default function (functionArguments: SendDTMFFunctionArguments): SendDTMFResponse {
    return {
        success: true,
        message: `DTMF digits sent successfully`,
        digits: functionArguments.dtmfDigit,
        outgoingMessage: {
            type: "sendDigits",
            digits: functionArguments.dtmfDigit
        } as SendDigitsMessage
    };
}
```

**CRelay Tool with Delayed Delivery (end-call.ts):**
```typescript
import { EndSessionMessage } from '../interfaces/ConversationRelay.js';

export default function (functionArguments: EndCallFunctionArguments): EndCallResponse {
    return {
        success: true,
        message: `Call ended successfully`,
        summary: functionArguments.summary,
        outgoingMessage: {
            type: "end",
            handoffData: JSON.stringify({
                reasonCode: "end-call",
                reason: "Ending the call",
                conversationSummary: functionArguments.summary
            })
        } as EndSessionMessage
    };
}
```

#### Type-Driven Routing

ConversationRelayService routes based on `outgoingMessage.type`:
- **`sendDigits`, `play`, `language`** - Immediate WebSocket delivery
- **`end`** - Stored and sent after OpenAI response completion
- **`text`** or no outgoingMessage - Standard OpenAI processing

### Interrupt Handling

The ResponseService supports interrupting ongoing AI responses using a boolean flag approach for simplicity:

```typescript
interrupt(): void {
    this.isInterrupted = true;
}

private async processStream(stream: any): Promise<void> {
    for await (const event of stream) {
        if (this.isInterrupted) {
            break;  // Exit when interrupted
        }
        // Process events...
    }
}
```

