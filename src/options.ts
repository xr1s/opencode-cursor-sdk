export type CursorProviderOptions = {
  /**
   * Provider id, injected by OpenCode as `name`. Used as the AI SDK provider
   * name so model ids are reported as `<name>/<model>`.
   */
  name?: string
  /**
   * Cursor user API key or team service-account key, supplied by the V2
   * integration at request time. Never put this in `opencode.json`.
   */
  apiKey: string
  /**
   * Working directory for the local Cursor agent. Defaults to `process.cwd()`.
   * OpenCode's plugin sets this to the current project directory.
   */
  cwd?: string
}
