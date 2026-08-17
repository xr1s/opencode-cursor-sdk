import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as pluginModule from "../src/plugin.js"
import { createCursorPlugin } from "../src/plugin-core.js"
import { FALLBACK_MODELS } from "../src/models.js"
import type { CursorRuntime } from "../src/runtime.js"

test("plugin module exposes only callable runtime exports", () => {
  for (const [name, value] of Object.entries(pluginModule)) {
    assert.equal(typeof value, "function", `${name} must be a plugin function`)
  }
})

const TEST_PROVIDER_ID = "cursor-test-fixture-does-not-exist"

function runtime(models: Array<{ id: string; displayName?: string }>): CursorRuntime {
  return {
    async listModels() {
      return models
    },
    async createAgent() {
      throw new Error("unused")
    },
  }
}

test("config hook injects fallback models before /connect", async () => {
  const plugin = createCursorPlugin({
    runtime: runtime([]),
    readApiKey: async () => undefined,
  })
  const hooks = await plugin({ directory: "/tmp/proj" } as never)
  const config = {
    provider: {
      [TEST_PROVIDER_ID]: {
        npm: "file:///abs/path/to/opencode-cursor-sdk",
        options: {},
      },
    },
  } as any
  await hooks.config!(config)
  assert.ok(config.provider[TEST_PROVIDER_ID].models["composer-2.5"])
  assert.equal(config.provider[TEST_PROVIDER_ID].options.cwd, "/tmp/proj")
  assert.equal(config.provider[TEST_PROVIDER_ID].models["composer-2.5"].name, FALLBACK_MODELS["composer-2.5"].name)
})

test("config hook discovers live Cursor models after /connect", async () => {
  const plugin = createCursorPlugin({
    runtime: runtime([{ id: "gpt-5.5", displayName: "GPT-5.5" }]),
    readApiKey: async () => "cursor-key",
  })
  const hooks = await plugin({ directory: "/tmp/proj" } as never)
  const config = {
    provider: {
      [TEST_PROVIDER_ID]: {
        npm: "opencode-cursor-sdk@git+ssh://git@example.com/opencode-cursor-sdk.git",
        options: {},
      },
    },
  } as any
  await hooks.config!(config)
  assert.equal(config.provider[TEST_PROVIDER_ID].models["gpt-5.5"].name, "GPT-5.5")
  assert.equal(config.provider[TEST_PROVIDER_ID].models["composer-2.5"], undefined)
})

test("config hook leaves unrelated providers untouched", async () => {
  const plugin = createCursorPlugin({
    runtime: runtime([{ id: "gpt-5.5" }]),
    readApiKey: async () => "cursor-key",
  })
  const hooks = await plugin({ directory: "/tmp/proj" } as never)
  const config = {
    provider: {
      other: { npm: "some-other-provider", options: {}, models: {} },
    },
  } as any
  await hooks.config!(config)
  assert.deepEqual(config.provider.other.models, {})
})

test("auth hook registers Cursor for /connect", async () => {
  const plugin = createCursorPlugin()
  const hooks = await plugin({ directory: "/tmp/proj" } as never)
  assert.equal(hooks.auth?.provider, "cursor")
  assert.ok(hooks.auth?.methods.some((method) => method.type === "api"))
  assert.ok(hooks.auth?.methods.some((method) => method.type === "oauth"))
})

test("chat.headers copies the OpenCode session id", async () => {
  const plugin = createCursorPlugin()
  const hooks = await plugin({ directory: "/tmp/proj" } as never)
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({ sessionID: "ses_abc" } as never, output)
  assert.equal(output.headers["x-session-id"], "ses_abc")
})
