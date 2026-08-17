import * as _ai_sdk_openai_compatible from '@ai-sdk/openai-compatible';

type CursorProviderOptions = {
    /**
     * Provider id, injected by OpenCode as `name`. Used as the AI SDK provider
     * name so model ids are reported as `<name>/<model>`.
     */
    name?: string;
    /**
     * Cursor user API key or team service-account key, stored by OpenCode
     * `/connect`. Required at request time. Never put this in `opencode.json`.
     */
    apiKey: string;
    /**
     * Working directory for the local Cursor agent. Defaults to `process.cwd()`.
     * OpenCode's plugin sets this to the current project directory.
     */
    cwd?: string;
};

/**
 * OpenCode loads external providers by calling the package's first export whose
 * name starts with "create", passing the provider id as `name` plus the
 * configured `options` (including the `/connect` API key).
 */
declare function createCursor(options: CursorProviderOptions): _ai_sdk_openai_compatible.OpenAICompatibleProvider<string, string, string, string>;

export { type CursorProviderOptions, createCursor };
