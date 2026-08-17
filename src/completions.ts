import { randomUUID } from "node:crypto"
import { bridgeFor, type BridgeOptions } from "./bridge.js"
import type {
  ChatCompletionRequest,
  CompletionEvent,
  TokenUsage,
} from "./openai-types.js"

export function sessionIdFrom(headers: Headers): string {
  return headers.get("x-session-id") || randomUUID()
}

export async function handleChatCompletions(
  request: ChatCompletionRequest,
  options: BridgeOptions & { sessionId: string; abortSignal?: AbortSignal },
): Promise<Response> {
  const bridge = bridgeFor(options)
  const id = `chatcmpl_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const model = request.model

  if (request.stream) {
    const stream = encodeSse(
      bridge.stream(request, options),
      { id, created, model, includeUsage: request.stream_options?.include_usage !== false },
    )
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  const events = await bridge.complete(request, options)
  return jsonResponse(eventsToCompletion(events, { id, created, model }))
}

export function eventsToCompletion(
  events: CompletionEvent[],
  meta: { id: string; created: number; model: string },
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
    return {
      error: {
        message: error,
        type: "api_error",
        code: "cursor_error",
      },
    }
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
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish === "error" ? "stop" : finish,
      },
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function encodeSse(
  events: AsyncIterable<CompletionEvent>,
  meta: { id: string; created: number; model: string; includeUsage: boolean },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }
      send({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })

      let finish: "stop" | "tool_calls" | "error" = "stop"
      let usage: TokenUsage | undefined
      let toolIndex = 0

      try {
        for await (const event of events) {
          if (event.type === "text") {
            send(chunk(meta, { content: event.text }))
          } else if (event.type === "thinking") {
            send(chunk(meta, { reasoning_content: event.text }))
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              send(
                chunk(meta, {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: "" },
                    },
                  ],
                }),
              )
              send(
                chunk(meta, {
                  tool_calls: [
                    {
                      index: toolIndex,
                      function: { arguments: call.arguments },
                    },
                  ],
                }),
              )
              toolIndex++
            }
          } else if (event.type === "usage") {
            usage = event.usage
          } else if (event.type === "error") {
            send({
              error: { message: event.error, type: "api_error", code: "cursor_error" },
            })
          } else if (event.type === "finish") {
            finish = event.reason
          }
        }

        send({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finish === "error" ? "stop" : finish,
            },
          ],
          ...(meta.includeUsage && usage ? { usage } : {}),
        })
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } catch (error) {
        send({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "api_error",
          },
        })
      } finally {
        controller.close()
      }
    },
  })
}

function chunk(
  meta: { id: string; created: number; model: string },
  delta: Record<string, unknown>,
) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
}

function jsonResponse(body: Record<string, unknown>): Response {
  const isError = Boolean(body.error)
  return new Response(JSON.stringify(body), {
    status: isError ? 502 : 200,
    headers: { "Content-Type": "application/json" },
  })
}
