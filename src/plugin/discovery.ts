import type { Plugin } from "@opencode/plugin"
import { toConfigModels } from "../models/index.js"
import type { CursorRuntime } from "../cursor/index.js"
import { resolveCursorCredential } from "./credentials.js"
import type { ModelSnapshot } from "./provider-models.js"

export class CursorModelDiscovery {
  constructor(private readonly runtime: CursorRuntime) {}

  async refresh(ctx: Plugin.Context, providerIDs: readonly string[], previous: ReadonlyMap<string, ModelSnapshot>): Promise<ReadonlyMap<string, ModelSnapshot>> {
    const next = new Map<string, ModelSnapshot>()
    for (const providerID of providerIDs) {
      const apiKey = await resolveCursorCredential(ctx, providerID)
      if (!apiKey) continue
      try {
        next.set(providerID, toConfigModels(await this.runtime.listModels(apiKey)))
      } catch (error) {
        console.warn(`[cursor] model discovery failed for ${providerID}: ${error instanceof Error ? error.message : String(error)}`)
        const old = previous.get(providerID)
        if (old) next.set(providerID, old)
      }
    }
    return next
  }
}
