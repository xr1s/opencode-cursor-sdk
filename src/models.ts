export type CursorParameterValue = { id: string; value: string }

export type CursorModelListItem = {
  id: string
  displayName?: string
  description?: string
  aliases?: string[]
  parameters?: Array<{
    id: string
    displayName?: string
    values: Array<{ value: string; displayName?: string }>
  }>
  variants?: Array<{
    params: CursorParameterValue[]
    displayName: string
    description?: string
    isDefault?: boolean
  }>
}

/**
 * The model shape OpenCode's `config()` plugin hook /
 * `provider.<id>.models.<modelId>` expects.
 */
export type ConfigModel = {
  name: string
  description?: string
  tool_call: boolean
  reasoning: boolean
  temperature: boolean
  attachment: boolean
  modalities: { input: Array<"text" | "image">; output: Array<"text"> }
  limit: { context: number; output: number }
  variants?: Record<string, { reasoningEffort?: string; [key: string]: unknown }>
}

const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 65_536
export const OPENCODE_CONTEXT = 100_000_000

const KNOWN_CONTEXT: Array<[RegExp, number]> = [
  [/^grok-4\.[56](?:$|-)/, 500_000],
  [/^gpt-5\.4-(?:mini|nano)(?:$|-)/, 400_000],
  [/^gpt-5-mini(?:$|-)/, 400_000],
  [/^claude-haiku-4-5(?:$|-)/, 200_000],
]

type CursorVariant = NonNullable<CursorModelListItem["variants"]>[number]

export function slug(value: string): string {
  const slugified = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slugified || "variant"
}

export function uniqueSlug(value: string, used: Set<string>): string {
  const base = slug(value)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let i = 2
  while (used.has(`${base}-${i}`)) i++
  const next = `${base}-${i}`
  used.add(next)
  return next
}

function knownContext(model: CursorModelListItem): number {
  const ids = [model.id, ...(model.aliases ?? [])]
  for (const id of ids) {
    for (const [pattern, tokens] of KNOWN_CONTEXT) {
      if (pattern.test(id)) return tokens
    }
  }
  return 0
}

function inferContext(model: CursorModelListItem): number {
  const param = model.parameters?.find(
    (item) => /context/i.test(item.id) || /context/i.test(item.displayName ?? ""),
  )
  const values = param?.values.map((item) => item.value) ?? []
  let best = 0
  for (const value of values) {
    const tokens = parseContextValue(value)
    if (tokens > best) best = tokens
  }
  return best || knownContext(model) || DEFAULT_CONTEXT
}

export function parseContextValue(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim())
  if (!match) return 0
  const n = Number(match[1])
  const suffix = (match[2] ?? "").toLowerCase()
  if (suffix === "m") return Math.round(n * 1_000_000)
  if (suffix === "k") return Math.round(n * 1_000)
  return Math.round(n)
}

function inferReasoning(model: CursorModelListItem): boolean {
  if (model.parameters?.some((param) => /reason|think|effort/i.test(param.id))) return true
  if (model.variants?.some((variant) => /reason|think|max|high/i.test(variant.displayName))) {
    return true
  }
  return /composer|gpt-5|claude|opus|sonnet|o[1-9]|gemini-3|grok/i.test(model.id)
}

function paramDef(model: CursorModelListItem, id: string) {
  return model.parameters?.find((item) => item.id === id)
}

function paramVariantLabel(variant: CursorVariant, model: CursorModelListItem): string {
  const parts: string[] = []
  for (const param of variant.params ?? []) {
    const def = paramDef(model, param.id)
    const value = def?.values.find((item) => item.value === param.value)
    if (value?.displayName) {
      parts.push(value.displayName)
      continue
    }
    if (param.value === "true") {
      parts.push(def?.displayName || param.id)
      continue
    }
    if (param.value === "false") continue
    parts.push(param.value)
  }
  if (parts.length === 0) {
    const off = (variant.params ?? []).find((param) => param.value === "false")
    if (off) {
      const def = paramDef(model, off.id)
      return `${def?.displayName || off.id} off`
    }
    return variant.displayName
  }
  return parts.join(" ")
}

function displayNamesCollide(model: CursorModelListItem): boolean {
  const names = (model.variants ?? []).map((item) => item.displayName)
  return names.length > 1 && new Set(names).size < names.length
}

function labeledVariants(
  model: CursorModelListItem,
): Array<{ id: string; variant: CursorVariant }> {
  const collide = displayNamesCollide(model)
  const used = new Set<string>()
  const out: Array<{ id: string; variant: CursorVariant }> = []
  for (const variant of model.variants ?? []) {
    if (!collide && variant.isDefault) continue
    const label = collide ? paramVariantLabel(variant, model) : variant.displayName
    if (!collide && slug(label) === "default") continue
    out.push({ id: uniqueSlug(label, used), variant })
  }
  return out
}

function variantMap(model: CursorModelListItem): ConfigModel["variants"] {
  const variants: NonNullable<ConfigModel["variants"]> = {}
  const used = new Set<string>()
  for (const { id } of labeledVariants(model)) {
    used.add(id)
    variants[id] = { reasoningEffort: id }
  }
  if (Object.keys(variants).length === 0 && (model.parameters?.length ?? 0) > 0) {
    const param =
      model.parameters!.find((item) => /effort|reason|think/i.test(item.id)) ?? model.parameters![0]
    for (const value of param.values) {
      const label = value.displayName || value.value
      if (value === param.values[0] && !value.displayName) continue
      const id = uniqueSlug(label, used)
      variants[id] = { reasoningEffort: id }
    }
  }
  return Object.keys(variants).length > 0 ? variants : undefined
}

export function toConfigModel(model: CursorModelListItem): ConfigModel {
  const window = inferContext(model)
  const reasoning = inferReasoning(model)
  return {
    name: model.displayName || model.id,
    description: model.description,
    tool_call: true,
    reasoning,
    temperature: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: OPENCODE_CONTEXT, output: window >= 200_000 ? 128_000 : DEFAULT_OUTPUT },
    variants: variantMap(model),
  }
}

export function toConfigModels(
  models: CursorModelListItem[],
): Record<string, ConfigModel> {
  const out: Record<string, ConfigModel> = {}
  for (const model of models) {
    out[model.id] = toConfigModel(model)
  }
  return out
}

export const FALLBACK_MODELS: Record<string, ConfigModel> = {
  "composer-2.5": toConfigModel({
    id: "composer-2.5",
    displayName: "Composer 2.5",
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
  }),
  auto: toConfigModel({
    id: "auto",
    displayName: "Auto",
    description: "Let Cursor pick a model",
  }),
}

export function resolveModelSelection(
  catalog: CursorModelListItem[],
  modelId: string,
  reasoningEffort?: string,
): { id: string; params?: CursorParameterValue[] } {
  const found =
    catalog.find((model) => model.id === modelId) ??
    catalog.find((model) => model.aliases?.includes(modelId))

  if (!found) {
    const suffixed = matchSuffixedId(catalog, modelId)
    if (suffixed) return suffixed
    return { id: modelId }
  }

  if (reasoningEffort) {
    const fromVariant = variantParams(found, reasoningEffort)
    if (fromVariant) return { id: found.id, params: fromVariant }
    const fromParam = paramValue(found, reasoningEffort)
    if (fromParam) return { id: found.id, params: [fromParam] }
  } else {
    const defaults = found.variants?.find((variant) => variant.isDefault)
    if (defaults?.params?.length) return { id: found.id, params: defaults.params }
  }

  return { id: found.id }
}

function variantParams(
  model: CursorModelListItem,
  effort: string,
): CursorParameterValue[] | undefined {
  const wanted = slug(effort)
  const labeled = labeledVariants(model).find((item) => item.id === wanted)
  if (labeled) return labeled.variant.params
  const variant = (model.variants ?? []).find((item) => slug(item.displayName) === wanted)
  return variant?.params
}

function paramValue(
  model: CursorModelListItem,
  effort: string,
): CursorParameterValue | undefined {
  const wanted = slug(effort)
  for (const param of model.parameters ?? []) {
    if (slug(param.id) === wanted || slug(param.displayName ?? "") === wanted) {
      const preferred =
        param.values.find((value) => value.value === "true" || slug(value.displayName ?? "") === wanted) ??
        param.values[0]
      if (preferred) return { id: param.id, value: preferred.value }
    }
    for (const value of param.values) {
      if (slug(value.value) === wanted || slug(value.displayName ?? "") === wanted) {
        return { id: param.id, value: value.value }
      }
    }
  }
  return undefined
}

function matchSuffixedId(
  catalog: CursorModelListItem[],
  modelId: string,
): { id: string; params?: CursorParameterValue[] } | undefined {
  for (const model of catalog) {
    if (!modelId.startsWith(`${model.id}-`)) continue
    const suffix = modelId.slice(model.id.length + 1)
    const params = variantParams(model, suffix) ?? (paramValue(model, suffix) ? [paramValue(model, suffix)!] : undefined)
    return { id: model.id, params }
  }
  return undefined
}
