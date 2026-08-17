import { handleChatCompletions, sessionIdFrom } from "./completions.js"
import { FALLBACK_MODELS, toConfigModels, type CursorModelListItem } from "./models.js"
import type { CursorProviderOptions } from "./options.js"
import { getDefaultRuntime, type CursorRuntime } from "./runtime.js"
import type { ChatCompletionRequest } from "./openai-types.js"

export function cursorFetch(
  options: CursorProviderOptions,
  runtime?: CursorRuntime,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const headers = mergeHeaders(input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)

    if (url.includes("/models") && method === "GET") {
      return listModelsResponse(options.apiKey, runtime)
    }

    if (url.includes("/chat/completions") && method === "POST") {
      const body = await readBody(input, init)
      const request = JSON.parse(body || "{}") as ChatCompletionRequest
      return handleChatCompletions(request, {
        apiKey: options.apiKey,
        cwd: options.cwd,
        runtime,
        sessionId: sessionIdFrom(headers),
        abortSignal: signal ?? undefined,
      })
    }

    return new Response(`Cursor provider: unsupported ${method} ${url}`, { status: 404 })
  }
}

async function listModelsResponse(apiKey: string, runtime?: CursorRuntime): Promise<Response> {
  let models: CursorModelListItem[] = []
  try {
    models = await (runtime ?? getDefaultRuntime()).listModels(apiKey)
  } catch {
    models = Object.keys(FALLBACK_MODELS).map((id) => ({ id, displayName: FALLBACK_MODELS[id].name }))
  }
  const data = Object.entries(toConfigModels(models)).map(([id, model]) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: model.name,
  }))
  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" },
  })
}

function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
  return headers
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body)
  if (input instanceof Request) return input.text()
  return ""
}
