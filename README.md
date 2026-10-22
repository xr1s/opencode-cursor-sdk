# opencode-cursor-sdk

An OpenCode V2 provider backed by the official
[`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) TypeScript SDK. No local
HTTP proxy is involved.

Cursor's SDK is an **agent runtime**, not a raw chat-completions API. OpenCode
keeps its own agent loop and tools. In OpenCode V2 configuration, the `aisdk:`
prefix selects OpenCode's AI SDK provider loader; this package supplies the
provider factory loaded by that mechanism. Cursor's built-in filesystem
and shell tools are disabled. OpenCode tools are registered as Cursor custom
tools and held until OpenCode executes them.

## Architecture

The package root exports both the AI SDK provider factory and the V2 server
plugin:

```text
providers.cursor.package = "aisdk:opencode-cursor-sdk"
plugins = ["opencode-cursor-sdk"]
          │
          ├─ V2 integration transform: /connect credentials
          ├─ V2 provider transform: Cursor.models.list() inventory
          └─ createCursor() → in-process OpenAI-compatible fetch
```

The provider factory keeps the existing Cursor agent and tool bridge. The
plugin uses V2 `Plugin.define`, `integration.transform`, and
`provider.transform`; it refreshes the catalog after credential changes.

## Setup

Requires **OpenCode V2** and **Node.js >= 26**.

Add the following to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "name": "Cursor",
      "package": "aisdk:opencode-cursor-sdk"
    }
  },
  "plugins": ["opencode-cursor-sdk"]
}
```

The `aisdk:` prefix tells OpenCode to load this package as an AI SDK provider
factory. OpenCode calls the exported `createCursor()` factory and passes the
resolved provider settings and credential to it. The plugin is loaded from the
package's default export. OpenCode resolves both package names through its
package loader.

To load a local checkout directly, use `file://` URLs for both entries:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "name": "Cursor",
      "package": "aisdk:file:///absolute/path/to/opencode-cursor-sdk"
    }
  },
  "plugins": ["file:///absolute/path/to/opencode-cursor-sdk"]
}
```

Run `/connect`, select **Cursor**, and either log in through the browser or
paste a key from [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).
OpenCode stores the credential as a V2 integration credential and injects it at
request time. `CURSOR_API_KEY` is also supported for discovery and requests.

SDK usage is billed to your Cursor plan.

## Options

The plugin sets the Cursor agent working directory to the current OpenCode
project directory. Do not write credentials into `opencode.json`.

| Option | Required | Meaning |
| --- | --- | --- |
| `apiKey` | yes | Cursor user or service-account key, supplied by the V2 integration |
| `cwd` | automatic | Current OpenCode project directory |

## Model discovery

The plugin publishes every model returned by `Cursor.models.list()` to the V2
provider registry.

- The provider exposes the live catalog returned by `Cursor.models.list()`.
- If Cursor returns no models, the provider remains available with an empty model catalog.
- Configured model entries remain as overlays and win on ID collisions.
- Cursor variants become OpenCode model variants, including Fast and Max Mode.
- Credential updates trigger a refresh.

Without the plugin, list models under `providers.cursor.models` yourself and
configure a V2 integration credential for `cursor`.

## Scope

- This is not the ACP `cursor-agent` package.
- This is not a nested Cursor coding agent or Cursor Cloud Agent integration.
- OpenCode remains responsible for files, shells, edits, and the agent loop.
