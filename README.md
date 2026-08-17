# opencode-cursor-sdk

An OpenCode provider that uses your Cursor subscription through the official
[`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) TypeScript SDK. No local
HTTP proxy is involved.

Cursor's SDK is an **agent runtime**, not a raw chat-completions API. This
package still plugs into OpenCode as a model provider: OpenCode keeps its own
agent loop and tools, and Cursor-hosted models are exposed as an
OpenAI-compatible backend. Built-in Cursor filesystem/shell tools are disabled;
OpenCode's tools are registered as Cursor custom tools and held until OpenCode
executes them.

`apiKey` is required and throws if missing. **You never write `apiKey`
yourself**: OpenCode injects it at startup from whatever you stored via
`/connect`.

## Architecture

This package ships two pieces that OpenCode loads independently: a **provider
factory** (`src/index.ts`) and a **plugin** (`src/plugin.ts`).

```
                    ┌────────────────────────────────┐
                    │ provider: "cursor"             │
                    │ plugin: ["opencode-cursor-sdk"]    │
                    └───────────────┬────────────────┘
                                    │ OpenCode startup
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │ plugin.ts  auth + config()               │
                    │ /connect → Cursor API key                │
                    │ Cursor.models.list() → provider.models   │
                    └───────────────┬──────────────────────────┘
                                    │
                                    ▼
                    createCursor() → @ai-sdk/openai-compatible
                                    │ in-process fetch
                                    ▼
                    local Cursor Agent (no built-in tools)
                    + hold-mode bridge for OpenCode tools
```

| Piece | Role |
| --- | --- |
| `src/index.ts` `createCursor()` | OpenCode's `create*` provider factory. Wraps `@ai-sdk/openai-compatible` with an in-process `fetch` that never hits the network. |
| `src/plugin.ts` | Registers `/connect` (browser login or API key) and discovers models via `Cursor.models.list()`. |

The `npm` field is what actually talks to Cursor. The plugin is optional for a
hand-written `models` map, but it is what makes `/connect` show **Cursor** and
fills `/models` from your account.

## Setup

Requires **Node.js >= 22.13** (`@cursor/sdk`'s own minimum).

Add this package to your OpenCode config (merge into existing `provider` /
`plugin` keys if you already have some):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "npm": "opencode-cursor-sdk",
      "name": "Cursor",
      "models": {},
      "options": {}
    }
  },
  "plugin": ["opencode-cursor-sdk"]
}
```

The `plugin` entry must be the exact same string as `provider.npm` — not a
`/plugin` or `/server` suffix. OpenCode resolves the plugin entry point
itself from this package's `exports["./server"]` field once it's installed.

Installing from a git URL instead of npm also works. Prefix the specifier
with the package name (`opencode-cursor-sdk@git+https://github.com/<user>/<repo>.git`)
so OpenCode can reuse the cached install. npm 12+ defaults to
`allow-git=none`; if you use a git specifier, run
`npm config --global set allow-git all` first or OpenCode's installer will
silently install an empty package.

Then run OpenCode's `/connect`, select **Cursor**, and either:

1. **Log in with Cursor (browser)** — mints a user API key (90 days) via
   `Cursor.auth.login()`, or
2. **Cursor API Key** — paste a key from
   [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).

OpenCode stores this in `~/.local/share/opencode/auth.json` and, at startup,
passes it to the provider factory as `apiKey`. You can also set
`CURSOR_API_KEY` in the environment; the plugin uses it for model discovery
when `/connect` has not been run yet.

SDK usage is billed to your Cursor plan (same request pools / Privacy Mode
as the IDE). Spend shows up in the usage dashboard under the SDK tag.

### Local development

Clone this package and point `npm` / `plugin` at absolute `file://` paths
instead. Changes take effect after `pnpm run build:tsup`:

```json
{
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/opencode-cursor-sdk",
      "name": "Cursor",
      "models": {},
      "options": {}
    }
  },
  "plugin": ["file:///absolute/path/to/opencode-cursor-sdk/dist/plugin.js"]
}
```

```bash
pnpm install
pnpm run build:tsup
```

Re-run `pnpm run build:tsup` after every change and restart OpenCode to pick it up.

## Options

Every option below except `apiKey` is something *you* set, under
`provider.cursor.options` in `opencode.json`. `apiKey` is populated by
OpenCode from `/connect` — never write it into `opencode.json`.

| Option | Required | Meaning |
| --- | --- | --- |
| `apiKey` | yes | Cursor user or service-account API key; injected from `/connect` |
| `cwd` | no | Working directory for the local Cursor agent. The plugin defaults this to the current OpenCode project directory |

## Model discovery

Registering the bundled plugin makes **every model available to your Cursor
account** show up in OpenCode's `/models` picker. It calls
`Cursor.models.list()` at OpenCode startup and writes the result into
`provider.cursor.models`.

- Before `/connect` (and if `CURSOR_API_KEY` is unset), a small fallback
  list is used: `composer-2.5` and `auto`.
- After `/connect`, the live catalog replaces that list. Hand-written
  `models` entries still win on id collision.
- Cursor variants (for example Composer Fast) become OpenCode `/variants`
   entries. Select one with `opencode run --variant fast ...` or the TUI
   variant picker.

Without the plugin, OpenCode still loads the provider from `npm`, but you
must list models yourself under `provider.cursor.models` and authenticate
with `/connect` → Other using the provider id `cursor`.

## What this is not

- **Not the ACP/`cursor-agent` npm package also named around Cursor.** This
  package uses the official `@cursor/sdk` and keeps OpenCode as the agent.
- **Not a nested Cursor coding agent.** OpenCode remains the agent: it
  reads files, runs shells, and applies edits with its own tools. The
  Cursor SDK is used as the hosted-model backend for those turns.
- **Not Cursor Cloud Agents / PR automation.** Runs stay on the local
  runtime so OpenCode tools can be bridged. Cloud `Agent.create({ cloud })`
  is out of scope.
- **Not an OpenAI embeddings API.**
