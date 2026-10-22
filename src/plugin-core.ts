import { Plugin } from "@opencode/plugin"
import type { Model } from "@opencode/plugin"
import { loadCursorRuntime, type CursorRuntime } from "./cursor/index.js"
import { CURSOR_API_KEY_ENVIRONMENT, CURSOR_PACKAGE_NAME, CURSOR_PLUGIN_ID } from "./plugin/identifiers.js"
import { registerCursorCredentials } from "./plugin/credentials.js"
import { CursorModelDiscovery } from "./plugin/discovery.js"
import { watchCredentialChanges, watchProviderChanges } from "./plugin/lifecycle.js"
import { RefreshController } from "./plugin/refresh.js"
import {
  cursorProviderIDs,
  ModelSnapshots,
  type ModelSnapshot,
  updateCursorProvider,
} from "./plugin/provider-models.js"

export type CursorPluginDeps = { runtime?: CursorRuntime }

export function createCursorPlugin(deps: CursorPluginDeps = {}): Plugin.Plugin {
  return Plugin.define({
    id: CURSOR_PLUGIN_ID,
    async setup(ctx) {
      const runtime = deps.runtime ?? (await loadCursorRuntime())
      const discovery = new CursorModelDiscovery(runtime)
      const snapshots = new ModelSnapshots()
      const configuredModels = new Map<string, ReadonlyMap<string, Model.Info>>()
      let providerIDs: string[] = []
      let refresh: RefreshController | undefined
      let stopCredentialWatching: (() => void) | undefined
      let initializing: Promise<void> | undefined

      const initialize = async (): Promise<void> => {
        if (refresh) return
        if (initializing) return initializing

        initializing = (async () => {
          const configuredProviders = (await ctx.provider.list()).data
          providerIDs = configuredProviders
            .filter((provider) => provider.package?.includes(CURSOR_PACKAGE_NAME))
            .map((provider) => provider.id)
          if (providerIDs.length === 0) return

          await ctx.provider.transform((editor) => {
            const environmentKey = process.env[CURSOR_API_KEY_ENVIRONMENT]?.trim()
            for (const providerID of cursorProviderIDs(editor)) {
              if (!providerIDs.includes(providerID)) continue
              const record = editor.get(providerID)
              if (!record) continue
              const configured = configuredModels.get(providerID) ?? new Map(record.models)
              configuredModels.set(providerID, configured)
              updateCursorProvider(
                editor,
                providerID,
                configured,
                snapshots.get(providerID),
                ctx.location.directory,
                environmentKey,
              )
            }
          })
          await ctx.integration.transform((editor) => registerCursorCredentials(editor, providerIDs))

          refresh = new RefreshController(async () => {
            const current = new Map<string, ModelSnapshot>()
            for (const providerID of providerIDs) {
              const existing = snapshots.get(providerID)
              if (existing) current.set(providerID, existing)
            }
            const next = await discovery.refresh(ctx, providerIDs, current)
            snapshots.replace(next)
            await ctx.provider.reload()
          })
          stopCredentialWatching = watchCredentialChanges(ctx, providerIDs, () => refresh!.run())
          await refresh.run()
        })()

        try {
          await initializing
        } finally {
          initializing = undefined
        }
      }

      const stopProviderWatching = watchProviderChanges(ctx, initialize)
      await initialize()
      return () => {
        stopProviderWatching()
        stopCredentialWatching?.()
      }
    },
  })
}

export const CursorPlugin = createCursorPlugin()
export default CursorPlugin
