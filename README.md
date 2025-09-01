# Simple Conversation Relay

> ⚠️ **Maintenance Mode Notice**: This main repo which is based on the v3 branch will enter maintenance mode by the end of September 2025. For new projects, please use the [v4 branch](../../tree/v4.0) which includes the latest features, improved architecture, and ongoing development support. We will be switching the v4 branch into main from 1st October 2025.

-------------------------------------------------

This is a reference implementation aimed at introducing the key concepts of Conversation Relay. The key here is to ensure it is a workable environment that can be used to understand the basic concepts of Conversation Relay. It is intentionally simple and only the minimum has been done to ensure the understanding is focussed on the core concepts. As an overview here is how the project is put together:

## Release v3.3

This release enhances type safety and API alignment by migrating from custom streaming event interfaces to OpenAI's native typed streaming events. See the [CHANGELOG.md](./CHANGELOG.md) for detailed release history.

## Quick Tip
Configure your Conversation Relay parameters in server/src/services/TwilioService.ts

```typescript
      // Generate the Twiml we will need once the call is connected. Note, this could be done in two steps via the server, were we set a url: instead of twiml:, but this just seemed overly complicated.
      const response = new twilio.twiml.VoiceResponse();
      const connect = response.connect();
      const conversationRelay = connect.conversationRelay({
            url: `wss://${serverBaseUrl}/conversation-relay`,
            transcriptionProvider: "deepgram",
            speechModel: "nova-3-general",
            interruptible: "any",
            ttsProvider: "Elevenlabs",
            voice: "Charlie-flash_v2_5",
            dtmfDetection: true,
      } as any);

      conversationRelay.parameter({
            name: 'callReference',
            value: callReference
      });
```

## Prerequisites

- Node.js v18
- pnpm
- ngrok
- TypeScript

## Project Structure

```
.
├── server/                # WebSocket server for conversation relay
│   ├── .env.example      # Example environment configuration
│   ├── package.json      # Server dependencies and scripts
│   ├── tsconfig.json     # TypeScript configuration
│   ├── server.ts         # Main server implementation
│   ├── assets/           # Configuration assets
│   │   ├── defaultContext.md    # Default GPT conversation context
│   │   ├── defaultToolManifest.json # Default available tools configuration
│   │   ├── MyContext.md        # Specific context
│   │   └── MyToolManifest.json # Specific tools
│   ├── src/              # Source code directory
│   │   ├── server.ts     # Main server implementation
│   │   ├── services/     # Core service implementations
│   │   │   ├── ConversationRelayService.ts
│   │   │   ├── DeepSeekService.ts
│   │   │   ├── OpenAIService.ts
│   │   │   ├── ResponseService.ts
│   │   │   ├── SilenceHandler.ts
│   │   │   └── TwilioService.ts
│   │   ├── tools/        # Tool implementations
│   │   │   ├── end-call.ts
│   │   │   ├── live-agent-handoff.ts
│   │   │   ├── send-dtmf.ts
│   │   │   └── send-sms.ts
│   │   └── utils/        # Utility functions
│   │       └── logger.ts
```

## Server Component

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

4. Ensure the server is running on port 3001 (or configured port in `.env`).

5. Optionally, expose the server using ngrok:
```bash
ngrok http --domain server-yourdomain.ngrok.dev 3001
```

### How It Works

1. **Initialization**: Silence monitoring starts after the initial setup message, ensuring the system is ready for conversation.

2. **Message Tracking**:
   - The system tracks the time since the last meaningful message
   - Info-type messages are intentionally ignored to prevent false resets
   - Valid messages (prompt, interrupt, dtmf) reset both the timer and retry counter

3. **Response Sequence**:
   - After 5 seconds of silence: Sends a reminder message ("I'm sorry, I didn't catch that...")
   - Each reminder increments a retry counter
   - After 3 unsuccessful attempts: Ends the call with an "unresponsive" reason code

4. **Cleanup**: The system properly cleans up monitoring resources when the call ends or disconnects.

### Implementation Details

The silence handling is modular and follows separation of concerns:
- `SilenceHandler` class manages the logic independently
- Messages are passed back to the server via callbacks
- The server maintains control of WebSocket communication
- Thresholds are configurable through constants in server.ts

This design ensures reliable conversation flow while preventing indefinite silence periods, improving the overall user experience.

## Silence Handling

The system includes a robust silence detection mechanism to manage periods of inactivity during conversations. This functionality is implemented in the `SilenceHandler` class and operates based on two key thresholds:

- `SILENCE_SECONDS_THRESHOLD` (5 seconds): The duration of silence before triggering a reminder
- `SILENCE_RETRY_THRESHOLD` (3 attempts): Maximum number of reminders before ending the call

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

This endpoint will handle incoming calls and establish the WebSocket connection for conversation relay.

### WebSocket Connection Flow

1. When a call is received, Twilio initiates a WebSocket connection to `wss://server-yourdomain.ngrok.dev/conversation-relay`
2. The server receives a 'setup' message containing call details:
   - Caller's phone number (`from`)
   - Called number (`to`)
   - Call SID
   - Other call metadata
   - Custom parameters (including callReference)

3. The server then:
   - Stores the call parameters for the session in a wsSessionsMap
   - Retrieves any parameter data associated with the callReference
   - Initializes the ResponseService with the specified context and tool manifest files
   - Creates a ConversationRelayService instance with:
     - ResponseService for LLM interactions
     - Session data containing setup information and parameters
     - Silence handler for managing inactivity
   - Sets up event listeners for WebSocket communication
   - Begins processing incoming messages

4. Session Management:
   - Each WebSocket connection maintains its own isolated session
   - Sessions are stored in a wsSessionsMap keyed by Call SID
   - This enables multiple concurrent calls to be handled independently
   - Each session has its own ResponseService and ConversationRelayService instances

### Important Note on WebSocket Implementation

⚠️ **Warning**: When implementing async/await with WebSocket connections, be careful about where you place your await statements. Do not use await in the main WebSocket connection handler (app.ws part). Instead, ensure all async operations are handled within the message event handler (ws.on("message")). This is crucial because:

1. WebSocket connections are synchronous by nature
2. Using await in the main connection handler could cause you to miss messages
3. Example of correct implementation:

```typescript
// INCORRECT - Don't do this
app.ws('/conversation-relay', async (ws, req) => {
    await someAsyncOperation(); // This could cause missed messages
    ws.on('message', (msg) => {
        // Handle message
    });
});

// CORRECT - Do this instead
app.ws('/conversation-relay', (ws, req) => {
    ws.on('message', async (msg) => {
        await someAsyncOperation(); // Safe to use await here
        // Handle message
    });
});
```

## GPT Context Configuration

The server uses two key files to configure the GPT conversation context:

### context.md

Located in `server/assets/context.md`, this file defines:
- The AI assistant's persona
- Conversation style guidelines
- Response formatting rules
- Authentication process steps
- Customer validation requirements

Key sections to configure:
1. Objective - Define the AI's role and primary tasks
2. Style Guardrails - Set conversation tone and behavior rules
3. Response Guidelines - Specify formatting and delivery rules
4. Instructions - Detail specific process steps

### toolManifest.json

Located in `server/assets/toolManifest.json`, this file defines the tools available to the OpenAI service. The service implements a dynamic tool loading system where tools are loaded based on their names in the manifest. Each tool's filename in the `/tools` directory must exactly match its name in the manifest.

Available tools:

1. `end-call`
   - Gracefully terminates the current call
   - Used for normal call completion or error scenarios
   - Returns a "crelay" type response that bypasses LLM processing

2. `live-agent-handoff`
   - Transfers the call to a human agent
   - Required parameter: `callSid`
   - Returns a "crelay" type response that bypasses LLM processing

3. `send-dtmf`
   - Sends DTMF tones during the call
   - Useful for automated menu navigation
   - Returns a "crelay" type response that bypasses LLM processing

4. `send-sms`
   - Sends SMS messages during the call
   - Used for verification codes or follow-up information
   - Returns a "tool" type response for LLM processing or "error" type if sending fails

Each tool now uses the ToolEvent system to emit events and return simple responses for conversation context:

```typescript
// Tools receive a ToolEvent object for event emission
export default function (functionArguments: ToolArguments, toolEvent?: ToolEvent): ToolResponse {
    // Tool logic here
    
    if (toolEvent) {
        // Emit events for WebSocket transmission using the ToolEvent interface
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

The ResponseService creates ToolEvent objects that provide tools with controlled access to:
- **Event Emission**: `toolEvent.emit(eventType, data)` for sending events to ConversationRelayService
- **Logging**: `toolEvent.log(message)` for standard logging
- **Error Logging**: `toolEvent.logError(message)` for error reporting

The ResponseService loads these tools during initialization and makes them available for use in conversations through OpenAI's function calling feature.

## Environment Configuration

### Server Environment Variables (server/.env)

Create a `.env` file in the server directory with the following variables:

```bash
PORT=3001                                    # Server port number
SERVER_BASE_URL=your_server_url              # Base URL for your server (e.g., ngrok URL)
OPENAI_API_KEY=your_openai_api_key          # OpenAI API key for GPT integration
OPENAI_MODEL=gpt-4-1106-preview             # OpenAI model to use for conversations

# Dynamic Context Configuration
LLM_CONTEXT=MyContext.md                   # Specify which context file to use (defaults to defaultContext.md)
LLM_MANIFEST=MyToolManifest.json      # Specify which tool manifest to use (defaults to defaultToolManifest.json)
```

These variables are used by the server for:
- Configuring the server port
- Setting the server's base URL for Twilio integration
- Authenticating with OpenAI's API
- Specifying the OpenAI model for conversations
- Loading specific context and tool configurations

### Dynamic Context System

The system supports dynamic context loading through environment variables, allowing different conversation contexts and tool configurations based on your needs. This feature enables the system to adapt its behavior and capabilities for different use cases.

The dynamic context system is organized in the `server/assets` directory with multiple context and tool manifest files:

- `defaultContext.md` and `defaultToolManifest.json` - Used when no specific context is configured
- `MyContext.md` and `MyToolManifest.json` - Specialized context and tools for Bill of Quantities calls

To use a specific context:
1. Add the context and tool manifest files to the `server/assets` directory
2. Configure the environment variables in your `.env` file:
   ```bash
   LLM_CONTEXT=YourContext.md
   LLM_MANIFEST=YourToolManifest.json
   ```

If these variables are not set, the system defaults to:
- `defaultContext.md`
- `defaultToolManifest.json`

This approach allows you to:
- Support multiple use cases with different requirements
- Maintain separation of concerns between different contexts
- Easily add new contexts and tool sets
- Switch contexts by updating environment variables

## Fly.io Deployment

To deploy the server to Fly.io, follow these steps:

1. Navigate to the server directory:
```bash
cd server
```

2. For new deployments, use the `--no-deploy` option to create a new Fly.io app without deploying it immediately. This allows you to configure your app before the first deployment:
```bash
fly launch --no-deploy
```
Note: Make sure to update your `SERVER_BASE_URL` in the .env file to use your Fly.io app's hostname without the "https://" prefix.

3. Ensure your `fly.toml` file has the correct port configuration:
```toml
[http]
  internal_port = 3001  # Make sure this matches your application port
```

4. Add the volume mount configuration to your `fly.toml` file:
```toml
[mounts]
  source = "assets"
  destination = "/assets"
```

5. Import your environment variables as secrets:
```bash
fly secrets import < .env
```

6. Now deploy your application and check the logs to make sure it is up and running.
```bash
fly deploy
```

7. Verify your context and manifest files are in the mount by logging into the machine:
```bash
fly ssh console
cd assets
ls
```

This will show your context and manifest files in the mounted volume.

8. Finally, check that the server is reachable and up by going to the fly.io base directory set above for SERVER_BASE_URL in a browser. You should get "WebSocket Server Running" as a response.


## Dependencies

## Outbound Calling

The system supports initiating outbound calls via an API endpoint. This allows external systems to trigger calls that connect to the Conversation Relay service.

### API Endpoint

```
POST /outboundCall
```

#### Request Format

```typescript
interface RequestData {
  properties: {
    phoneNumber: string;      // [REQUIRED] Destination phone number in E.164 format
    callReference: string;    // [OPTIONAL] Unique reference to associate with the call
    firstname?: string;       // [OPTIONAL] Additional parameter data
    lastname?: string;        // [OPTIONAL] Additional parameter data
    [key: string]: any;       // Other optional parameters
  }
}
```

#### Example Usage

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

### Data Flow and Parameter Reference

The system uses a reference mechanism to maintain context and pass parameters throughout the call lifecycle:

1. **Initial Storage**: When the outbound call endpoint is hit, all provided parameter data is stored in a `parameterDataMap` using the reference as the key:
   ```typescript
   parameterDataMap.set(requestData.callReference, { requestData });
   ```

2. **Conversation Relay Parameter**: The reference is passed to the Conversation Relay service as a parameter:
   ```typescript
   conversationRelay.parameter({
     name: 'callReference',
     value: callReference
   });
   ```

3. **WebSocket Session**: When the Conversation Relay establishes the WebSocket connection:
   - The initial setup message contains the reference in customParameters
   - The server retrieves the stored parameter data using this reference
   - The parameter data is attached to the session for use throughout the call

This mechanism allows you to:
- Pass arbitrary parameters to the call session without size limitations
- Access all parameter data throughout the call lifecycle
- Maintain session-specific parameter storage

### Implementation Details

1. The endpoint stores the provided parameter data in a session map using the reference as the key
2. Initiates an outbound call via Twilio using the provided phone number
3. Connects the call to the Conversation Relay service once established
4. The callReference is passed as a parameter to the Conversation Relay, allowing access to the stored parameter data during the call

### Response

Success:
```json
{
  "success": true,
  "response": "CA1234..." // Twilio Call SID
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```

### Server Dependencies
- express - Web application framework
- express-ws - WebSocket support for Express
- openai - OpenAI API client for GPT integration
- dotenv - Environment configuration
- winston - Logging framework
- uuid - Unique identifier generation

### Server Tools

The server includes several built-in tools for call management, each implementing the new ToolEvent-based system:

1. `end-call`
   - Gracefully terminates the current call
   - Used for normal call completion or error scenarios
   - Uses `toolEvent.emit('crelay', endCallData)` to send termination events directly to WebSocket

2. `live-agent-handoff`
   - Transfers the call to a human agent
   - Handles escalation scenarios
   - Uses `toolEvent.emit('crelay', handoffData)` to send handoff events directly to WebSocket

3. `send-dtmf`
   - Sends DTMF tones during the call
   - Useful for automated menu navigation
   - Uses `toolEvent.emit('crelay', dtmfData)` to send DTMF events directly to WebSocket

4. `send-sms`
   - Sends SMS messages during the call
   - Used for verification codes or follow-up information
   - Returns a simple response for LLM conversation context
   - Uses standard logging through the ToolEvent interface

### Enhanced Tool Handling System

The system implements a sophisticated tool handling mechanism that categorizes tool responses by type to determine appropriate processing:

#### Tool Response Types

Tools now return a structured response with `toolType` and `toolData` properties:

```typescript
interface ToolResult {
  toolType: string;
  toolData: any;
}
```

The system supports four distinct tool types:

1. **tool** - Standard tools that return results to be consumed by the LLM:
   - Results are added to conversation history
   - LLM generates a response based on the tool result
   - Example: `send-sms` returns confirmation message

2. **crelay** - Conversation Relay specific tools:
   - Results are emitted directly to the WebSocket
   - Bypasses LLM processing
   - Used for direct control actions like `send-dtmf` and `end-call`
   - ConversationRelayService listens for these events and forwards them

3. **error** - Error handling responses:
   - Error messages are added to conversation history as system messages
   - LLM can acknowledge and respond to the error
   - Provides graceful error handling in conversations

4. **llm** - LLM controller responses (not currently implemented):
   - Would allow tools to modify LLM behavior
   - Reserved for future expansion

#### Implementation

The ResponseService processes tool results based on their type using the new Response API architecture:

```typescript
switch (toolResult.toolType) {
  case "tool":
    // Add function call to input messages
    this.inputMessages.push({
      type: 'function_call',
      id: currentToolCall.id,
      call_id: currentToolCall.call_id,
      name: currentToolCall.name,
      arguments: currentToolCall.arguments
    });

    // Add function result to input messages
    this.inputMessages.push({
      type: 'function_call_output',
      call_id: currentToolCall.call_id,
      output: JSON.stringify(toolResult.toolData)
    });

    // Create follow-up response with tool results
    const followUpStream = await this.openai.responses.create({
      model: this.model,
      input: this.inputMessages,
      tools: this.toolDefinitions.length > 0 ? this.toolDefinitions : undefined,
      previous_response_id: this.currentResponseId,
      stream: true,
      store: true
    });
    break;
  case "crelay":
    // Emit directly to ConversationRelayService
    this.emit('responseService.toolResult', toolResult);
    break;
  case "error":
    // Log error - API will handle the error context
    logError('ResponseService', `Tool error: ${toolResult.toolData}`);
    break;
}
```

The ConversationRelayService listens for tool results and processes them:

```typescript
this.responseService.on('responseService.toolResult', (toolResult: ToolResult) => {
  // Check if the tool result is for the conversation relay
  if (toolResult.toolType === "crelay") {
    // Send the tool result to the WebSocket server
    this.emit('conversationRelay.outgoingMessage', toolResult.toolData);
  }
});
```

This architecture enables:
- Clear separation between conversation flow and direct actions
- Proper handling of Conversation Relay specific commands
- Flexible error handling within the conversation
- Future extensibility for new tool types

### Server Services

The server is organized into modular services:

1. `ConversationRelayService`
   - Manages the core conversation flow
   - Handles WebSocket communication
   - Coordinates between different services

2. `OpenAIService`
   - Manages GPT integration
   - Handles prompt construction and response processing
   - Implements retry logic and error handling

3. `SilenceHandler`
   - Manages silence detection and response
   - Implements configurable thresholds
   - Handles conversation flow control

4. `twilioService`
   - Manages Twilio-specific functionality
   - Handles call control operations
   - Implements SMS and DTMF features

## Interrupt Handling: AbortController vs. Boolean Flag Approach

The ResponseService supports interrupting ongoing AI responses to enable natural conversation flow. This reference implementation uses a simple boolean flag approach (`this.isInterrupted`) for simplicity and ease of understanding. However, for production systems, an AbortController-based approach offers significant advantages.

### Current Implementation: Boolean Flag (`this.isInterrupted`)

The current implementation uses a simple boolean flag to manage interrupts:

```typescript
class ResponseService extends EventEmitter {
    protected isInterrupted: boolean;

    interrupt(): void {
        this.isInterrupted = true;
    }

    resetInterrupt(): void {
        this.isInterrupted = false;
    }

    private async processStream(stream: any): Promise<void> {
        for await (const event of stream) {
            if (this.isInterrupted) {
                break;  // Exit the loop when interrupted
            }
            // Process events...
        }
    }
}
```

**Advantages of Boolean Flag Approach:**
- **Simplicity**: Easy to understand and implement
- **Minimal Dependencies**: No additional APIs or concepts required
- **Educational Value**: Clear demonstration of interrupt logic
- **Low Overhead**: Minimal performance impact
- **Synchronous**: No async complications in interrupt handling

**Limitations of Boolean Flag Approach:**
- **Manual Management**: Requires explicit reset before each operation
- **No Native Integration**: Cannot integrate with native APIs that support AbortSignal
- **Resource Cleanup**: No automatic cleanup of related resources
- **Limited Scope**: Only works within the application's polling loop
- **Race Conditions**: Potential timing issues in concurrent scenarios

### Production Alternative: AbortController Approach

The AbortController approach provides a more robust and standards-compliant interrupt mechanism:

```typescript
class ResponseService extends EventEmitter {
    protected abortController: AbortController | null;

    interrupt(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    private async processStream(stream: any): Promise<void> {
        // Create new AbortController for this operation
        this.abortController = new AbortController();

        // Pass abort signal to OpenAI API
        const followUpStream = await this.openai.responses.create(
            completionParams,
            {
                signal: this.abortController.signal  // Native API integration
            }
        );

        // No manual checking required - API handles abortion internally
        for await (const event of followUpStream) {
            // Events automatically stop when aborted
            // Process events...
        }
    }
}
```

**Advantages of AbortController Approach:**
- **Native API Integration**: Directly supported by fetch(), OpenAI client, and other modern APIs
- **Automatic Resource Cleanup**: APIs handle cleanup when signal is aborted
- **Standards Compliant**: Web standard supported across browsers and Node.js
- **Better Performance**: No manual polling required - APIs check signal internally
- **Immediate Cancellation**: Operations can stop immediately rather than waiting for next loop iteration
- **Built-in Race Condition Protection**: AbortSignal state is managed atomically
- **Event-Based**: Can listen for abort events for custom cleanup logic

**Implementation Differences:**

| Aspect | Boolean Flag | AbortController |
|--------|-------------|-----------------|
| **API Integration** | Manual checking in loops | Native support in fetch/HTTP APIs |
| **Resource Cleanup** | Manual cleanup required | Automatic when signal aborted |
| **Performance** | Polling overhead | Event-driven, no polling |
| **Timing** | Checked at loop iterations | Immediate cancellation possible |
| **Standards** | Custom implementation | Web/Node.js standard |
| **Error Handling** | Manual error states | Built-in AbortError handling |

### Performance Considerations

**Boolean Flag:**
- Minimal CPU overhead for simple boolean checks
- Requires polling on each iteration of processing loops
- Cannot interrupt long-running operations between checks
- Memory usage: single boolean per service instance

**AbortController:**
- Higher initial overhead (object creation, event system)
- More efficient for long-running operations (no polling)
- Can interrupt operations immediately when APIs support it
- Memory usage: AbortController object + potential listeners

### Production Recommendations

**Use Boolean Flag When:**
- Building educational/reference implementations
- System simplicity is the primary goal
- Working with APIs that don't support AbortSignal
- Performance overhead of AbortController is a concern
- Team is unfamiliar with AbortController concepts

**Use AbortController When:**
- Building production systems with reliability requirements
- Integrating with modern APIs that support AbortSignal
- Need immediate cancellation of network operations
- Want standards-compliant interrupt handling
- Require automatic resource cleanup
- Building systems that may scale to handle many concurrent operations

### Migration Path

To upgrade from the boolean flag to AbortController approach:

1. **Replace boolean flag with AbortController:**
   ```typescript
   // Replace: protected isInterrupted: boolean;
   protected abortController: AbortController | null;
   ```

2. **Update interrupt method:**
   ```typescript
   interrupt(): void {
       if (this.abortController) {
           this.abortController.abort();
       }
   }
   ```

3. **Remove manual reset calls:**
   ```typescript
   // Remove: this.resetInterrupt();
   // AbortController creates new instance for each operation
   ```

4. **Add signal to API calls:**
   ```typescript
   const stream = await this.openai.responses.create(params, {
       signal: this.abortController.signal
   });
   ```

5. **Remove manual interrupt checks:**
   ```typescript
   // Remove: if (this.isInterrupted) break;
   // API handles interruption automatically
   ```

### Conclusion

This reference implementation uses the boolean flag approach to maintain simplicity and educational clarity. The concept of interrupting AI responses is more important than the specific implementation mechanism. For production systems requiring robust interrupt handling, consider migrating to the AbortController approach to leverage native API support, automatic resource cleanup, and improved performance characteristics.
