import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AssistantDefinition } from "../../types/Assistant";
import { GptService } from "./openai-service";
import { DeepSeekService } from "./deep-seek";
import { GroqService } from "./groq-service";
import { ConversationTurn } from "../../types/ConversationTurn";
import EventEmitter from "events";

export interface ILargeLanguageModelService extends EventEmitter {
  call_sid: string;
  userContext: ConversationTurn[];
  assistant: AssistantDefinition;
  destroy(): void;
  addContext(
    text: string,
    role: ChatCompletionMessageParam["role"],
    name?: string,
    tool_call_id?: string
  ): Promise<void>;
  completion(
    text: string,
    interactionCount: number,
    role: ChatCompletionMessageParam["role"],
    name?: string,
    tool_call_id?: string
  ): Promise<void>;
}

export function createLLMProvider(
  call_sid: string,
  assistant: AssistantDefinition
): ILargeLanguageModelService {
  switch (assistant.llm_provider) {
    case "openai":
      return new GptService(call_sid, assistant);
    case "deepseek":
      return new DeepSeekService(call_sid, assistant);
    case "groq":
      return new GroqService(call_sid, assistant);
    default:
      throw new Error(`Error no such provider: ${assistant.llm_provider}`);
  }
}
