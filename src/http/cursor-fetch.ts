import { CursorBridge } from "../bridge/index.js"
import type { CursorRuntime } from "../cursor/index.js"
import type { CursorProviderOptions } from "../options.js"
import type { ChatCompletionRequest } from "../openai-types.js"
import { handleChatCompletions, sessionIdFrom } from "./chat-completions.js"
import { modelListResponse } from "./model-list.js"
import { requestBody, requestHeaders, requestMethod, requestSignal, requestUrl } from "./request.js"

export function createCursorFetch(
  options: CursorProviderOptions,
  runtime: CursorRuntime,
): typeof globalThis.fetch {
  const bridge = new CursorBridge({ apiKey: options.apiKey, cwd: options.cwd, runtime })
  return async (input, init) => {
    const url = requestUrl(input)
    const method = requestMethod(input, init)
    const headers = requestHeaders(input, init)
    const signal = requestSignal(input, init)
    if (url.includes("/models") && method === "GET") return modelListResponse(options.apiKey, runtime)
    if (url.includes("/chat/completions") && method === "POST") {
      const body = await requestBody(input, init)
      return handleChatCompletions(
        JSON.parse(body || "{}") as ChatCompletionRequest,
        bridge,
        sessionIdFrom(headers),
        signal,
      )
    }
    return new Response(`Cursor provider: unsupported ${method} ${url}`, { status: 404 })
  }
}
