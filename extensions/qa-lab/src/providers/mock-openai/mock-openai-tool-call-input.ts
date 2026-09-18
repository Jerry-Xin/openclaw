// Tool-call input parsing helpers for the mock OpenAI provider, split out of server.ts
// to keep that grandfathered file within its line cap. Locate a completed tool call by
// its call id and parse its JSON arguments into a plain record.
import type { ResponsesInputItem } from "./mock-openai-contracts.js";

export function findToolCallByCallId(input: ResponsesInputItem[], callId: string) {
  return input.toReversed().find((item) => {
    const type = item.type;
    return (type === "function_call" || type === "custom_tool_call") && item.call_id === callId;
  });
}

export function parseToolCallArguments(toolCall: ResponsesInputItem) {
  if (typeof toolCall.arguments !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
