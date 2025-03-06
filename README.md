# Simple Conversation Relay

This is a reference implementation aimed at introducing the key concepts of Conversation Relay. The key here is to ensure it is a workable environment that can be used to understand the basic concepts of Conversation Relay. IT is intentionally simple and only the minimum has been done to ensure the understanding is focussed on the core concepts. As an overview here is how the project is put together:

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


1. There is a main Server that has two functions:
   - It is a WebSocket server - The Websocket server maintains a connection and relays messages between the two parties. It is the core of the conversation relay system.
   - It is a API endpoint - The endpoints are used to execute code for various components, such as connecting Conversation Relay for example.
2. There is a Services collection that ensures we isolate the functionality of Conversation Relay, OpenAI and Twilio for example. The intention is to ensure we have no knowledge "bleed" between the different components.
   **_Conversation Relay_** - This is the core of the conversation relay system. The key part is understanding the different message types, specifically "setup" and "prompt". Event handling is key, since only this service can understand when to send which messages back to the websocket and back to Twilio. An example is "sendDigits" where this service will only emit the event when it directly needs to send this back via the websocket, otherwise it lets the LLM handle it.

   **_OpenAI Service_** - This service is used to interact with the OpenAI API. It is a typical LLM implementation where it sends a prompt and receives a response, along with tools to manage the conversation flow. Some of the tools are query style like send-sms, while others are Conversation Relay specific like send-dtmf, where websocket messages also have to be sent directly. This implementation illustrates both types. A third type not explored would be queries to external websites or APIs, but it would function in a similar way to send-sms in that there are no Conversation Relay specific messages to send back.

   **_Silence Handler_** - This is a utility method to break deadlocks. It is a simple implementation that sends a message after a certain amount of time, and if there is no response after a certain number of messages, it will end the call. This is a simple implementation and can be expanded to include more complex logic.

   **_Twilio Service_** - This service is used to interact with the Twilio API. It abstracts the Twilio API and can be built on to add any Twilio related services, including Conversation Relay itself via the "connectConversationRelay" endpoint. This is where Conversation Relay is configured using the NodeJS helper library. Note, you need at least twilio 5.4.3 library to do so. This is done instead of the usual Twiml config.

   **_Tools_** - The Tools section contains tool definitions that are used by the OpenAI service. The tools are loaded dynamically based on the toolManifest.json file, so ensure these are aligned. This is a simple implementation and can be expanded to include more complex tools and as mentioned there are Conversation Relay specific tools like send-dtmf and generic tools like send-sms included.

## Quick Tip
Configure your Conversation Relay parameters in server/services/twilioService.js

```javascript
      // Generate the Twiml we will need once the call is connected. Note, this could be done in two steps via the server, were we set a url: instead of twiml:, but this just seemed overly complicated.
      const response = new twilio.twiml.VoiceResponse();
      const connect = response.connect();
      const conversationRelay = connect.conversationRelay({
            url: `wss://${serverBaseUrl}/conversation-relay`,
            transcriptionProvider: "deepgram",
            voice: "en-AU-Journey-D",
            ttsProvider: "Elevenlabs",
            voice: "Jessica-flash_v2_5",
            dtmfDetection: "true",
            interruptByDtmf: "true",
      });

      conversationRelay.parameter({
            name: 'callReference',
            value: callReference
      });
```

## Prerequisites

- Node.js v18
- pnpm
- ngrok

## Project Structure

```
.
├── server/                # WebSocket server for conversation relay
│   ├── .env.example      # Example environment configuration
│   ├── package.json      # Server dependencies and scripts
│   ├── server.js         # Main server implementation
│   ├── assets/           # Configuration assets
│   │   ├── defaultContext.md    # Default GPT conversation context
│   │   ├── defaultToolManifest.json # Default available tools configuration
│   │   ├── MyContext.md        # Specific context
│   │   └── MyToolManifest.json # Specific tools
│   ├── services/         # Core service implementations
│   │   ├── ConversationRelayService.js
│   │   ├── OpenAIService.js
│   │   ├── DeepSeekService.js
│   │   ├── ResponseService.js
│   │   ├── SilenceHandler.js
│   │   └── TwilioService.js
│   ├── tools/           # Tool implementations
│   │   ├── end-call.js
│   │   ├── live-agent-handoff.js
│   │   ├── send-dtmf.js
│   │   └── send-sms.js
│   └── utils/           # Utility functions
│       └── logger.js
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
pnpm install
```

3. Start the development server:
```bash
pnpm dev
```

4. Expose the server using ngrok:
```bash
ngrok http --domain server-yourdomain.ngrok.dev 3001
```

## Silence Handling

The system includes a robust silence detection mechanism to manage periods of inactivity during conversations. This functionality is implemented in the `SilenceHandler` class and operates based on two key thresholds:

- `SILENCE_SECONDS_THRESHOLD` (5 seconds): The duration of silence before triggering a reminder
- `SILENCE_RETRY_THRESHOLD` (3 attempts): Maximum number of reminders before ending the call

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
- Thresholds are configurable through constants in server.js

This design ensures reliable conversation flow while preventing indefinite silence periods, improving the overall user experience.

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

3. The server then:
   - Stores the call parameters for the session
   - Initializes the ConversationRelayService with:
     - OpenAI service for natural language processing
     - Silence handler for managing inactivity
   - Sets up event listeners for WebSocket communication
   - Begins processing incoming messages

### Important Note on WebSocket Implementation

⚠️ **Warning**: When implementing async/await with WebSocket connections, be careful about where you place your await statements. Do not use await in the main WebSocket connection handler (app.ws part). Instead, ensure all async operations are handled within the message event handler (ws.on("message")). This is crucial because:

1. WebSocket connections are synchronous by nature
2. Using await in the main connection handler could cause you to miss messages
3. Example of correct implementation:

```javascript
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

2. `live-agent-handoff`
   - Transfers the call to a human agent
   - Required parameter: `callSid`

3. `send-dtmf`
   - Sends DTMF tones during the call
   - Useful for automated menu navigation

4. `send-sms`
   - Sends SMS messages during the call
   - Used for verification codes or follow-up information

The OpenAI service loads these tools during initialization and makes them available for use in conversations through OpenAI's function calling feature.

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

2. For new deployments, use the `fly launch` command:
```bash
fly launch
```

3. Import your environment variables as secrets:
```bash
fly secrets import < .env
```
Note: Make sure to update your `SERVER_BASE_URL` in the .env file to use your Fly.io app's hostname without the "https://" prefix.

4. Ensure your `fly.toml` file has the correct port configuration:
```toml
[http]
  internal_port = 3001  # Make sure this matches your application port
```

5. Create a static volume to store your assets. This ensures your context and manifest files persist across deployments:
```bash
fly volume create assets -r lax -n=1
```

6. Add the volume mount configuration to your `fly.toml` file:
```toml
[mounts]
  source = "assets"
  destination = "/assets"
```

7. Deploy your application:
```bash
fly deploy
```

8. Verify your context and manifest files are in the mount by logging into the machine:
```bash
fly ssh console
cd /assets
ls
```

This will show your context and manifest files in the mounted volume.

## Dependencies

## Outbound Calling

The system supports initiating outbound calls via an API endpoint. This allows external systems to trigger calls that connect to the Conversation Relay service.

### API Endpoint

```
POST /outboundCall
```

#### Request Format

```json
{
  "properties": {
    "phoneNumber": "+1234567890",      // [REQUIRED] Destination phone number in E.164 format
    "callReference": "abc123",      // [OPTIONAL] Unique reference to associate with the call
    "firstname": "Bob",                 // [OPTIONAL] Additional parameter data
    "lastname": "Jones"                 // [OPTIONAL] Additional parameter data
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
   ```javascript
   parameterDataMap.set(requestData.callReference, { requestData });
   ```

2. **Conversation Relay Parameter**: The reference is passed to the Conversation Relay service as a parameter:
   ```javascript
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

The server includes several built-in tools for call management:

1. `end-call`
   - Gracefully terminates the current call
   - Used for normal call completion or error scenarios

2. `live-agent-handoff`
   - Transfers the call to a human agent
   - Handles escalation scenarios

3. `send-dtmf`
   - Sends DTMF tones during the call
   - Useful for automated menu navigation

4. `send-sms`
   - Sends SMS messages during the call
   - Used for verification codes or follow-up information

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
