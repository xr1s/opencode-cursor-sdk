import { createCursorPlugin } from "./plugin-core.js"

/**
 * OpenCode loads this module via `exports["./server"]`. Keep every runtime
 * export a plugin function — extra helpers live in `plugin-core.ts`.
 */
export const CursorModelDiscovery = createCursorPlugin()

export default CursorModelDiscovery
