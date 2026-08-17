import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import type { Plugin } from "@opencode-ai/plugin"
import {
  FALLBACK_MODELS,
  toConfigModels,
  type CursorModelListItem,
} from "./models.js"
import { PACKAGE_MARKER } from "./options.js"
import { loadSdkRuntime, type CursorRuntime } from "./runtime.js"

type StoredAuth = { type?: string; key?: string }

export type CursorPluginDeps = {
  runtime?: CursorRuntime
  readApiKey?: (providerId: string) => Promise<string | undefined>
}

/**
 * The provider id whose `auth.json` slot holds the Cursor API key. Must match
 * the key used under `provider` in `opencode.json` (by convention `"cursor"`).
 */
export const DEFAULT_PROVIDER_ID = "cursor"

/**
 * OpenCode's `provider.models()` plugin hook only fires for providers that
 * are already present in its internal model database — which is seeded from
 * models.dev *before* the hook loop runs and only gets custom
 * `opencode.json` provider entries merged in *after* it. A provider that
 * isn't registered with models.dev — like this one — will never have its
 * `provider.models()` hook invoked.
 *
 * The `config()` hook runs earlier, before `Provider` reads `Config.get()`
 * at all, so mutating `config.provider[...].models` here is the only
 * currently-working way to inject dynamically discovered models for a fully
 * custom provider.
 *
 * The API key is read from the `/connect`-persisted credential store
 * (`~/.local/share/opencode/auth.json`), then `CURSOR_API_KEY` — never from
 * `options.apiKey` in `opencode.json`.
 */
export async function readStoredApiKey(providerId: string): Promise<string | undefined> {
  try {
    const dataHome =
      process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share")
    const authPath = join(dataHome, "opencode", "auth.json")
    const content = await readFile(authPath, "utf-8")
    const data = JSON.parse(content) as Record<string, unknown>
    const entry = data[providerId] as StoredAuth | undefined
    if (entry?.type === "api" && entry.key) return entry.key
    if (typeof (entry as { key?: string } | undefined)?.key === "string") {
      return (entry as { key: string }).key
    }
  } catch {
    // No stored credential yet.
  }
  return undefined
}

async function resolveApiKey(
  providerId: string,
  readApiKey: CursorPluginDeps["readApiKey"],
): Promise<string | undefined> {
  const stored = await (readApiKey ?? readStoredApiKey)(providerId)
  const env = process.env.CURSOR_API_KEY?.trim()
  return stored || env || undefined
}

export function isCursorProvider(npm: string | undefined): boolean {
  return typeof npm === "string" && npm.includes(PACKAGE_MARKER)
}

export function createCursorPlugin(deps: CursorPluginDeps = {}): Plugin {
  return async ({ directory }) => {
    return {
      auth: {
        provider: DEFAULT_PROVIDER_ID,
        methods: [
          {
            type: "oauth",
            label: "Log in with Cursor (browser)",
            async authorize() {
              const { Cursor } = await import("@cursor/sdk")
              let resolveUrl: (url: string) => void
              const urlPromise = new Promise<string>((resolve) => {
                resolveUrl = resolve
              })
              const login = Cursor.auth.login({
                openBrowser: true,
                store: null,
                apiKeyName: "OpenCode",
                onLoginUrl: (url: string) => resolveUrl(url),
              })
              const url = await urlPromise
              return {
                url,
                instructions:
                  "Finish signing in to Cursor in your browser. OpenCode will store the minted API key.",
                method: "auto" as const,
                async callback() {
                  try {
                    const result = await login
                    if (!result?.apiKey) return { type: "failed" as const }
                    return { type: "success" as const, key: result.apiKey }
                  } catch {
                    return { type: "failed" as const }
                  }
                },
              }
            },
          },
          {
            type: "api",
            label: "Cursor API Key",
            prompts: [
              {
                type: "text",
                key: "key",
                message: "Cursor API key",
                placeholder: "Paste a key from https://cursor.com/dashboard/api",
              },
            ],
            async authorize(inputs) {
              const key = inputs?.key?.trim()
              if (!key) return { type: "failed" as const }
              try {
                const runtime = deps.runtime ?? (await loadSdkRuntime())
                await runtime.listModels(key)
                return { type: "success" as const, key }
              } catch {
                return { type: "failed" as const }
              }
            },
          },
        ],
      },
      config: async (config) => {
        const providers = config.provider ?? {}
        for (const [providerId, providerConfig] of Object.entries(providers)) {
          const npm = providerConfig.npm ?? ""
          if (!isCursorProvider(npm)) continue

          const options = (providerConfig.options ?? {}) as Record<string, unknown>
          if (typeof options.cwd !== "string" || !options.cwd) {
            options.cwd = directory
            providerConfig.options = options
          }

          const hand = providerConfig.models ?? {}

          const apiKey = await resolveApiKey(providerId, deps.readApiKey)
          if (!apiKey) {
            if (Object.keys(hand).length === 0) providerConfig.models = { ...FALLBACK_MODELS }
            continue
          }

          try {
            const runtime = deps.runtime ?? (await loadSdkRuntime())
            const list = (await runtime.listModels(apiKey)) as CursorModelListItem[]
            providerConfig.models = {
              ...toConfigModels(list),
              ...hand,
            }
          } catch {
            if (Object.keys(hand).length === 0) providerConfig.models = { ...FALLBACK_MODELS }
          }
        }
      },
      "chat.headers": async (input, output) => {
        output.headers["x-session-id"] = input.sessionID
      },
    }
  }
}
