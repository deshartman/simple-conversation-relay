/**
 * buildDefaultRegistry — called once at server startup to produce the
 * ToolRegistry that every ConversationRelaySession will share. Registers
 * all 9 tools defined under `server/src/tools/`, with Phase 1 IoC factory
 * invocation for the two tools that require dependencies (`send-sms`,
 * `change-context`).
 */

import type { ServerConfig } from '../config/ServerConfig.js';
import type { CachedAssetsService } from '../services/CachedAssetsService.js';
import { ToolRegistry } from './tool-registry.js';
import { endCallTool } from './end-call.js';
import { liveAgentHandoffTool } from './live-agent-handoff.js';
import { sendDtmfTool } from './send-dtmf.js';
import { playMediaTool } from './play-media.js';
import { switchLanguageTool } from './switch-language.js';
import { setListenModeTool } from './set-listen-mode.js';
import { setSilenceDetectionTool } from './set-silence-detection.js';
import { createSendSMSTool } from './send-sms.js';
import { createChangeContextTool } from './change-context.js';

export function buildDefaultRegistry(
    config: ServerConfig,
    cache: CachedAssetsService
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
        .register(createChangeContextTool(cache));
}

export { ToolRegistry } from './tool-registry.js';
export { defineTool } from './define-tool.js';
export type {
    ConversationRelayTool,
    ToolParameters,
    ToolResult,
    ToolHandler,
} from './define-tool.js';
