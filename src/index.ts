import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { cursorFetch } from "./fetch.js"
import { CURSOR_LOCAL_BASE_URL, type CursorProviderOptions } from "./options.js"
import { loadSdkRuntime, setDefaultRuntime } from "./runtime.js"

let sdkReady: Promise<void> | undefined

function ensureRuntime(): Promise<void> {
  if (!sdkReady) {
    sdkReady = loadSdkRuntime()
      .then((runtime) => setDefaultRuntime(runtime))
      .catch((error) => {
        sdkReady = undefined
        throw error
      })
  }
  return sdkReady
}

/**
 * OpenCode loads external providers by calling the package's first export whose
 * name starts with "create", passing the provider id as `name` plus the
 * configured `options` (including the `/connect` API key).
 */
export function createCursor(options: CursorProviderOptions) {
  if (!options.apiKey) {
    throw new Error("Cursor: `apiKey` is required; run OpenCode `/connect`")
  }

  const ready = ensureRuntime()

  return createOpenAICompatible({
    name: options.name ?? "cursor",
    baseURL: CURSOR_LOCAL_BASE_URL,
    apiKey: options.apiKey,
    fetch: async (input, init) => {
      await ready
      return cursorFetch(options)(input, init)
    },
  })
}

export type { CursorProviderOptions } from "./options.js"
