import EventEmitter from "events";
import {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import toolDefinitions from "../tools/tools-manifest";
import { AssistantDefinition } from "../types/Assistant";

export interface ToolContext {
  call_sid: string;
  userContext: ChatCompletionMessageParam[];
}

export class ToolsService extends EventEmitter {
  private toolDefinitions: ChatCompletionTool[];
  private assistant: AssistantDefinition;
  private loadedTools: { [key: string]: any } = {};

  destroy() {
    console.log("Tool Service > Destroy()");
  }

  constructor(assistant: AssistantDefinition) {
    super();
    this.toolDefinitions = toolDefinitions;
    this.assistant = assistant;

    console.log("Instantiating Tool Service");

    // Import all functions included in function manifest
    // Note: the function name and file name must be the same
    this.toolDefinitions.forEach((tool: any) => {
      const functionName = tool.function.name;
      this.loadedTools[functionName] = require(`../tools/${functionName}`);
    });
  }

  getToolDefinitions(): ChatCompletionTool[] {
    return this.toolDefinitions;
  }

  runTool(context: ToolContext[], tool: ChatCompletionMessageToolCall): void {
    console.log("Tool Service, run tool", tool);
    if (!tool.function?.name) throw new Error("Tool function name is not set");

    let calledTool = this.loadedTools[tool.function.name];
    let calledToolArgs = JSON.parse(tool.function.arguments);

    console.log(
      `Request to call tool id ${tool.id} named "${tool.function.name}" with args`,
      calledToolArgs
    );

    console.log("TOOL", calledTool);

    let toolResponse = calledTool.default(calledToolArgs);

    // Code to run the tool
    this.emit("tool.result", context, tool, toolResponse ? toolResponse : "");
  }
}
