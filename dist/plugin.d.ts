import * as _opencode_ai_plugin from '@opencode-ai/plugin';

/**
 * OpenCode loads this module via `exports["./server"]`. Keep every runtime
 * export a plugin function — extra helpers live in `plugin-core.ts`.
 */
declare const CursorModelDiscovery: _opencode_ai_plugin.Plugin;

export { CursorModelDiscovery, CursorModelDiscovery as default };
