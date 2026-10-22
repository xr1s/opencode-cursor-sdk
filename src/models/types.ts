export type CursorParameterValue = { id: string; value: string }

export type CursorModelListItem = {
  id: string
  displayName?: string
  description?: string
  aliases?: string[]
  parameters?: Array<{
    id: string
    displayName?: string
    values: Array<{ value: string; displayName?: string }>
  }>
  variants?: Array<{
    params: CursorParameterValue[]
    displayName: string
    description?: string
    isDefault?: boolean
  }>
}

/** The provider-neutral model definition published to OpenCode V2. */
export type ConfigModel = {
  name: string
  description?: string
  tool_call: boolean
  reasoning: boolean
  temperature: boolean
  attachment: boolean
  modalities: { input: Array<"text" | "image">; output: Array<"text"> }
  limit: { context: number; output: number }
  variants?: Record<string, { reasoningEffort?: string; [key: string]: unknown }>
}
