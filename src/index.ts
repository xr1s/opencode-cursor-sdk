import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createCursorFetch } from "./http/cursor-fetch.js"
import { CURSOR_LOCAL_BASE_URL } from "./provider/identity.js"
import type { CursorProviderOptions } from "./options.js"
import plugin from "./plugin-core.js"
import { loadCursorRuntime } from "./cursor/index.js"

/**
 * OpenCode V2's AI SDK compatibility layer loads the package's first export
 * whose name starts with "create", passing the provider id as `name` plus the
 * resolved provider settings and credential.
 */
export function createCursor(options: CursorProviderOptions) {
  if (!options.apiKey) {
    throw new Error("Cursor: `apiKey` is required; run OpenCode `/connect`")
  }

  const runtime = loadCursorRuntime()
  let transport: typeof globalThis.fetch | undefined

  return createOpenAICompatible({
    name: options.name ?? "cursor",
    baseURL: CURSOR_LOCAL_BASE_URL,
    apiKey: options.apiKey,
    fetch: async (input, init) => {
      transport ??= createCursorFetch(options, await runtime)
      return transport(input, init)
    },
  })
}

export type { CursorProviderOptions } from "./options.js"

/** The V2 server plugin is loaded from the package root. */
export default plugin
