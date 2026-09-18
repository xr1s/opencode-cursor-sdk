import { slug, opencodeVariants } from "./variant-names.js"
import { parseContextValue } from "./catalog.js"
import type { CursorModelListItem, CursorParameterValue } from "./types.js"

export type CursorModelSelection = { id: string; params?: CursorParameterValue[] }

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

function parameterValue(model: CursorModelListItem, wanted: string): CursorParameterValue | undefined {
  for (const parameter of model.parameters ?? []) {
    if (slug(parameter.id) === wanted || slug(parameter.displayName ?? "") === wanted) {
      const value =
        parameter.values.find((item) => item.value === "true" || slug(item.displayName ?? "") === wanted) ??
        parameter.values[0]
      if (value) return { id: parameter.id, value: value.value }
    }
    for (const value of parameter.values) {
      if (slug(value.value) === wanted || slug(value.displayName ?? "") === wanted) {
        return { id: parameter.id, value: value.value }
      }
    }
  }
  return undefined
}

function variantParams(model: CursorModelListItem, effort: string): CursorParameterValue[] | undefined {
  const wanted = slug(effort)
  const generated = opencodeVariants(model, parseContextValue).find((item) => item.id === wanted)
  if (generated) return generated.variant.params
  if (wanted === "max" || wanted === "max-mode") {
    const parameter = model.parameters?.find((item) => /context/i.test(item.id) || /context/i.test(item.displayName ?? ""))
    const maximum = parameter?.values
      .map((item) => ({ item, tokens: parseContextValue(item.value) }))
      .sort((a, b) => b.tokens - a.tokens)[0]
    const defaults = model.variants?.find((item) => item.isDefault)?.params ?? []
    if (parameter && maximum?.tokens) return setParam(defaults, parameter.id, maximum.item.value)
  }
  return model.variants?.find((item) => slug(item.displayName) === wanted)?.params
}

function matchSuffixedId(model: CursorModelListItem, modelId: string): CursorModelSelection | undefined {
  if (!modelId.startsWith(`${model.id}-`)) return undefined
  const suffix = modelId.slice(model.id.length + 1)
  const direct = variantParams(model, suffix)
  const parameter = parameterValue(model, suffix)
  return { id: model.id, params: direct ?? (parameter ? [parameter] : undefined) }
}

export function resolveModelSelection(
  catalog: CursorModelListItem[],
  modelId: string,
  reasoningEffort?: string,
): CursorModelSelection {
  const found = catalog.find((model) => model.id === modelId) ?? catalog.find((model) => model.aliases?.includes(modelId))
  if (!found) {
    for (const model of catalog) {
      const suffixed = matchSuffixedId(model, modelId)
      if (suffixed) return suffixed
    }
    return { id: modelId }
  }

  if (reasoningEffort) {
    const variant = variantParams(found, reasoningEffort)
    if (variant) return { id: found.id, params: variant }
    const parameter = parameterValue(found, reasoningEffort)
    if (parameter) {
      const defaults = found.variants?.find((item) => item.isDefault)?.params ?? []
      return { id: found.id, params: setParam(defaults, parameter.id, parameter.value) }
    }
  } else {
    const defaults = found.variants?.find((item) => item.isDefault)?.params
    if (defaults?.length) {
      const fast = found.parameters?.find((item) => /fast/i.test(item.id) || /fast/i.test(item.displayName ?? ""))
      const disabled = fast?.values.find((item) => item.value === "false")
      return {
        id: found.id,
        params: disabled && fast ? setParam(defaults, fast.id, disabled.value) : defaults,
      }
    }
  }
  return { id: found.id }
}
