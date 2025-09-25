# Changelog

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
