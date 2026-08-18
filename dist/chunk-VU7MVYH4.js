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
function paramVariantLabel(variant, model) {
  const parts = [];
  for (const param of variant.params ?? []) {
    const def = paramDef(model, param.id);
    const value = def?.values.find((item) => item.value === param.value);
    if (value?.displayName) {
      parts.push(value.displayName);
      continue;
    }
    if (param.value === "true") {
      parts.push(def?.displayName || param.id);
      continue;
    }
    if (param.value === "false") continue;
    parts.push(param.value);
  }
  if (parts.length === 0) {
    const off = (variant.params ?? []).find((param) => param.value === "false");
    if (off) {
      const def = paramDef(model, off.id);
      return `${def?.displayName || off.id} off`;
    }
    return variant.displayName;
  }
  return parts.join(" ");
}
function displayNamesCollide(model) {
  const names = (model.variants ?? []).map((item) => item.displayName);
  return names.length > 1 && new Set(names).size < names.length;
}
function labeledVariants(model) {
  const collide = displayNamesCollide(model);
  const used = /* @__PURE__ */ new Set();
  const out = [];
  for (const variant of model.variants ?? []) {
    if (!collide && variant.isDefault) continue;
    const label = collide ? paramVariantLabel(variant, model) : variant.displayName;
    if (!collide && slug(label) === "default") continue;
    out.push({ id: uniqueSlug(label, used), variant });
  }
  return out;
}
function variantMap(model) {
  const variants = {};
  const used = /* @__PURE__ */ new Set();
  for (const { id } of labeledVariants(model)) {
    used.add(id);
    variants[id] = { reasoningEffort: id };
  }
  if (Object.keys(variants).length === 0 && (model.parameters?.length ?? 0) > 0) {
    const param = model.parameters.find((item) => /effort|reason|think/i.test(item.id)) ?? model.parameters[0];
    for (const value of param.values) {
      const label = value.displayName || value.value;
      if (value === param.values[0] && !value.displayName) continue;
      const id = uniqueSlug(label, used);
      variants[id] = { reasoningEffort: id };
    }
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
    if (fromParam) return { id: found.id, params: [fromParam] };
  } else {
    const defaults = found.variants?.find((variant) => variant.isDefault);
    if (defaults?.params?.length) return { id: found.id, params: defaults.params };
  }
  return { id: found.id };
}
function variantParams(model, effort) {
  const wanted = slug(effort);
  const labeled = labeledVariants(model).find((item) => item.id === wanted);
  if (labeled) return labeled.variant.params;
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
  loadSdkRuntime,
  CURSOR_LOCAL_BASE_URL,
  PACKAGE_MARKER
};
