/**
 * ToolRegistry — in-memory map of registered CR tools.
 *
 * Built once at server startup by `buildDefaultRegistry` and passed by
 * reference into every `ConversationRelaySession` and `OpenAIResponseService`.
 * Safe to share across concurrent sessions because tool records are frozen
 * and handlers are stateless (per-call state lives on the session).
 */

import type { ConversationRelayTool, ToolResult } from './define-tool.js';

export class ToolRegistry {
    private readonly tools: Map<string, ConversationRelayTool<unknown, ToolResult>> = new Map();

    /**
     * Register a tool. Chainable. Throws if a tool with the same name is
     * already registered — duplicate names would be a startup-time bug.
     */
    register<TArgs, TResult extends ToolResult>(
        tool: ConversationRelayTool<TArgs, TResult>
    ): this {
        if (this.tools.has(tool.name)) {
            throw new Error(`ToolRegistry: tool '${tool.name}' already registered`);
        }
        // Cast to the generic-erased internal shape. Safe because the
        // registry only dispatches by name; handlers validate their own args
        // at call-time via JSON.parse from OpenAI.
        this.tools.set(tool.name, tool as ConversationRelayTool<unknown, ToolResult>);
        return this;
    }

    get(name: string): ConversationRelayTool<unknown, ToolResult> | undefined {
        return this.tools.get(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    list(): ConversationRelayTool<unknown, ToolResult>[] {
        return Array.from(this.tools.values());
    }

    size(): number {
        return this.tools.size;
    }

    /** Emit the OpenAI `tools` array for a `responses.create()` call. */
    listForOpenAI(): ReturnType<ConversationRelayTool['toOpenAIFormat']>[] {
        return this.list().map(t => t.toOpenAIFormat());
    }
}
