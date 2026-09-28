/**
 * defineTool — factory for CR tool definitions.
 *
 * A tool is an immutable record containing its LLM-facing schema (name,
 * description, parameters) and its handler function. Replaces the split
 * between `defaultToolManifest.json` (schema) and `server/src/tools/*.ts`
 * (handler) that existed in v4.11.
 *
 * The returned object is frozen so per-call state can't accidentally land on
 * the tool itself — per-call state lives in the `ToolContext` the handler
 * receives as its second arg, provided by the ResponseService.
 *
 * Based on the `defineTool` pattern from twilio-innovation/twilio-agent-
 * connect-typescript PR #54.
 */

/**
 * JSON-schema-lite shape for parameter declarations. Matches OpenAI's
 * function-calling parameter format.
 */
export interface ToolParameters {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}

/**
 * Optional side-effect fields a tool handler can return. The session's
 * tool-result router reads these and applies state changes / ships frames.
 *
 * - `outgoingMessage`: a validated outgoing CR frame, shipped on the wire
 *   immediately (or deferred to post-farewell for `end` frames).
 * - `listenMode`: toggle suppress-outgoing-text-and-media state.
 * - `silenceEnabled`: toggle silence-reminder timer.
 *
 * Any additional fields on the result are preserved and passed back to the
 * LLM as the function-call output. This is how you return normal data to the
 * conversation (e.g. a lookup result).
 */
export interface ToolResultBase {
    success: boolean;
    message: string;
    outgoingMessage?: unknown;
    listenMode?: boolean;
    silenceEnabled?: boolean;
}

export type ToolResult = ToolResultBase & Record<string, unknown>;

/**
 * What a tool may touch of the conversation it runs in. Provided by the
 * ResponseService, never the transport: tools affect the call only through
 * the fields they return (`outgoingMessage`, `listenMode`, `silenceEnabled`).
 */
export interface ToolContext {
    /** Replace the system prompt, keeping a summary so the model has continuity. */
    changeContext(context: string, handoffSummary: string): Promise<void>;
}

/**
 * Handler signature: receives parsed args and the conversation's ToolContext.
 * Closures over singletons (config, caches) are fine and expected.
 */
export type ToolHandler<TArgs = unknown, TResult extends ToolResult = ToolResult> = (
    args: TArgs,
    ctx: ToolContext
) => Promise<TResult> | TResult;

export interface ConversationRelayTool<
    TArgs = unknown,
    TResult extends ToolResult = ToolResult,
> {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolParameters;
    readonly strict: boolean;
    readonly handler: ToolHandler<TArgs, TResult>;
    /** Emit the OpenAI function-calling entry for this tool. */
    toOpenAIFormat(): {
        type: 'function';
        name: string;
        description: string;
        parameters: ToolParameters;
        strict: boolean;
    };
}

export interface DefineToolOptions<TArgs, TResult extends ToolResult> {
    name: string;
    description: string;
    parameters: ToolParameters;
    /** Strict-mode JSON schema enforcement on the LLM side. Defaults to `false`. */
    strict?: boolean;
    handler: ToolHandler<TArgs, TResult>;
}

export function defineTool<TArgs = unknown, TResult extends ToolResult = ToolResult>(
    options: DefineToolOptions<TArgs, TResult>
): ConversationRelayTool<TArgs, TResult> {
    const { name, description, parameters, handler } = options;
    const strict = options.strict ?? false;

    const tool: ConversationRelayTool<TArgs, TResult> = {
        name,
        description,
        parameters,
        strict,
        handler,
        toOpenAIFormat() {
            return { type: 'function', name, description, parameters, strict };
        },
    };

    return Object.freeze(tool);
}
