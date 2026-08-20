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

function defaultParams(model: CursorModelListItem): CursorParameterValue[] {
  return model.variants?.find((item) => item.isDefault)?.params ?? []
}

function deltaParts(
  params: CursorParameterValue[] | undefined,
  model: CursorModelListItem,
  defaults: CursorParameterValue[],
): string[] {
  const defaultMap = new Map(defaults.map((item) => [item.id, item.value]))
  const parts: string[] = []
  for (const param of params ?? []) {
    if (defaultMap.get(param.id) === param.value) continue
    if (param.value === "true") {
      const def = paramDef(model, param.id)
      parts.push(slug(def?.displayName || param.id))
      continue
    }
    if (param.value === "false") {
      const def = paramDef(model, param.id)
      parts.push(`${slug(def?.displayName || param.id)}-off`)
      continue
    }
    parts.push(slug(param.value))
  }
  return parts
}

function labeledVariants(
  model: CursorModelListItem,
): Array<{ id: string; variant: CursorVariant }> {
  const collide = displayNamesCollide(model)
  const defaults = defaultParams(model)
  const used = new Set<string>()
  const out: Array<{ id: string; variant: CursorVariant }> = []
  for (const variant of model.variants ?? []) {
    if (!collide && variant.isDefault) continue
    const label = collide
      ? deltaParts(variant.params, model, defaults).join("-")
      : variant.displayName
    if (!label || (!collide && slug(label) === "default")) continue
    out.push({ id: uniqueSlug(label, used), variant })
  }
  return out
}

function paramsKey(params: CursorParameterValue[] | undefined): string {
  return [...(params ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => `${item.id}=${item.value}`)
    .join("&")
}

function setParam(
  params: CursorParameterValue[] | undefined,
  id: string,
  value: string,
): CursorParameterValue[] {
  const next = [...(params ?? [])]
  const index = next.findIndex((item) => item.id === id)
  if (index >= 0) {
    next[index] = { id, value }
    return next
  }
  next.push({ id, value })
  return next
}

function getParam(params: CursorParameterValue[] | undefined, id: string): string | undefined {
  return params?.find((item) => item.id === id)?.value
}

function namedParam(model: CursorModelListItem, id: string, pattern: RegExp) {
  return (
    paramDef(model, id) ??
    model.parameters?.find(
      (item) => pattern.test(item.id) || pattern.test(item.displayName ?? ""),
    )
  )
}

function fastOnValue(model: CursorModelListItem): CursorParameterValue | undefined {
  const param = namedParam(model, "fast", /fast/i)
  const value =
    param?.values.find((item) => item.value === "true") ??
    param?.values.find((item) => slug(item.displayName ?? "") === "fast")
  if (!param || !value) return undefined
  return { id: param.id, value: value.value }
}

function maxContextValue(model: CursorModelListItem): CursorParameterValue | undefined {
  const param = namedParam(model, "context", /context/i)
  if (!param?.values.length) return undefined
  let best: { value: string; tokens: number } | undefined
  for (const item of param.values) {
    const tokens = parseContextValue(item.value)
    if (!best || tokens > best.tokens) best = { value: item.value, tokens }
  }
  if (!best || best.tokens <= 0) return undefined
  const smaller = param.values.some((item) => {
    const tokens = parseContextValue(item.value)
    return tokens > 0 && tokens < best!.tokens
  })
  if (!smaller) return undefined
  return { id: param.id, value: best.value }
}

function highEffortValue(model: CursorModelListItem): CursorParameterValue | undefined {
  const param = namedParam(model, "effort", /effort|reason|think/i)
  const value = param?.values.find(
    (item) => slug(item.value) === "high" || slug(item.displayName ?? "") === "high",
  )
  if (!param || !value) return undefined
  return { id: param.id, value: value.value }
}

function seedVariants(
  model: CursorModelListItem,
): Array<{ id: string; variant: CursorVariant }> {
  const labeled = labeledVariants(model)
  if (labeled.length > 0) return labeled
  const parameters = model.parameters ?? []
  if (parameters.length === 0) return []
  const param =
    parameters.find((item) => /effort|reason|think/i.test(item.id)) ?? parameters[0]
  const used = new Set<string>()
  const out: Array<{ id: string; variant: CursorVariant }> = []
  for (const value of param.values) {
    if (value === param.values[0] && !value.displayName) continue
    const label = value.displayName || value.value
    out.push({
      id: uniqueSlug(label, used),
      variant: {
        displayName: label,
        params: [{ id: param.id, value: value.value }],
      },
    })
  }
  return out
}

function opencodeVariants(
  model: CursorModelListItem,
): Array<{ id: string; variant: CursorVariant }> {
  const seeds = seedVariants(model)
  const used = new Set(seeds.map((item) => item.id))
  const seen = new Set(seeds.map((item) => paramsKey(item.variant.params)))
  const out = [...seeds]
  const defaults = model.variants?.find((item) => item.isDefault)
  const bases: Array<{ prefix?: string; params?: CursorParameterValue[] }> = seeds.map(
    (item) => ({
      prefix: item.id,
      params: item.variant.params,
    }),
  )
  if (defaults && !seen.has(paramsKey(defaults.params))) {
    bases.push({ params: defaults.params })
    seen.add(paramsKey(defaults.params))
  }

  const add = (hint: string, params: CursorParameterValue[], alias = false) => {
    const key = paramsKey(params)
    if (!alias && seen.has(key)) return
    if (alias) {
      const id = slug(hint)
      if (used.has(id)) return
      used.add(id)
      out.push({ id, variant: { params, displayName: hint } })
      return
    }
    seen.add(key)
    out.push({
      id: uniqueSlug(hint, used),
      variant: { params, displayName: hint },
    })
  }

  const fromDefault = (params: CursorParameterValue[] | undefined) =>
    Boolean(defaults && paramsKey(params) === paramsKey(defaults.params))

  const nameOf = (
    prefix: string | undefined,
    extra: string[],
    source: CursorParameterValue[] | undefined,
  ) => (fromDefault(source) || !prefix ? extra.join("-") : [prefix, ...extra].join("-"))

  const fast = fastOnValue(model)
  const maxCtx = maxContextValue(model)

  if (fast) {
    for (const base of bases) {
      if (getParam(base.params, fast.id) === fast.value) continue
      add(nameOf(base.prefix, ["fast"], base.params), setParam(base.params, fast.id, fast.value))
    }
  }
  if (maxCtx) {
    const ctxSlug = slug(maxCtx.value)
    for (const base of bases) {
      if (getParam(base.params, maxCtx.id) === maxCtx.value) continue
      add(
        nameOf(base.prefix, [ctxSlug], base.params),
        setParam(base.params, maxCtx.id, maxCtx.value),
      )
    }
  }
  if (fast && maxCtx) {
    const ctxSlug = slug(maxCtx.value)
    for (const base of bases) {
      if (getParam(base.params, fast.id) === fast.value) continue
      if (getParam(base.params, maxCtx.id) === maxCtx.value) continue
      add(
        nameOf(base.prefix, [ctxSlug, "fast"], base.params),
        setParam(setParam(base.params, maxCtx.id, maxCtx.value), fast.id, fast.value),
      )
    }
  }

  const high = highEffortValue(model)
  const baseParams = defaults?.params ?? []
  if (high && fast) {
    add("high-fast", setParam(setParam(baseParams, high.id, high.value), fast.id, fast.value), true)
  }
  return out
}

function variantMap(model: CursorModelListItem): ConfigModel["variants"] {
  const variants: NonNullable<ConfigModel["variants"]> = {}
  for (const { id } of opencodeVariants(model)) {
    variants[id] = { reasoningEffort: id }
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
    if (fromParam) {
      const base = found.variants?.find((variant) => variant.isDefault)?.params ?? []
      return { id: found.id, params: setParam(base, fromParam.id, fromParam.value) }
    }
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
  const labeled = opencodeVariants(model).find((item) => item.id === wanted)
  if (labeled) return labeled.variant.params
  if (wanted === "max" || wanted === "max-mode") {
    const maxCtx = maxContextValue(model)
    if (maxCtx) {
      const base = model.variants?.find((item) => item.isDefault)?.params ?? []
      return setParam(base, maxCtx.id, maxCtx.value)
    }
  }
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
