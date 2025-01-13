import { ChatCompletionMessageParam } from "openai/resources";

export type ConversationTurn =
  | ChatCompletionMessageParam
  | {
      name?: string;
      role: string;
      content: string;
    };
