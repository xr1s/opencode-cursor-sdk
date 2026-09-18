import type { CursorModelListItem, CursorParameterValue } from "../models/types.js"

export type PromptImage = { data: string; mimeType: string }

export type CursorUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}

export type CursorRunStatus = "finished" | "error" | "cancelled"

export type CustomToolExecute = (
  args: Record<string, unknown>,
  context: { toolCallId?: string },
) => Promise<unknown> | unknown

export type CustomTool = {
  description?: string
  inputSchema?: Record<string, unknown>
  execute: CustomToolExecute
}

export type CursorTurnInput = {
  text: string
  images?: PromptImage[]
  customTools?: Record<string, CustomTool>
  onDelta?: (update: { type: string; text?: string }) => void | Promise<void>
}

export type CursorRun = {
  wait(): Promise<{
    status: CursorRunStatus
    result?: string
    error?: { message: string }
    usage?: CursorUsage
  }>
  cancel(): Promise<void>
}

export type CursorAgent = {
  agentId: string
  send(input: CursorTurnInput): Promise<CursorRun>
  dispose(): Promise<void>
}

export type AgentRequest = {
  apiKey: string
  cwd: string
  model: { id: string; params?: CursorParameterValue[] }
  tools: "mcp" | "none"
  agentId?: string
}

export type CursorRuntime = {
  listModels(apiKey: string): Promise<CursorModelListItem[]>
  createAgent(input: AgentRequest): Promise<CursorAgent>
  resumeAgent(agentId: string, input: AgentRequest): Promise<CursorAgent>
}
