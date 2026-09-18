import type { CursorModelListItem } from "../models/types.js"
import type { CursorRuntime, CursorAgent, AgentRequest, CursorTurnInput, CursorRunStatus, CursorUsage } from "./types.js"
import type { SDKAgent } from "@cursor/sdk"

export async function loadCursorRuntime(): Promise<CursorRuntime> {
  const { Agent, Cursor } = await import("@cursor/sdk")
  return {
    async listModels(apiKey) {
      return (await Cursor.models.list({ apiKey })) as CursorModelListItem[]
    },
    async createAgent(input) {
      return wrapAgent(await Agent.create(toSdkAgentInput(input)))
    },
    async resumeAgent(agentId, input) {
      return wrapAgent(await Agent.resume(agentId, toSdkAgentInput(input)))
    },
  }
}

function toSdkAgentInput(input: AgentRequest) {
  return {
    apiKey: input.apiKey,
    model: input.model,
    agentId: input.agentId,
    tools: input.tools === "mcp" ? ["mcp"] : [],
    local: { cwd: input.cwd },
  }
}

function wrapAgent(agent: SDKAgent): CursorAgent {
  return {
    agentId: agent.agentId,
    async send(input: CursorTurnInput) {
      const run = await agent.send(
        input.images?.length ? { text: input.text, images: input.images } : input.text,
        {
          onDelta: input.onDelta
            ? ({ update }) => input.onDelta?.(update)
            : undefined,
          local: {
            force: true,
            customTools: input.customTools as never,
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
    dispose: () => agent[Symbol.asyncDispose](),
  }
}
