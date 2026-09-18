import type { ChatToolDefinition } from "../openai-types.js"
import type { CustomTool, CustomToolExecute } from "./types.js"

const SKILL_TOOL_NAME = "skill"
const SKILL_CATALOG_MARKER = "<available_skills"

export function createCustomTools(
  definitions: ChatToolDefinition[] | undefined,
  execute: (name: string) => CustomToolExecute,
  skillCatalog: string,
): Record<string, CustomTool> | undefined {
  if (!definitions?.length) return undefined

  const tools: Record<string, CustomTool> = {}
  for (const definition of definitions) {
    const name = definition.function?.name
    if (!name) continue
    let description = definition.function.description
    if (
      name === SKILL_TOOL_NAME &&
      skillCatalog &&
      !description?.includes(SKILL_CATALOG_MARKER)
    ) {
      description = description ? `${description}\n\n${skillCatalog}` : skillCatalog
    }
    tools[name] = {
      description,
      inputSchema: definition.function.parameters,
      execute: execute(name),
    }
  }
  return Object.keys(tools).length > 0 ? tools : undefined
}
