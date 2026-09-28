/**
 * buildDefaultRegistry — called once at server startup to produce the
 * ToolRegistry that every OpenAIResponseService will share. Registers
 * all 9 tools defined under `server/src/tools/`, with Phase 1 IoC factory
 * invocation for the two tools that require dependencies (`send-sms`,
 * `change-context`).
 */

import type { ServerConfig } from '../config/ServerConfig.js';
import type { ContextSource } from '../services/ContextStore.js';
import { ToolRegistry } from './tool-registry.js';
import { endCallTool } from './cr/end-call.js';
import { liveAgentHandoffTool } from './cr/live-agent-handoff.js';
import { sendDtmfTool } from './cr/send-dtmf.js';
import { playMediaTool } from './cr/play-media.js';
import { switchLanguageTool } from './cr/switch-language.js';
import { setListenModeTool } from './cr/set-listen-mode.js';
import { setSilenceDetectionTool } from './cr/set-silence-detection.js';
import { createSendSMSTool } from './llm/send-sms.js';
import { createChangeContextTool } from './llm/change-context.js';

export function buildDefaultRegistry(
    config: ServerConfig,
    contexts: ContextSource
): ToolRegistry {
    return new ToolRegistry()
        .register(endCallTool)
        .register(liveAgentHandoffTool)
        .register(sendDtmfTool)
        .register(playMediaTool)
        .register(switchLanguageTool)
        .register(setListenModeTool)
        .register(setSilenceDetectionTool)
        .register(createSendSMSTool(config))
        .register(createChangeContextTool(contexts));
}

export { ToolRegistry } from './tool-registry.js';
export { defineTool } from './define-tool.js';
export type {
    ConversationRelayTool,
    ToolParameters,
    ToolResult,
    ToolHandler,
    ToolContext,
} from './define-tool.js';
