# Simple Conversation Relay

This project consists of two main components:
- A WebSocket server for handling conversation relay
- Twilio Serverless Functions for customer verification and tools

## Prerequisites

- Node.js v18
- pnpm
- ngrok
- Twilio CLI with Serverless plugin

## Project Structure

```
.
├── server/          # WebSocket server for conversation relay
│   └── .env        # Server environment variables
└── functions/       # Twilio Serverless Functions
    ├── .env        # Twilio credentials and phone numbers
    ├── assets/
    │   ├── context.md           # GPT conversation context
    │   └── toolManifest.json    # Available tools configuration
    └── functions/
        └── tools/               # Tool implementations
```

## Server Component

The server handles WebSocket connections and manages conversation relay functionality. It includes GPT service integration and communicates with Twilio Functions.

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
ngrok http --domain server-des.ngrok.dev 3001
```

## Twilio Functions Component

The functions component contains Twilio Serverless Functions for customer verification and various tools.

### Running the Functions

1. Navigate to the functions directory:
```bash
cd functions
```

2. Install dependencies:
```bash
pnpm install
```

3. Start the Twilio Serverless development environment:
```bash
twilio serverless:start
```

4. Expose the functions using ngrok:
```bash
ngrok http --domain functions-des.ngrok.dev 3000
```

## Twilio Configuration

### TwiML Bin Setup

1. Create a new TwiML Bin in your Twilio console
2. Add the following TwiML code:
```xml
<Response>
   <Connect>
      <ConversationRelay 
         url="wss://server-des.ngrok.dev/conversation-relay" 
         voice="en-AU-Neural2-A" 
         dtmfDetection="true" 
         interruptByDtmf="true" 
         debug="true"
      />
   </Connect>
</Response>
```
3. Configure your Twilio phone number to use this TwiML Bin for incoming voice calls

### WebSocket Connection Flow

1. When a call is received, Twilio initiates a WebSocket connection to `wss://server-des.ngrok.dev/conversation-relay`
2. The server receives a 'setup' message containing call details:
   - Caller's phone number (`from`)
   - Called number (`to`)
   - Call SID
   - Other call metadata

3. The server then:
   - Stores the call parameters for the session
   - Makes a request to the `get-customer` function with the caller's phone number
   - Receives customer details (including first name)
   - Uses this information to generate a personalized greeting
   - Initiates the verification process

4. The `get-customer` function:
   - Receives the caller's phone number
   - Looks up customer information
   - Returns customer details for personalization
   - Enables the conversation to proceed with verified customer context

## GPT Context Configuration

The server uses two key files to configure the GPT conversation context:

### context.md

Located in `functions/assets/context.md`, this file defines:
- The AI assistant's persona (Joules, an energy company phone operator)
- Conversation style guidelines
- Response formatting rules
- Authentication process steps
- Customer validation requirements

Key sections to configure:
1. Objective - Define the AI's role and primary tasks
2. Style Guardrails - Set conversation tone and behavior rules
3. Response Guidelines - Specify formatting and delivery rules
4. Instructions - Detail specific process steps
5. Validation - Define the customer verification workflow

### toolManifest.json

Located in `functions/assets/toolManifest.json`, this file defines the available tools for the GPT service:

1. `get-customer`
   - Retrieves customer details using caller's phone number
   - Required parameter: `from` (phone number)

2. `verify-code`
   - Verifies provided authentication code
   - Required parameters: `code` and `from`

3. `verify-send`
   - Sends verification code via SMS
   - Required parameter: `from`

4. `live-agent-handoff`
   - Transfers call to human agent
   - Required parameter: `callSid`

The server fetches both files during initialization to hydrate the GPT context and enable tool usage during conversations.

## Environment Configuration

The project requires two separate environment configuration files:

### Functions Environment Variables (functions/.env)

Create a `.env` file in the functions directory with the following variables:

```bash
# Twilio Account Credentials
ACCOUNT_SID=your_twilio_account_sid
AUTH_TOKEN=your_twilio_auth_token

# Phone Numbers Configuration
SMS_FROM_NUMBER=your_twilio_sms_number    # Number used to send verification codes
CALL_FROM_NUMBER=your_twilio_call_number  # Number used for outbound calls
```

These variables are used by the Twilio Functions for:
- Authentication with Twilio's API
- Sending SMS verification codes
- Making outbound calls

### Server Environment Variables (server/.env)

Create a `.env` file in the server directory with the following variables:

```bash
PORT=3001                                    # Server port number
TWILIO_FUNCTIONS_URL=your_functions_url      # URL to your deployed Twilio Functions
OPENAI_API_KEY=your_openai_api_key          # OpenAI API key for GPT integration
```

These variables are used by the server for:
- Configuring the server port
- Connecting to Twilio Functions
- Authenticating with OpenAI's API

## Dependencies

### Server Dependencies
- express
- express-ws
- openai
- dotenv

### Functions Dependencies
- twilio
- @twilio/runtime-handler