import type { CursorParameterValue } from "./models.js"
import type { ChatToolDefinition } from "./openai-types.js"
import type { PromptImage } from "./messages.js"

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

export type SendInput = {
  text: string
  images?: PromptImage[]
  customTools?: Record<string, CustomTool>
  force?: boolean
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
  send(input: SendInput): Promise<CursorRun>
  dispose(): Promise<void>
}

export type CreateAgentInput = {
  apiKey: string
  cwd: string
  model: { id: string; params?: CursorParameterValue[] }
  /**
   * When true, the local agent may offer MCP tools (OpenCode's caller tools
   * registered as `customTools`). `tools: []` would also hide MCP, which is
   * why this uses the `"mcp"` allowlist instead of an empty list.
   */
  mcp?: boolean
}

export type CursorRuntime = {
  listModels(apiKey: string): Promise<import("./models.js").CursorModelListItem[]>
  createAgent(input: CreateAgentInput): Promise<CursorAgent>
}

export function toolsToCustomTools(
  tools: ChatToolDefinition[] | undefined,
  execute: (name: string) => CustomToolExecute,
): Record<string, CustomTool> | undefined {
  if (!tools?.length) return undefined
  const out: Record<string, CustomTool> = {}
  for (const tool of tools) {
    const name = tool.function?.name
    if (!name) continue
    out[name] = {
      description: tool.function.description,
      inputSchema: tool.function.parameters,
      execute: execute(name),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

let defaultRuntime: CursorRuntime | undefined

export function setDefaultRuntime(runtime: CursorRuntime | undefined): void {
  defaultRuntime = runtime
}

export function getDefaultRuntime(): CursorRuntime {
  if (defaultRuntime) return defaultRuntime
  throw new Error("Cursor runtime is not configured")
}

export async function loadSdkRuntime(): Promise<CursorRuntime> {
  const { Agent, Cursor } = await import("@cursor/sdk")
  return {
    async listModels(apiKey) {
      return (await Cursor.models.list({ apiKey })) as import("./models.js").CursorModelListItem[]
    },
    async createAgent(input) {
      const agent = await Agent.create({
        apiKey: input.apiKey,
        model: input.model,
        tools: input.mcp ? ["mcp"] : [],
        local: { cwd: input.cwd },
      })
      return {
        async send(sendInput) {
          const run = await agent.send(
            sendInput.images?.length
              ? { text: sendInput.text, images: sendInput.images }
              : sendInput.text,
            {
              onDelta: sendInput.onDelta
                ? ({ update }: { update: { type: string; text?: string } }) =>
                    sendInput.onDelta?.(update)
                : undefined,
              local: {
                force: sendInput.force,
                customTools: sendInput.customTools as never,
              },
            },
          )
          return {
            wait: () => run.wait(),
            cancel: async () => {
              if (run.supports?.("cancel")) await run.cancel()
            },
          }
        },
        async dispose() {
          await agent[Symbol.asyncDispose]()
        },
      }
    },
  }
}
