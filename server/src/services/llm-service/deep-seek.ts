import EventEmitter from "events";
import colors from "colors";
import OpenAI from "openai";
import toolDefinitions from "../../tools/tools-manifest";
import { AssistantDefinition } from "../../types/Assistant";
import {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { ILargeLanguageModelService } from ".";

export class DeepSeekService
  extends EventEmitter
  implements ILargeLanguageModelService
{
  call_sid: string;
  openai: OpenAI;
  userContext: ChatCompletionMessageParam[] = [];
  partialResponseIndex: number;
  assistant: AssistantDefinition;
  tools: ChatCompletionTool[] | undefined;
  private destroyed: boolean = false;

  constructor(call_sid: string, assistant: AssistantDefinition) {
    super();
    this.call_sid = call_sid;
    /*********************
     *
     * Using the OpenAI SDK with the DeepSeek API Endpoint
     *
     *********************/
    this.openai = new OpenAI({
      baseURL: `https://api.deepseek.com`,
      apiKey: process.env.DEEPSEEK_API_KEY,
    });
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
      case "function":
        if (!name)
          throw new Error(
            "Completion with type 'function' called without function name"
          );
        this.userContext.push({ name, role, content: text });
        break;
      case "tool":
        if (!tool_call_id)
          throw new Error(
            "Completion with type 'tool' called without tool_call_id"
          );

        this.userContext.push({ tool_call_id, role, content: text });
        break;
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
    console.time(`deepseek-completion-${this.call_sid}-${interactionCount}`);

    await this.addContext(text, role, name, tool_call_id);

    const stream = await this.openai.beta.chat.completions.stream({
      model: process.env.DEEPSEEK_MODEL || "",
      messages: this.userContext,
      tools: toolDefinitions,
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
            if (partialResponse.trim() !== "") {
              if (!this.destroyed)
                this.emit(
                  "llm.reply",
                  { llmReply, call_sid: this.call_sid },
                  interactionCount
                );
            } else {
              console.log("GPT > Ignoring empty response");
            }

            this.partialResponseIndex++;
            partialResponse = "";
          }
        }
      }
    }

    /*********************
     *
     *  Wait until the end to see if we need to call a function or tool
     *
     *********************/
    const finalChatCompletion = await stream.finalChatCompletion();

    console.log(
      `Finish reason ${finalChatCompletion.choices[0].finish_reason}`
    );

    if (finalChatCompletion.choices[0].finish_reason === "tool_calls") {
      this.userContext.push({
        tool_calls: finalChatCompletion.choices[0]?.message?.tool_calls,
        role: "assistant",
        content: finalChatCompletion.choices[0].message.content,
      });
      finalChatCompletion.choices[0]?.message?.tool_calls?.map((tool_call) => {
        if (!this.destroyed)
          this.emit("tool.request", this.userContext, tool_call);
      });
    }

    if (finishReason === "stop")
      if (!this.destroyed)
        this.emit("llm.complete", {
          call_sid: this.call_sid,
        });

    /*********************
     *
     *  Store user context
     *
     *********************/
    this.userContext.push({ role: "assistant", content: completeResponse });
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
    console.timeEnd(`gpt-completion-${this.call_sid}-${interactionCount}`);
  }
}
