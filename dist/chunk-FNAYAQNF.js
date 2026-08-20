// src/runtime.ts
function toolsToCustomTools(tools, execute) {
  if (!tools?.length) return void 0;
  const out = {};
  for (const tool of tools) {
    const name = tool.function?.name;
    if (!name) continue;
    out[name] = {
      description: tool.function.description,
      inputSchema: tool.function.parameters,
      execute: execute(name)
    };
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
var defaultRuntime;
function setDefaultRuntime(runtime) {
  defaultRuntime = runtime;
}
function getDefaultRuntime() {
  if (defaultRuntime) return defaultRuntime;
  throw new Error("Cursor runtime is not configured");
}
function errorMessageOf(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    return String(error.message ?? error);
  }
  return String(error);
}
function isMissingAgentError(error) {
  return /not found/i.test(errorMessageOf(error));
}
function isAuthError(error) {
  const name = error instanceof Error ? error.name : typeof error === "object" && error && "errorName" in error ? String(error.errorName ?? "") : "";
  if (name === "AuthenticationError") return true;
  return /authentication error|unauthenticated|try logging out and back in/i.test(
    errorMessageOf(error)
  );
}
function isTransientNetworkError(error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code ?? "") : "";
  return /premature close|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|ERR_STREAM|NGHTTP2|http\/2 stream|ERR_HTTP2|connection aborted|protocol error|session closed with error/i.test(
    `${code} ${errorMessageOf(error)}`
  );
}
function isRetryableAgentError(error) {
  return isAuthError(error) || isTransientNetworkError(error);
}
async function loadSdkRuntime() {
  const { Agent, Cursor } = await import("@cursor/sdk");
  return {
    async listModels(apiKey) {
      return await Cursor.models.list({ apiKey });
    },
    async createAgent(input) {
      return wrapSdkAgent(
        await Agent.create({
          apiKey: input.apiKey,
          model: input.model,
          agentId: input.agentId,
          tools: input.mcp ? ["mcp"] : [],
          local: { cwd: input.cwd }
        })
      );
    },
    async resumeAgent(agentId, input) {
      return wrapSdkAgent(
        await Agent.resume(agentId, {
          apiKey: input.apiKey,
          model: input.model,
          tools: input.mcp ? ["mcp"] : [],
          local: { cwd: input.cwd }
        })
      );
    }
  };
}
function wrapSdkAgent(agent) {
  return {
    agentId: agent.agentId,
    async send(sendInput) {
      const run = await agent.send(
        sendInput.images?.length ? { text: sendInput.text, images: sendInput.images } : sendInput.text,
        {
          onDelta: sendInput.onDelta ? ({ update }) => sendInput.onDelta?.(update) : void 0,
          local: {
            force: sendInput.force,
            customTools: sendInput.customTools
          }
        }
      );
      return {
        wait: () => run.wait(),
        cancel: async () => {
          if (run.supports?.("cancel")) await run.cancel();
        }
      };
    },
    async dispose() {
      await agent[Symbol.asyncDispose]();
    }
  };
}

// src/options.ts
var CURSOR_LOCAL_BASE_URL = "http://opencode-cursor-sdk.invalid/v1";
var PACKAGE_MARKER = "opencode-cursor-sdk";

// src/models.ts
var DEFAULT_CONTEXT = 128e3;
var DEFAULT_OUTPUT = 65536;
var OPENCODE_CONTEXT = 1e8;
var KNOWN_CONTEXT = [
  [/^grok-4\.[56](?:$|-)/, 5e5],
  [/^gpt-5\.4-(?:mini|nano)(?:$|-)/, 4e5],
  [/^gpt-5-mini(?:$|-)/, 4e5],
  [/^claude-haiku-4-5(?:$|-)/, 2e5]
];
function slug(value) {
  const slugified = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slugified || "variant";
}
function uniqueSlug(value, used) {
  const base = slug(value);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  const next = `${base}-${i}`;
  used.add(next);
  return next;
}
function knownContext(model) {
  const ids = [model.id, ...model.aliases ?? []];
  for (const id of ids) {
    for (const [pattern, tokens] of KNOWN_CONTEXT) {
      if (pattern.test(id)) return tokens;
    }
  }
  return 0;
}
function inferContext(model) {
  const param = model.parameters?.find(
    (item) => /context/i.test(item.id) || /context/i.test(item.displayName ?? "")
  );
  const values = param?.values.map((item) => item.value) ?? [];
  let best = 0;
  for (const value of values) {
    const tokens = parseContextValue(value);
    if (tokens > best) best = tokens;
  }
  return best || knownContext(model) || DEFAULT_CONTEXT;
}
function parseContextValue(value) {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value.trim());
  if (!match) return 0;
  const n = Number(match[1]);
  const suffix = (match[2] ?? "").toLowerCase();
  if (suffix === "m") return Math.round(n * 1e6);
  if (suffix === "k") return Math.round(n * 1e3);
  return Math.round(n);
}
function inferReasoning(model) {
  if (model.parameters?.some((param) => /reason|think|effort/i.test(param.id))) return true;
  if (model.variants?.some((variant) => /reason|think|max|high/i.test(variant.displayName))) {
    return true;
  }
  return /composer|gpt-5|claude|opus|sonnet|o[1-9]|gemini-3|grok/i.test(model.id);
}
function paramDef(model, id) {
  return model.parameters?.find((item) => item.id === id);
}
function displayNamesCollide(model) {
  const names = (model.variants ?? []).map((item) => item.displayName);
  return names.length > 1 && new Set(names).size < names.length;
}
function defaultParams(model) {
  return model.variants?.find((item) => item.isDefault)?.params ?? [];
}
function deltaParts(params, model, defaults) {
  const defaultMap = new Map(defaults.map((item) => [item.id, item.value]));
  const parts = [];
  for (const param of params ?? []) {
    if (defaultMap.get(param.id) === param.value) continue;
    if (param.value === "true") {
      const def = paramDef(model, param.id);
      parts.push(slug(def?.displayName || param.id));
      continue;
    }
    if (param.value === "false") {
      const def = paramDef(model, param.id);
      parts.push(`${slug(def?.displayName || param.id)}-off`);
      continue;
    }
    parts.push(slug(param.value));
  }
  return parts;
}
function labeledVariants(model) {
  const collide = displayNamesCollide(model);
  const defaults = defaultParams(model);
  const used = /* @__PURE__ */ new Set();
  const out = [];
  for (const variant of model.variants ?? []) {
    if (!collide && variant.isDefault) continue;
    const label = collide ? deltaParts(variant.params, model, defaults).join("-") : variant.displayName;
    if (!label || !collide && slug(label) === "default") continue;
    out.push({ id: uniqueSlug(label, used), variant });
  }
  return out;
}
function paramsKey(params) {
  return [...params ?? []].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((item) => `${item.id}=${item.value}`).join("&");
}
function setParam(params, id, value) {
  const next = [...params ?? []];
  const index = next.findIndex((item) => item.id === id);
  if (index >= 0) {
    next[index] = { id, value };
    return next;
  }
  next.push({ id, value });
  return next;
}
function getParam(params, id) {
  return params?.find((item) => item.id === id)?.value;
}
function namedParam(model, id, pattern) {
  return paramDef(model, id) ?? model.parameters?.find(
    (item) => pattern.test(item.id) || pattern.test(item.displayName ?? "")
  );
}
function fastOnValue(model) {
  const param = namedParam(model, "fast", /fast/i);
  const value = param?.values.find((item) => item.value === "true") ?? param?.values.find((item) => slug(item.displayName ?? "") === "fast");
  if (!param || !value) return void 0;
  return { id: param.id, value: value.value };
}
function maxContextValue(model) {
  const param = namedParam(model, "context", /context/i);
  if (!param?.values.length) return void 0;
  let best;
  for (const item of param.values) {
    const tokens = parseContextValue(item.value);
    if (!best || tokens > best.tokens) best = { value: item.value, tokens };
  }
  if (!best || best.tokens <= 0) return void 0;
  const smaller = param.values.some((item) => {
    const tokens = parseContextValue(item.value);
    return tokens > 0 && tokens < best.tokens;
  });
  if (!smaller) return void 0;
  return { id: param.id, value: best.value };
}
function highEffortValue(model) {
  const param = namedParam(model, "effort", /effort|reason|think/i);
  const value = param?.values.find(
    (item) => slug(item.value) === "high" || slug(item.displayName ?? "") === "high"
  );
  if (!param || !value) return void 0;
  return { id: param.id, value: value.value };
}
function seedVariants(model) {
  const labeled = labeledVariants(model);
  if (labeled.length > 0) return labeled;
  const parameters = model.parameters ?? [];
  if (parameters.length === 0) return [];
  const param = parameters.find((item) => /effort|reason|think/i.test(item.id)) ?? parameters[0];
  const used = /* @__PURE__ */ new Set();
  const out = [];
  for (const value of param.values) {
    if (value === param.values[0] && !value.displayName) continue;
    const label = value.displayName || value.value;
    out.push({
      id: uniqueSlug(label, used),
      variant: {
        displayName: label,
        params: [{ id: param.id, value: value.value }]
      }
    });
  }
  return out;
}
function opencodeVariants(model) {
  const seeds = seedVariants(model);
  const used = new Set(seeds.map((item) => item.id));
  const seen = new Set(seeds.map((item) => paramsKey(item.variant.params)));
  const out = [...seeds];
  const defaults = model.variants?.find((item) => item.isDefault);
  const bases = seeds.map(
    (item) => ({
      prefix: item.id,
      params: item.variant.params
    })
  );
  if (defaults && !seen.has(paramsKey(defaults.params))) {
    bases.push({ params: defaults.params });
    seen.add(paramsKey(defaults.params));
  }
  const add = (hint, params, alias = false) => {
    const key = paramsKey(params);
    if (!alias && seen.has(key)) return;
    if (alias) {
      const id = slug(hint);
      if (used.has(id)) return;
      used.add(id);
      out.push({ id, variant: { params, displayName: hint } });
      return;
    }
    seen.add(key);
    out.push({
      id: uniqueSlug(hint, used),
      variant: { params, displayName: hint }
    });
  };
  const fromDefault = (params) => Boolean(defaults && paramsKey(params) === paramsKey(defaults.params));
  const nameOf = (prefix, extra, source) => fromDefault(source) || !prefix ? extra.join("-") : [prefix, ...extra].join("-");
  const fast = fastOnValue(model);
  const maxCtx = maxContextValue(model);
  if (fast) {
    for (const base of bases) {
      if (getParam(base.params, fast.id) === fast.value) continue;
      add(nameOf(base.prefix, ["fast"], base.params), setParam(base.params, fast.id, fast.value));
    }
  }
  if (maxCtx) {
    const ctxSlug = slug(maxCtx.value);
    for (const base of bases) {
      if (getParam(base.params, maxCtx.id) === maxCtx.value) continue;
      add(
        nameOf(base.prefix, [ctxSlug], base.params),
        setParam(base.params, maxCtx.id, maxCtx.value)
      );
    }
  }
  if (fast && maxCtx) {
    const ctxSlug = slug(maxCtx.value);
    for (const base of bases) {
      if (getParam(base.params, fast.id) === fast.value) continue;
      if (getParam(base.params, maxCtx.id) === maxCtx.value) continue;
      add(
        nameOf(base.prefix, [ctxSlug, "fast"], base.params),
        setParam(setParam(base.params, maxCtx.id, maxCtx.value), fast.id, fast.value)
      );
    }
  }
  const high = highEffortValue(model);
  const baseParams = defaults?.params ?? [];
  if (high && fast) {
    add("high-fast", setParam(setParam(baseParams, high.id, high.value), fast.id, fast.value), true);
  }
  return out;
}
function variantMap(model) {
  const variants = {};
  for (const { id } of opencodeVariants(model)) {
    variants[id] = { reasoningEffort: id };
  }
  return Object.keys(variants).length > 0 ? variants : void 0;
}
function toConfigModel(model) {
  const window = inferContext(model);
  const reasoning = inferReasoning(model);
  return {
    name: model.displayName || model.id,
    description: model.description,
    tool_call: true,
    reasoning,
    temperature: false,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: OPENCODE_CONTEXT, output: window >= 2e5 ? 128e3 : DEFAULT_OUTPUT },
    variants: variantMap(model)
  };
}
function toConfigModels(models) {
  const out = {};
  for (const model of models) {
    out[model.id] = toConfigModel(model);
  }
  return out;
}
var FALLBACK_MODELS = {
  "composer-2.5": toConfigModel({
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [
      {
        id: "fast",
        displayName: "Fast",
        values: [{ value: "false" }, { value: "true", displayName: "Fast" }]
      }
    ],
    variants: [
      { displayName: "Default", isDefault: true, params: [{ id: "fast", value: "false" }] },
      { displayName: "Fast", params: [{ id: "fast", value: "true" }] }
    ]
  }),
  auto: toConfigModel({
    id: "auto",
    displayName: "Auto",
    description: "Let Cursor pick a model"
  })
};
function resolveModelSelection(catalog, modelId, reasoningEffort) {
  const found = catalog.find((model) => model.id === modelId) ?? catalog.find((model) => model.aliases?.includes(modelId));
  if (!found) {
    const suffixed = matchSuffixedId(catalog, modelId);
    if (suffixed) return suffixed;
    return { id: modelId };
  }
  if (reasoningEffort) {
    const fromVariant = variantParams(found, reasoningEffort);
    if (fromVariant) return { id: found.id, params: fromVariant };
    const fromParam = paramValue(found, reasoningEffort);
    if (fromParam) {
      const base = found.variants?.find((variant) => variant.isDefault)?.params ?? [];
      return { id: found.id, params: setParam(base, fromParam.id, fromParam.value) };
    }
  } else {
    const defaults = found.variants?.find((variant) => variant.isDefault);
    if (defaults?.params?.length) return { id: found.id, params: defaults.params };
  }
  return { id: found.id };
}
function variantParams(model, effort) {
  const wanted = slug(effort);
  const labeled = opencodeVariants(model).find((item) => item.id === wanted);
  if (labeled) return labeled.variant.params;
  if (wanted === "max" || wanted === "max-mode") {
    const maxCtx = maxContextValue(model);
    if (maxCtx) {
      const base = model.variants?.find((item) => item.isDefault)?.params ?? [];
      return setParam(base, maxCtx.id, maxCtx.value);
    }
  }
  const variant = (model.variants ?? []).find((item) => slug(item.displayName) === wanted);
  return variant?.params;
}
function paramValue(model, effort) {
  const wanted = slug(effort);
  for (const param of model.parameters ?? []) {
    if (slug(param.id) === wanted || slug(param.displayName ?? "") === wanted) {
      const preferred = param.values.find((value) => value.value === "true" || slug(value.displayName ?? "") === wanted) ?? param.values[0];
      if (preferred) return { id: param.id, value: preferred.value };
    }
    for (const value of param.values) {
      if (slug(value.value) === wanted || slug(value.displayName ?? "") === wanted) {
        return { id: param.id, value: value.value };
      }
    }
  }
  return void 0;
}
function matchSuffixedId(catalog, modelId) {
  for (const model of catalog) {
    if (!modelId.startsWith(`${model.id}-`)) continue;
    const suffix = modelId.slice(model.id.length + 1);
    const params = variantParams(model, suffix) ?? (paramValue(model, suffix) ? [paramValue(model, suffix)] : void 0);
    return { id: model.id, params };
  }
  return void 0;
}

export {
  toConfigModels,
  FALLBACK_MODELS,
  resolveModelSelection,
  toolsToCustomTools,
  setDefaultRuntime,
  getDefaultRuntime,
  isMissingAgentError,
  isAuthError,
  isRetryableAgentError,
  loadSdkRuntime,
  CURSOR_LOCAL_BASE_URL,
  PACKAGE_MARKER
};
