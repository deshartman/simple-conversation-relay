import EventEmitter from "events";
import colors from "colors";
import groq, { Groq } from "groq-sdk";
import { AssistantDefinition } from "../../types/Assistant";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources";
import { ILargeLanguageModelService } from ".";

export class GroqService
  extends EventEmitter
  implements ILargeLanguageModelService
{
  call_sid: string;
  groq: Groq;
  userContext: ChatCompletionMessageParam[] = [];
  partialResponseIndex: number;
  assistant: AssistantDefinition;
  tools: ChatCompletionTool[] | undefined;
  private destroyed: boolean = false;

  constructor(call_sid: string, assistant: AssistantDefinition) {
    super();
    this.call_sid = call_sid;
    this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    this.partialResponseIndex = 0;
    this.assistant = assistant;
    this.tools = assistant.tools;

    // Initialize user context
    this.userContext.push({
      role: "system",
      content: `- You are a virtual assistant named "${assistant.assistant_name}" for the company "${assistant.company_name}"`,
    });
    this.userContext.push({
      role: "system",
      content: `The Twilio CallSid is: ${this.call_sid}`,
    });
    if (assistant.instructions && assistant.instructions !== undefined) {
      this.userContext.push({
        role: "system",
        content: `${assistant.instructions}`,
      });
    }
    this.userContext.push({
      role: "system",
      content: `${assistant.additional_context}`,
    });
  }
  destroy(): void {
    this.destroyed = true;
  }

  /*********************
   *
   * Add to context
   *
   *********************/
  async addContext(
    text: string,
    role: ChatCompletionMessageParam["role"],
    name?: string,
    tool_call_id?: string
  ) {
    switch (role) {
      case "user":
        this.userContext.push({ role, content: text });
        break;
      case "assistant":
        this.userContext.push({ role, content: text });
        break;
      case "system":
        this.userContext.push({ role, content: text });
        break;
      default:
        throw new Error(
          `Completion with type '${role}' not implemented for bard service`
        );
    }
  }

  /*********************
   *
   * Perform completion
   *
   *********************/
  async completion(
    text: string,
    interactionCount: number,
    role: ChatCompletionMessageParam["role"],
    name?: string,
    tool_call_id?: string
  ) {
    console.time(`groq-completion-${this.call_sid}-${interactionCount}`);

    await this.addContext(text, role, name, tool_call_id);

    const stream = await this.groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "",
      messages: this
        .userContext as groq.Chat.Completions.ChatCompletionMessage[],
      stream: true,
    });

    let completeResponse = "";
    let partialResponse = "";
    let finishReason = "";

    /*********************
     *
     *  Iterate over the response stream
     *
     *********************/
    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || "";
      finishReason = chunk.choices[0].finish_reason || "unknown";

      if (content && content != "") {
        const llmReply = {
          partialResponseIndex: this.partialResponseIndex,
          partialResponse: content,
        };

        if (!this.destroyed)
          this.emit(
            "llm.stream",
            { llmReply, call_sid: this.call_sid },
            interactionCount
          );
      }

      if (finishReason === "stop")
        if (!this.destroyed)
          this.emit("llm.complete", { call_sid: this.call_sid });

      // Emit TTS as soon as practicable or when there is a we stop
      if (finishReason !== "tool_calls") {
        {
          completeResponse += content;
          partialResponse += content;
          if (
            content.trim().slice(-1) === "•" ||
            content.trim().slice(-1) === "." ||
            finishReason === "stop"
          ) {
            const llmReply = {
              partialResponseIndex: this.partialResponseIndex,
              partialResponse,
            };

            if (partialResponse != "") {
              if (!this.destroyed)
                this.emit(
                  "llm.reply",
                  { llmReply, call_sid: this.call_sid },
                  interactionCount
                );
            } else {
              console.log("GROQ > Ignoring empty response");
            }
            this.partialResponseIndex++;
            partialResponse = "";
          }
        }
      }
    }

    /*********************
     *
     *  Store user context
     *
     *********************/
    this.userContext.push({ role: "assistant", content: completeResponse });
    console.log(
      `GROQ -> user context length: ${this.userContext.length}`.green
    );
    console.timeEnd(`groq-completion-${this.call_sid}-${interactionCount}`);
  }
}
