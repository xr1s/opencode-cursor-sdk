import { Integration, Model, Provider } from "@opencode/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { ConfigModel } from "../models/types.js"
import { CURSOR_PACKAGE_NAME, CURSOR_PROVIDER_NAME } from "./identifiers.js"

export type ModelSnapshot = Readonly<Record<string, ConfigModel>>

export class ModelSnapshots {
  private readonly values = new Map<string, ModelSnapshot>()

  get(providerID: string): ModelSnapshot | undefined {
    return this.values.get(providerID)
  }

  replace(next: ReadonlyMap<string, ModelSnapshot>): void {
    this.values.clear()
    for (const [providerID, models] of next) this.values.set(providerID, models)
  }
}

function toModelInfo(providerID: string, modelID: string, source: ConfigModel): Model.Info {
  return {
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID)),
    name: source.name,
    capabilities: {
      tools: source.tool_call,
      input: [...source.modalities.input],
      output: [...source.modalities.output],
    },
    limit: { ...source.limit },
    variants: Object.entries(source.variants ?? {}).map(([id, settings]) => ({
      id: Model.VariantID.make(id),
      settings: { ...settings },
    })),
  }
}

export function publishModels(
  providerID: string,
  configured: ReadonlyMap<string, Model.Info>,
  discovered: ModelSnapshot | undefined,
): Model.Info[] {
  const discoveredModels = Object.entries(discovered ?? {}).map(([id, model]) =>
    toModelInfo(providerID, id, model),
  )
  const models = new Map(discoveredModels.map((model) => [model.id, model]))
  for (const model of configured.values()) {
    const current = models.get(model.id)
    models.set(model.id, current ? { ...current, ...model } : model)
  }
  return [...models.values()]
}

export function cursorProviderIDs(editor: ProviderEditor): string[] {
  const existing = editor
    .list()
    .filter((record) => record.provider.package?.includes(CURSOR_PACKAGE_NAME))
    .map((record) => record.provider.id)
  return existing
}

export function updateCursorProvider(
  editor: ProviderEditor,
  providerID: string,
  configured: ReadonlyMap<string, Model.Info>,
  discovered: ModelSnapshot | undefined,
  cwd: string,
  environmentKey: string | undefined,
): void {
  const record = editor.get(providerID)
  if (!record) return
  const packageName = record.provider.package
  editor.update(providerID, (provider) => {
    provider.name ||= CURSOR_PROVIDER_NAME
    provider.package = packageName
    provider.activation = "enabled"
    provider.integrationID = Integration.ID.make(providerID)
    provider.settings = {
      ...(provider.settings ?? {}),
      cwd,
      ...(environmentKey ? { apiKey: environmentKey } : {}),
    }
  })
  editor.models.set(providerID, publishModels(providerID, configured, discovered))
}
