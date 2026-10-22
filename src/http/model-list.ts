import { toConfigModels } from "../models/index.js"
import type { CursorModelListItem } from "../models/types.js"
import type { CursorRuntime } from "../cursor/index.js"

export async function modelListResponse(apiKey: string, runtime: CursorRuntime): Promise<Response> {
  let models: CursorModelListItem[] = []
  try {
    models = await runtime.listModels(apiKey)
  } catch {
    // An unavailable Cursor catalog is represented as an empty provider catalog.
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
