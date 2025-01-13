// create metadata for all the available functions to pass to completions API
import { ChatCompletionTool } from "openai/resources";

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get-customer",
      description:
        "Retrieves customer details based on the call 'from' information",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "The phone number of the customer (caller)",
          },
        },
        required: ["from"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify-code",
      description: "Verifies a provided code against the calling number",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The verification code to check",
          },
          from: {
            type: "string",
            description: "The calling number to verify against",
          },
        },
        required: ["code", "from"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify-send",
      description:
        "Generates and sends a verification code via SMS to the phone number provided",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description:
              "The calling phone number to send the verification code to. This is the number the call came in from.",
          },
        },
        required: ["from"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "live-agent-handoff",
      description: "Transfers the call to a human agent",
      parameters: {
        type: "object",
        properties: {
          callSid: {
            type: "string",
            description: "The unique identifier of the call to be transferred",
          },
        },
        required: ["callSid"],
      },
    },
  },
];

export default tools;
