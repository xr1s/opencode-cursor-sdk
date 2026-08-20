import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  FALLBACK_MODELS,
  OPENCODE_CONTEXT,
  parseContextValue,
  resolveModelSelection,
  slug,
  toConfigModel,
  toConfigModels,
  uniqueSlug,
  type CursorModelListItem,
} from "../src/models.js"

const composer: CursorModelListItem = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  aliases: ["composer"],
  parameters: [
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    { displayName: "Default", isDefault: true, params: [{ id: "fast", value: "false" }] },
    { displayName: "Fast", params: [{ id: "fast", value: "true" }] },
  ],
}

test("slug and uniqueSlug", () => {
  assert.equal(slug("Composer 2.5 Fast"), "composer-2-5-fast")
  const used = new Set<string>()
  assert.equal(uniqueSlug("Fast", used), "fast")
  assert.equal(uniqueSlug("Fast", used), "fast-2")
})

test("parseContextValue understands k/m suffixes", () => {
  assert.equal(parseContextValue("200k"), 200_000)
  assert.equal(parseContextValue("1m"), 1_000_000)
  assert.equal(parseContextValue("128000"), 128_000)
})

test("toConfigModel exposes non-default variants as reasoningEffort slugs", () => {
  const model = toConfigModel(composer)
  assert.equal(model.name, "Composer 2.5")
  assert.equal(model.tool_call, true)
  assert.deepEqual(model.variants, { fast: { reasoningEffort: "fast" } })
})

test("toConfigModels keys by catalog id", () => {
  const map = toConfigModels([composer])
  assert.ok(map["composer-2.5"])
  assert.equal(map["composer-2.5"].name, "Composer 2.5")
})

test("resolveModelSelection maps aliases, variants, and suffixed ids", () => {
  const catalog = [composer]
  assert.deepEqual(resolveModelSelection(catalog, "composer"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  })
  assert.deepEqual(resolveModelSelection(catalog, "composer-2.5", "fast"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  })
  assert.deepEqual(resolveModelSelection(catalog, "composer-2.5-fast"), {
    id: "composer-2.5",
    params: [{ id: "fast", value: "true" }],
  })
})

test("FALLBACK_MODELS includes composer-2.5 and auto", () => {
  assert.ok(FALLBACK_MODELS["composer-2.5"])
  assert.ok(FALLBACK_MODELS.auto)
})

const grok: CursorModelListItem = {
  id: "grok-4.6",
  displayName: "Cursor Grok 4.6",
  parameters: [
    {
      id: "effort",
      displayName: "Effort",
      values: [
        { value: "low", displayName: "Low" },
        { value: "medium", displayName: "Medium" },
        { value: "high", displayName: "High" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "low" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "Cursor Grok 4.6",
      params: [
        { id: "effort", value: "medium" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "Cursor Grok 4.6",
      isDefault: true,
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
  ],
}

test("colliding Cursor variant names become effort slugs", () => {
  const model = toConfigModel(grok)
  assert.deepEqual(model.variants, {
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    "low-fast": { reasoningEffort: "low-fast" },
    "medium-fast": { reasoningEffort: "medium-fast" },
    fast: { reasoningEffort: "fast" },
    "high-fast": { reasoningEffort: "high-fast" },
  })
})

test("unique variant displayName matching the model is not a collision", () => {
  const model = toConfigModel({
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    variants: [{ displayName: "GPT-5 Mini", isDefault: true, params: [] }],
  })
  assert.equal(model.variants, undefined)
})

test("unique variant names keep displayName slugs even when one matches the model", () => {
  const model = toConfigModel({
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    parameters: [
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
      },
    ],
    variants: [
      {
        displayName: "GPT-5 Mini",
        isDefault: true,
        params: [{ id: "fast", value: "false" }],
      },
      {
        displayName: "GPT-5 Mini Fast",
        params: [{ id: "fast", value: "true" }],
      },
    ],
  })
  assert.deepEqual(model.variants, {
    "gpt-5-mini-fast": { reasoningEffort: "gpt-5-mini-fast" },
  })
})

test("inferContext uses known windows for output; OpenCode context is oversized", () => {
  assert.equal(toConfigModel(grok).limit.context, OPENCODE_CONTEXT)
  assert.equal(toConfigModel(grok).limit.output, 128_000)
  assert.equal(toConfigModel({ id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini" }).limit.output, 128_000)
  assert.equal(toConfigModel({ id: "gpt-5.4-nano", displayName: "GPT-5.4 Nano" }).limit.output, 128_000)
  assert.equal(toConfigModel({ id: "gpt-5-mini", displayName: "GPT-5 Mini" }).limit.output, 128_000)
  assert.equal(toConfigModel({ id: "claude-haiku-4-5", displayName: "Haiku 4.5" }).limit.output, 128_000)
  assert.equal(toConfigModel({ id: "auto-smart", displayName: "Auto" }).limit.context, OPENCODE_CONTEXT)
  assert.equal(toConfigModel({ id: "auto-smart", displayName: "Auto" }).limit.output, 65_536)
})

test("catalog context parameter still drives output limit", () => {
  const model = toConfigModel({
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [{ value: "272k" }, { value: "1m" }],
      },
    ],
  })
  assert.equal(model.limit.context, OPENCODE_CONTEXT)
  assert.equal(model.limit.output, 128_000)
})

test("resolveModelSelection maps grok effort variants to full params", () => {
  const catalog = [grok]
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6", "high"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6", "medium"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "medium" },
      { id: "fast", value: "false" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6-low"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "low" },
      { id: "fast", value: "false" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6", "fast"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6", "low-fast"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "low" },
      { id: "fast", value: "true" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6", "high-fast"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "high" },
      { id: "fast", value: "true" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "grok-4.6-medium-fast"), {
    id: "grok-4.6",
    params: [
      { id: "effort", value: "medium" },
      { id: "fast", value: "true" },
    ],
  })
})

const luna: CursorModelListItem = {
  id: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  parameters: [
    {
      id: "context",
      displayName: "Context",
      values: [
        { value: "272k", displayName: "272K" },
        { value: "1m", displayName: "1M" },
      ],
    },
    {
      id: "reasoning",
      displayName: "Reasoning",
      values: [
        { value: "medium", displayName: "Medium" },
        { value: "high", displayName: "High" },
        { value: "max", displayName: "Max" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "GPT-5.6 Luna",
      params: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "medium" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "GPT-5.6 Luna",
      params: [
        { id: "context", value: "272k" },
        { id: "reasoning", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "GPT-5.6 Luna",
      isDefault: true,
      params: [
        { id: "context", value: "1m" },
        { id: "reasoning", value: "medium" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "GPT-5.6 Luna",
      params: [
        { id: "context", value: "1m" },
        { id: "reasoning", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
    {
      displayName: "GPT-5.6 Luna",
      params: [
        { id: "context", value: "1m" },
        { id: "reasoning", value: "max" },
        { id: "fast", value: "false" },
      ],
    },
  ],
}

test("fast clones catalog variants; default plus fast is named fast", () => {
  const model = toConfigModel(luna)
  assert.deepEqual(model.variants, {
    "272k": { reasoningEffort: "272k" },
    "272k-high": { reasoningEffort: "272k-high" },
    high: { reasoningEffort: "high" },
    max: { reasoningEffort: "max" },
    "272k-fast": { reasoningEffort: "272k-fast" },
    "272k-high-fast": { reasoningEffort: "272k-high-fast" },
    "high-fast": { reasoningEffort: "high-fast" },
    "max-fast": { reasoningEffort: "max-fast" },
    fast: { reasoningEffort: "fast" },
  })
})

test("resolveModelSelection maps luna fast and max-mode", () => {
  const catalog = [luna]
  assert.deepEqual(resolveModelSelection(catalog, "gpt-5.6-luna", "fast"), {
    id: "gpt-5.6-luna",
    params: [
      { id: "context", value: "1m" },
      { id: "reasoning", value: "medium" },
      { id: "fast", value: "true" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "gpt-5.6-luna", "high-fast"), {
    id: "gpt-5.6-luna",
    params: [
      { id: "context", value: "1m" },
      { id: "reasoning", value: "high" },
      { id: "fast", value: "true" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "gpt-5.6-luna", "max"), {
    id: "gpt-5.6-luna",
    params: [
      { id: "context", value: "1m" },
      { id: "reasoning", value: "max" },
      { id: "fast", value: "false" },
    ],
  })
  assert.deepEqual(resolveModelSelection(catalog, "gpt-5.6-luna", "max-mode"), {
    id: "gpt-5.6-luna",
    params: [
      { id: "context", value: "1m" },
      { id: "reasoning", value: "medium" },
      { id: "fast", value: "false" },
    ],
  })
})

test("max-mode variant is synthesized when catalog default is the smaller window", () => {
  const model: CursorModelListItem = {
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
    parameters: [
      {
        id: "context",
        displayName: "Context",
        values: [
          { value: "200k", displayName: "200K" },
          { value: "1m", displayName: "1M" },
        ],
      },
    ],
    variants: [
      {
        displayName: "Claude Opus 4.8",
        isDefault: true,
        params: [{ id: "context", value: "200k" }],
      },
    ],
  }
  assert.deepEqual(toConfigModel(model).variants, {
    "200k": { reasoningEffort: "200k" },
    "1m": { reasoningEffort: "1m" },
  })
  assert.deepEqual(resolveModelSelection([model], "claude-opus-4-8", "max"), {
    id: "claude-opus-4-8",
    params: [{ id: "context", value: "1m" }],
  })
  assert.deepEqual(resolveModelSelection([model], "claude-opus-4-8", "max-mode"), {
    id: "claude-opus-4-8",
    params: [{ id: "context", value: "1m" }],
  })
  assert.deepEqual(resolveModelSelection([model], "claude-opus-4-8", "1m"), {
    id: "claude-opus-4-8",
    params: [{ id: "context", value: "1m" }],
  })
})
