import { randomUUID } from "node:crypto"
import { CursorBridge } from "../bridge/index.js"
import type { ChatCompletionRequest } from "../openai-types.js"
import { completionSse } from "./sse.js"
import { eventsToCompletion, jsonResponse } from "./completion-response.js"

export function sessionIdFrom(headers: Headers): string {
  return headers.get("x-session-id") || randomUUID()
}

export async function handleChatCompletions(
  request: ChatCompletionRequest,
  bridge: CursorBridge,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<Response> {
  const metadata = { id: `chatcmpl_${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: request.model }
  const context = { sessionId, abortSignal }
  if (request.stream) {
    return new Response(completionSse(bridge.stream(request, context), {
      ...metadata,
      includeUsage: request.stream_options?.include_usage !== false,
    }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }
  return jsonResponse(eventsToCompletion(await bridge.complete(request, context), metadata))
}
