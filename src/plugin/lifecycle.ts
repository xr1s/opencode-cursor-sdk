import type { Plugin } from "@opencode/plugin"

export function watchProviderChanges(
  ctx: Plugin.Context,
  initialize: () => Promise<void>,
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "provider.updated") await initialize()
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(`[cursor] provider watcher stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
  return () => controller.abort()
}

export function watchCredentialChanges(
  ctx: Plugin.Context,
  integrationIDs: readonly string[],
  refresh: () => Promise<void>,
): () => void {
  const watched = new Set(integrationIDs)
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "credential.switched") continue
        if (watched.has(event.data.integrationID)) await refresh()
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(`[cursor] credential watcher stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()
  return () => controller.abort()
}
