import type { CompletionEvent, TokenUsage } from "../openai-types.js"

export type CompletionMetadata = { id: string; created: number; model: string }

export function eventsToCompletion(
  events: CompletionEvent[],
  metadata: CompletionMetadata,
): Record<string, unknown> {
  let content = ""
  let reasoning = ""
  let usage: TokenUsage | undefined
  let error: string | undefined
  let finish: "stop" | "tool_calls" | "error" = "stop"
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = []

  for (const event of events) {
    if (event.type === "text") content += event.text
    else if (event.type === "thinking") reasoning += event.text
    else if (event.type === "tool_calls") toolCalls.push(...event.calls)
    else if (event.type === "usage") usage = event.usage
    else if (event.type === "error") error = event.error
    else if (event.type === "finish") finish = event.reason
  }

  if (error && finish === "error") {
    return { error: { message: error, type: "api_error", code: "cursor_error" } }
  }

  const message: Record<string, unknown> = { role: "assistant", content: content || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }))
  }
  return {
    id: metadata.id,
    object: "chat.completion",
    created: metadata.created,
    model: metadata.model,
    choices: [{ index: 0, message, finish_reason: finish === "error" ? "stop" : finish }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: body.error ? 502 : 200,
    headers: { "Content-Type": "application/json" },
  })
}
