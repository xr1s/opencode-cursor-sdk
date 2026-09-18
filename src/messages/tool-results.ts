import { textOf } from "./content.js"
import type { ChatMessage } from "../openai-types.js"

export type ToolResult = { id: string; content: string }

export function trailingToolResults(messages: ChatMessage[]): ToolResult[] | undefined {
  const results: ToolResult[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "tool") break
    results.push({
      id: message.tool_call_id ?? "",
      content: textOf(message.content) || "(empty tool result)",
    })
  }
  return results.length > 0 ? results.reverse() : undefined
}
