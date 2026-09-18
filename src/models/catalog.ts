import { variantMap } from "./variant-names.js"
import type { ConfigModel, CursorModelListItem } from "./types.js"

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 65_536
export const OPENCODE_CONTEXT = 100_000_000

const KNOWN_CONTEXT: Array<[RegExp, number]> = [
  [/^grok-4\.[56](?:$|-)/, 500_000],
  [/^gpt-5\.4-(?:mini|nano)(?:$|-)/, 400_000],
  [/^gpt-5-mini(?:$|-)/, 400_000],
  [/^claude-haiku-4-5(?:$|-)/, 200_000],
]

export function parseContextValue(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim())
  if (!match) return 0
  const number = Number(match[1])
  const suffix = (match[2] ?? "").toLowerCase()
  if (suffix === "m") return Math.round(number * 1_000_000)
  if (suffix === "k") return Math.round(number * 1_000)
  return Math.round(number)
}

function knownContext(model: CursorModelListItem): number {
  for (const id of [model.id, ...(model.aliases ?? [])]) {
    for (const [pattern, tokens] of KNOWN_CONTEXT) if (pattern.test(id)) return tokens
  }
  return 0
}

function inferredContext(model: CursorModelListItem): number {
  const definition = model.parameters?.find(
    (item) => /context/i.test(item.id) || /context/i.test(item.displayName ?? ""),
  )
  const maximum = Math.max(...(definition?.values.map((item) => parseContextValue(item.value)) ?? [0]))
  return maximum || knownContext(model) || DEFAULT_CONTEXT
}

function hasReasoning(model: CursorModelListItem): boolean {
  if (model.parameters?.some((item) => /reason|think|effort/i.test(item.id))) return true
  if (model.variants?.some((item) => /reason|think|max|high/i.test(item.displayName))) return true
  return /composer|gpt-5|claude|opus|sonnet|o[1-9]|gemini-3|grok/i.test(model.id)
}

export function toConfigModel(model: CursorModelListItem): ConfigModel {
  const context = inferredContext(model)
  return {
    name: model.displayName || model.id,
    description: model.description,
    tool_call: true,
    reasoning: hasReasoning(model),
    temperature: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: OPENCODE_CONTEXT, output: context >= 200_000 ? 128_000 : DEFAULT_OUTPUT },
    variants: variantMap(model, parseContextValue),
  }
}

export function toConfigModels(models: CursorModelListItem[]): Record<string, ConfigModel> {
  return Object.fromEntries(models.map((model) => [model.id, toConfigModel(model)]))
}
