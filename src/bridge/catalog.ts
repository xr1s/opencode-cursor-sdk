import type { CursorRuntime } from "../cursor/index.js"
import type { CursorModelListItem } from "../models/types.js"

const CATALOG_TTL_MS = 60_000

export class CursorModelCatalog {
  private models: CursorModelListItem[] | undefined
  private loadedAt = 0

  constructor(
    private readonly runtime: CursorRuntime,
    private readonly apiKey: string,
  ) {}

  async list(): Promise<CursorModelListItem[]> {
    const now = Date.now()
    if (this.models && now - this.loadedAt < CATALOG_TTL_MS) return this.models
    try {
      const models = await this.runtime.listModels(this.apiKey)
      this.models = models
      this.loadedAt = now
    } catch {
      // A previously discovered catalog is safer than replacing it with an empty one.
    }
    return this.models ?? []
  }
}
