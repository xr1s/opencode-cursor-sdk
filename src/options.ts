export type CursorProviderOptions = {
  /**
   * Provider id, injected by OpenCode as `name`. Used as the AI SDK provider
   * name so model ids are reported as `<name>/<model>`.
   */
  name?: string
  /**
   * Cursor user API key or team service-account key, stored by OpenCode
   * `/connect`. Required at request time. Never put this in `opencode.json`.
   */
  apiKey: string
  /**
   * Working directory for the local Cursor agent. Defaults to `process.cwd()`.
   * OpenCode's plugin sets this to the current project directory.
   */
  cwd?: string
}

/** Dummy origin used by the in-process OpenAI-compatible adapter. Never resolved. */
export const CURSOR_LOCAL_BASE_URL = "http://opencode-cursor-sdk.invalid/v1"

export const PACKAGE_MARKER = "opencode-cursor-sdk"
