import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as pluginModule from "../src/plugin.js"
import { createCursorPlugin } from "../src/plugin-core.js"
import type { CursorRuntime } from "../src/cursor/index.js"

test("plugin module exports a V2 plugin", () => {
  assert.equal(typeof pluginModule.default, "object")
  assert.equal(pluginModule.default.id, "opencode-cursor-sdk")
  assert.equal(typeof pluginModule.default.setup, "function")
})

function runtime(models: Array<{ id: string; displayName?: string }>): CursorRuntime {
  return {
    async listModels() {
      return models
    },
    async createAgent() {
      throw new Error("unused")
    },
    async resumeAgent() {
      throw new Error("unused")
    },
  }
}

function context(input: { key?: string; packageName?: string; models?: Map<string, any> }) {
  const records = new Map<string, any>()
  const integrations = new Map<string, any>()
  const methods: any[] = []
  const providerTransforms: Array<(editor: any) => void> = []
  let providerReloads = 0
  const subscriptions = new Set<{ events: any[]; resolve?: (event: any) => void }>()

  const providerEditor = {
    list: () => [...records.values()],
    get: (id: string) => records.get(id),
    add: ({ info, models }: { info: any; models: any[] }) => {
      records.set(info.id, { provider: info, models: new Map(models.map((model) => [model.id, model])) })
    },
    update: (id: string, update: (provider: any) => void) => update(records.get(id).provider),
    remove: (id: string) => records.delete(id),
    models: {
      set: (providerID: string, models: any[]) => {
        records.get(providerID).models = new Map(models.map((model) => [model.id, model]))
      },
      update: () => {},
      remove: () => {},
    },
  }

  if (input.packageName) {
    const providerID = input.packageName === "some-other-provider" ? "other" : "cursor"
    records.set(providerID, {
      provider: {
        id: providerID,
        name: "Cursor",
        package: input.packageName,
        activation: "auto",
      },
      models: input.models ?? new Map(),
    })
  }

  const integrationEditor = {
    list: () => [...integrations.values()],
    get: (id: string) => integrations.get(id),
    update: (id: string, update: (integration: any) => void) => {
      const integration = integrations.get(id) ?? { id, name: id }
      integrations.set(id, integration)
      update(integration)
    },
    remove: (id: string) => integrations.delete(id),
    method: {
      list: () => methods.map((item) => item.method),
      update: (item: any) => methods.push(item),
      remove: () => {},
    },
  }

  const abortableEvents = {
    async *subscribe({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
  }

  const pluginContext = {
    options: {},
    location: { directory: "/tmp/proj" },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        providerTransforms.push(callback)
        callback(providerEditor)
        return { dispose: async () => {} }
      },
      list: async () => ({ data: [...records.values()].map((record) => record.provider) }),
      reload: async () => {
        providerReloads++
        for (const callback of providerTransforms) callback(providerEditor)
      },
    },
    integration: {
      transform: async (callback: (editor: any) => void) => {
        callback(integrationEditor)
        return { dispose: async () => {} }
      },
      reload: async () => {},
      connection: {
        active: async (id: string) => (input.key ? { id: `connection-${id}` } : undefined),
        resolve: async () => (input.key ? { type: "key", key: input.key } : undefined),
      },
    },
    event: abortableEvents,
  }

  const event = {
    subscribe: ({ signal }: { signal: AbortSignal }) => {
      const subscription: { events: any[]; resolve?: (event: any) => void } = { events: [] }
      subscriptions.add(subscription)
      const remove = () => {
        subscriptions.delete(subscription)
        subscription.resolve?.(undefined)
      }
      signal.addEventListener("abort", remove, { once: true })
      return (async function* () {
        try {
          while (!signal.aborted) {
            const next = subscription.events.shift() ?? await new Promise<any>((resolve) => {
              subscription.resolve = resolve
            })
            if (!next) return
            yield next
          }
        } finally {
          remove()
        }
      })()
    },
  }

  function emit(next: any): void {
    for (const subscription of subscriptions) {
      if (subscription.resolve) {
        const resolve = subscription.resolve
        subscription.resolve = undefined
        resolve(next)
      } else {
        subscription.events.push(next)
      }
    }
  }

  return { context: { ...pluginContext, event } as any, records, methods, providerReloads: () => providerReloads, emit }
}

test("V2 provider transform publishes only discovered models and project cwd", async () => {
  const fixture = context({ packageName: "aisdk:opencode-cursor-sdk" })
  const cleanup = await createCursorPlugin({ runtime: runtime([]) }).setup(fixture.context)
  const provider = fixture.records.get("cursor")

  assert.equal(provider.provider.package, "aisdk:opencode-cursor-sdk")
  assert.equal(provider.provider.settings.cwd, "/tmp/proj")
  assert.equal(provider.models.size, 0)
  assert.ok(fixture.methods.some((item) => item.method.type === "key"))
  assert.ok(fixture.methods.some((item) => item.method.type === "oauth"))

  await cleanup?.()
})

test("V2 provider transform publishes discovered models", async () => {
  const fixture = context({ key: "cursor-key", packageName: "aisdk:opencode-cursor-sdk" })
  await createCursorPlugin({
    runtime: runtime([{ id: "gpt-5.5", displayName: "GPT-5.5" }]),
  }).setup(fixture.context)

  const provider = fixture.records.get("cursor")
  assert.equal(provider.models.get("gpt-5.5").name, "GPT-5.5")
  assert.ok(fixture.providerReloads() >= 1)
})

test("V2 plugin leaves unrelated providers untouched", async () => {
  const fixture = context({ packageName: "some-other-provider" })
  const cleanup = await createCursorPlugin({ runtime: runtime([]) }).setup(fixture.context)
  assert.equal(fixture.records.has("cursor"), false)
  assert.equal(fixture.records.get("other").provider.package, "some-other-provider")
  await cleanup?.()
})

test("V2 plugin initializes after the configured provider appears", async () => {
  const fixture = context({ key: "cursor-key" })
  const cleanup = await createCursorPlugin({ runtime: runtime([{ id: "gpt-5.5", displayName: "GPT-5.5" }]) }).setup(fixture.context)

  fixture.records.set("cursor", {
    provider: {
      id: "cursor",
      name: "Cursor",
      package: "aisdk:opencode-cursor-sdk",
      activation: "auto",
    },
    models: new Map(),
  })
  fixture.emit({ type: "provider.updated", data: {} })

  for (let attempt = 0; attempt < 20 && !fixture.records.get("cursor").models.has("gpt-5.5"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  assert.equal(fixture.records.get("cursor").provider.settings.cwd, "/tmp/proj")
  assert.equal(fixture.records.get("cursor").models.get("gpt-5.5").name, "GPT-5.5")
  assert.ok(fixture.methods.some((item) => item.method.type === "oauth"))
  await cleanup?.()
})
