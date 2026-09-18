import type { CompletionEvent, TokenUsage } from "../openai-types.js"
import type { CompletionMetadata } from "./completion-response.js"

type StreamMetadata = CompletionMetadata & { includeUsage: boolean }

export function completionSse(
  events: AsyncIterable<CompletionEvent>,
  metadata: StreamMetadata,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let cancelled = false
  return new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        if (cancelled) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          cancelled = true
        }
      }
      send(chunk(metadata, { role: "assistant", content: "" }))

      let finish: "stop" | "tool_calls" | "error" = "stop"
      let usage: TokenUsage | undefined
      let toolIndex = 0
      try {
        for await (const event of events) {
          if (cancelled) break
          if (event.type === "text") send(chunk(metadata, { content: event.text }))
          else if (event.type === "thinking") send(chunk(metadata, { reasoning_content: event.text }))
          else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              send(chunk(metadata, {
                tool_calls: [{ index: toolIndex, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
              }))
              send(chunk(metadata, {
                tool_calls: [{ index: toolIndex, function: { arguments: call.arguments } }],
              }))
              toolIndex++
            }
          } else if (event.type === "usage") usage = event.usage
          else if (event.type === "error") send({ error: { message: event.error, type: "api_error", code: "cursor_error" } })
          else if (event.type === "finish") finish = event.reason
        }
        if (!cancelled) {
          send({
            ...base(metadata),
            choices: [{ index: 0, delta: {}, finish_reason: finish === "error" ? "stop" : finish }],
            ...(metadata.includeUsage && usage ? { usage } : {}),
          })
          sendDone(controller, encoder, () => { cancelled = true })
        }
      } catch (error) {
        send({ error: { message: error instanceof Error ? error.message : String(error), type: "api_error" } })
      } finally {
        try {
          if (!cancelled) controller.close()
        } catch {
          cancelled = true
        }
      }
    },
    cancel() {
      cancelled = true
    },
  })
}

function base(metadata: CompletionMetadata) {
  return {
    id: metadata.id,
    object: "chat.completion.chunk",
    created: metadata.created,
    model: metadata.model,
  }
}

function chunk(metadata: CompletionMetadata, delta: Record<string, unknown>) {
  return { ...base(metadata), choices: [{ index: 0, delta, finish_reason: null }] }
}

function sendDone(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  cancel: () => void,
) {
  try {
    controller.enqueue(encoder.encode("data: [DONE]\n\n"))
  } catch {
    cancel()
  }
}
