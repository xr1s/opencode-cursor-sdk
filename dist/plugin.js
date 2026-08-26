import {
  FALLBACK_MODELS,
  PACKAGE_MARKER,
  loadSdkRuntime,
  toConfigModels
} from "./chunk-U54BL6GB.js";

// src/plugin-core.ts
import { homedir } from "os";
import { join } from "path";
import { readFile } from "fs/promises";
var DEFAULT_PROVIDER_ID = "cursor";
async function readStoredApiKey(providerId) {
  try {
    const dataHome = process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share");
    const authPath = join(dataHome, "opencode", "auth.json");
    const content = await readFile(authPath, "utf-8");
    const data = JSON.parse(content);
    const entry = data[providerId];
    if (entry?.type === "api" && entry.key) return entry.key;
    if (typeof entry?.key === "string") {
      return entry.key;
    }
  } catch {
  }
  return void 0;
}
async function resolveApiKey(providerId, readApiKey) {
  const stored = await (readApiKey ?? readStoredApiKey)(providerId);
  const env = process.env.CURSOR_API_KEY?.trim();
  return stored || env || void 0;
}
function isCursorProvider(npm) {
  return typeof npm === "string" && npm.includes(PACKAGE_MARKER);
}
function createCursorPlugin(deps = {}) {
  return async ({ directory }) => {
    return {
      auth: {
        provider: DEFAULT_PROVIDER_ID,
        methods: [
          {
            type: "oauth",
            label: "Log in with Cursor (browser)",
            async authorize() {
              const { Cursor } = await import("@cursor/sdk");
              let resolveUrl;
              const urlPromise = new Promise((resolve) => {
                resolveUrl = resolve;
              });
              const login = Cursor.auth.login({
                openBrowser: true,
                store: null,
                apiKeyName: "OpenCode",
                onLoginUrl: (url2) => resolveUrl(url2)
              });
              const url = await urlPromise;
              return {
                url,
                instructions: "Finish signing in to Cursor in your browser. OpenCode will store the minted API key.",
                method: "auto",
                async callback() {
                  try {
                    const result = await login;
                    if (!result?.apiKey) return { type: "failed" };
                    return { type: "success", key: result.apiKey };
                  } catch {
                    return { type: "failed" };
                  }
                }
              };
            }
          },
          {
            type: "api",
            label: "Cursor API Key",
            prompts: [
              {
                type: "text",
                key: "key",
                message: "Cursor API key",
                placeholder: "Paste a key from https://cursor.com/dashboard/api"
              }
            ],
            async authorize(inputs) {
              const key = inputs?.key?.trim();
              if (!key) return { type: "failed" };
              try {
                const runtime = deps.runtime ?? await loadSdkRuntime();
                await runtime.listModels(key);
                return { type: "success", key };
              } catch {
                return { type: "failed" };
              }
            }
          }
        ]
      },
      config: async (config) => {
        const providers = config.provider ?? {};
        for (const [providerId, providerConfig] of Object.entries(providers)) {
          const npm = providerConfig.npm ?? "";
          if (!isCursorProvider(npm)) continue;
          const options = providerConfig.options ?? {};
          if (typeof options.cwd !== "string" || !options.cwd) {
            options.cwd = directory;
            providerConfig.options = options;
          }
          const hand = providerConfig.models ?? {};
          const apiKey = await resolveApiKey(providerId, deps.readApiKey);
          if (!apiKey) {
            if (Object.keys(hand).length === 0) providerConfig.models = { ...FALLBACK_MODELS };
            continue;
          }
          try {
            const runtime = deps.runtime ?? await loadSdkRuntime();
            const list = await runtime.listModels(apiKey);
            providerConfig.models = {
              ...toConfigModels(list),
              ...hand
            };
          } catch {
            if (Object.keys(hand).length === 0) providerConfig.models = { ...FALLBACK_MODELS };
          }
        }
      },
      "chat.headers": async (input, output) => {
        output.headers["x-session-id"] = input.sessionID;
      }
    };
  };
}

// src/plugin.ts
var CursorModelDiscovery = createCursorPlugin();
var plugin_default = CursorModelDiscovery;
export {
  CursorModelDiscovery,
  plugin_default as default
};
