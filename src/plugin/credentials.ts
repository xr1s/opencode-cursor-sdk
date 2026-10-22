import { Credential, Integration, type Plugin } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import { CURSOR_OAUTH_METHOD_ID, CURSOR_PROVIDER_NAME } from "./identifiers.js"

export function registerCursorCredentials(
  editor: Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0],
  providerIDs: readonly string[],
): void {
  for (const providerID of providerIDs) {
    editor.update(providerID, (integration) => {
      integration.name = CURSOR_PROVIDER_NAME
    })
    editor.method.update({
      integrationID: Integration.ID.make(providerID),
      method: { type: "key", label: "Cursor API key" },
    })
    editor.method.update(cursorOAuth(providerID))
  }
}

function cursorOAuth(providerID: string): IntegrationOAuthMethodRegistration {
  const methodID = Integration.MethodID.make(CURSOR_OAUTH_METHOD_ID)
  return {
    integrationID: Integration.ID.make(providerID),
    method: { id: methodID, type: "oauth", label: "Log in with Cursor (browser)" },
    async authorize() {
      const { Cursor } = await import("@cursor/sdk")
      let resolveURL!: (url: string) => void
      const url = new Promise<string>((resolve) => { resolveURL = resolve })
      const login = Cursor.auth.login({
        openBrowser: true,
        store: null,
        apiKeyName: "OpenCode",
        onLoginUrl: resolveURL,
      })
      return {
        url: await url,
        instructions: "Finish signing in to Cursor in your browser. OpenCode will store the minted API key.",
        mode: "auto" as const,
        callback: login.then((result) => {
          if (!result?.apiKey) throw new Error("Cursor did not return an API key")
          const expires =
            typeof result.apiKeyExpiresAtMs === "number" && Number.isFinite(result.apiKeyExpiresAtMs)
              ? Math.floor(result.apiKeyExpiresAtMs)
              : Date.now() + 90 * 24 * 60 * 60 * 1000
          return Credential.OAuth.make({
            type: "oauth",
            methodID,
            access: result.apiKey,
            refresh: result.apiKey,
            expires,
          })
        }),
      }
    },
  }
}

export async function resolveCursorCredential(
  ctx: Plugin.Context,
  providerID: string,
): Promise<string | undefined> {
  const connection = await ctx.integration.connection.active(Integration.ID.make(providerID))
  if (connection) {
    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type === "key") return credential.key
    if (credential?.type === "oauth") return credential.access
  }
  return process.env.CURSOR_API_KEY?.trim() || undefined
}
