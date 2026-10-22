import type { CursorModelListItem, CursorParameterValue, ConfigModel } from "./types.js"

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
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix++
  const next = `${base}-${suffix}`
  used.add(next)
  return next
}

function parameter(model: CursorModelListItem, id: string) {
  return model.parameters?.find((item) => item.id === id)
}

function namedParameter(model: CursorModelListItem, pattern: RegExp) {
  return model.parameters?.find(
    (item) => pattern.test(item.id) || pattern.test(item.displayName ?? ""),
  )
}

function haveCollidingDisplayNames(model: CursorModelListItem): boolean {
  const names = (model.variants ?? []).map((item) => item.displayName)
  return names.length > 1 && new Set(names).size < names.length
}

function defaultParams(model: CursorModelListItem): CursorParameterValue[] {
  return model.variants?.find((item) => item.isDefault)?.params ?? []
}

function isFastParameter(model: CursorModelListItem, id: string): boolean {
  if (/fast/i.test(id)) return true
  return /fast/i.test(parameter(model, id)?.displayName ?? "")
}

function deltaParts(
  params: CursorParameterValue[] | undefined,
  model: CursorModelListItem,
  defaults: CursorParameterValue[],
): string[] {
  const defaultMap = new Map(defaults.map((item) => [item.id, item.value]))
  const parts: string[] = []
  for (const item of params ?? []) {
    if (isFastParameter(model, item.id)) {
      if (item.value === "true") parts.push("fast")
      continue
    }
    if (defaultMap.get(item.id) === item.value) continue
    if (item.value === "true") {
      parts.push(slug(parameter(model, item.id)?.displayName || item.id))
      continue
    }
    if (item.value === "false") {
      parts.push(`${slug(parameter(model, item.id)?.displayName || item.id)}-off`)
      continue
    }
    parts.push(slug(item.value))
  }
  return parts
}

function paramsKey(params: CursorParameterValue[] | undefined): string {
  return [...(params ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => `${item.id}=${item.value}`)
    .join("&")
}

function parameterVariantNames(
  model: CursorModelListItem,
): Array<{ id: string; variant: CursorVariant }> {
  const collide = haveCollidingDisplayNames(model)
  const defaults = defaultParams(model)
  const used = new Set<string>()
  const result: Array<{ id: string; variant: CursorVariant }> = []

  for (const variant of model.variants ?? []) {
    if (!collide && variant.isDefault) continue
    const label = collide
      ? deltaParts(variant.params, model, defaults).join("-")
      : variant.displayName
    if (!label || (!collide && slug(label) === "default")) continue
    result.push({ id: uniqueSlug(label, used), variant })
  }
  return result
}

function getParam(params: CursorParameterValue[] | undefined, id: string): string | undefined {
  return params?.find((item) => item.id === id)?.value
}

function setParam(
  params: CursorParameterValue[] | undefined,
  id: string,
  value: string,
): CursorParameterValue[] {
  const next = [...(params ?? [])]
  const index = next.findIndex((item) => item.id === id)
  if (index === -1) next.push({ id, value })
  else next[index] = { id, value }
  return next
}

function fastValue(model: CursorModelListItem): CursorParameterValue | undefined {
  const definition = namedParameter(model, /fast/i)
  const value = definition?.values.find(
    (item) => item.value === "true" || slug(item.displayName ?? "") === "fast",
  )
  return definition && value ? { id: definition.id, value: value.value } : undefined
}

function maxContextValue(
  model: CursorModelListItem,
  parseContext: (value: string) => number,
): CursorParameterValue | undefined {
  const definition = namedParameter(model, /context/i)
  if (!definition?.values.length) return undefined
  const values = definition.values
    .map((item) => ({ value: item.value, tokens: parseContext(item.value) }))
    .filter((item) => item.tokens > 0)
  const best = [...values].sort((a, b) => b.tokens - a.tokens)[0]
  if (!best || !values.some((item) => item.tokens < best.tokens)) return undefined
  return { id: definition.id, value: best.value }
}

function highEffortValue(model: CursorModelListItem): CursorParameterValue | undefined {
  const definition = namedParameter(model, /effort|reason|think/i)
  const value = definition?.values.find(
    (item) => slug(item.value) === "high" || slug(item.displayName ?? "") === "high",
  )
  return definition && value ? { id: definition.id, value: value.value } : undefined
}

function seedVariants(model: CursorModelListItem): Array<{ id: string; variant: CursorVariant }> {
  const labeled = parameterVariantNames(model)
  if (labeled.length > 0) return labeled
  const definition =
    model.parameters?.find((item) => /effort|reason|think/i.test(item.id)) ?? model.parameters?.[0]
  if (!definition) return []
  const used = new Set<string>()
  return definition.values.flatMap((value, index) => {
    if (index === 0 && !value.displayName) return []
    const label = value.displayName || value.value
    return [{
      id: uniqueSlug(label, used),
      variant: { displayName: label, params: [{ id: definition.id, value: value.value }] },
    }]
  })
}

export function opencodeVariants(
  model: CursorModelListItem,
  parseContext: (value: string) => number,
): Array<{ id: string; variant: CursorVariant }> {
  const seeds = seedVariants(model)
  const used = new Set(seeds.map((item) => item.id))
  const seen = new Set(seeds.map((item) => paramsKey(item.variant.params)))
  const result = [...seeds]
  const defaults = model.variants?.find((item) => item.isDefault)
  const bases = seeds.map((item) => ({ prefix: item.id, params: item.variant.params }))
  if (defaults && !seen.has(paramsKey(defaults.params))) {
    bases.push({ prefix: "", params: defaults.params })
    seen.add(paramsKey(defaults.params))
  }

  const add = (hint: string, params: CursorParameterValue[], alias = false) => {
    const key = paramsKey(params)
    if (!alias && seen.has(key)) return
    const id = slug(hint)
    if (alias && used.has(id)) return
    if (alias) used.add(id)
    else seen.add(key)
    result.push({ id: alias ? id : uniqueSlug(hint, used), variant: { params, displayName: hint } })
  }

  const isDefault = (params: CursorParameterValue[] | undefined) =>
    Boolean(defaults && paramsKey(params) === paramsKey(defaults.params))
  const name = (prefix: string | undefined, suffix: string, source: CursorParameterValue[] | undefined) =>
    isDefault(source) || !prefix ? suffix : `${prefix}-${suffix}`

  const fast = fastValue(model)
  const context = maxContextValue(model, parseContext)
  if (fast) {
    for (const base of bases) {
      if (getParam(base.params, fast.id) !== fast.value) {
        add(name(base.prefix, "fast", base.params), setParam(base.params, fast.id, fast.value))
      }
    }
  }
  if (context) {
    const suffix = slug(context.value)
    for (const base of bases) {
      if (getParam(base.params, context.id) !== context.value) {
        add(name(base.prefix, suffix, base.params), setParam(base.params, context.id, context.value))
      }
    }
  }
  if (fast && context) {
    const suffix = slug(context.value)
    for (const base of bases) {
      if (
        getParam(base.params, fast.id) !== fast.value &&
        getParam(base.params, context.id) !== context.value
      ) {
        add(
          name(base.prefix, `${suffix}-fast`, base.params),
          setParam(setParam(base.params, context.id, context.value), fast.id, fast.value),
        )
      }
    }
  }

  const high = highEffortValue(model)
  const baseParams = defaults?.params ?? []
  if (high && fast) add("high-fast", setParam(setParam(baseParams, high.id, high.value), fast.id, fast.value), true)
  return result
}

export function variantMap(
  model: CursorModelListItem,
  parseContext: (value: string) => number,
): ConfigModel["variants"] {
  const variants: NonNullable<ConfigModel["variants"]> = {}
  for (const { id } of opencodeVariants(model, parseContext)) variants[id] = { reasoningEffort: id }
  return Object.keys(variants).length > 0 ? variants : undefined
}
