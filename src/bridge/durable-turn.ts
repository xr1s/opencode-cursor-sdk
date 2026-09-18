import { durableAgentId } from "../agent-id.js"
import { extractImages, followUpPrompt, openingToolPrompt, skillCatalog, trailingToolResults } from "../messages/index.js"
import { resolveModelSelection } from "../models/index.js"
import type { ChatCompletionRequest, CompletionEvent } from "../openai-types.js"
import {
  createCustomTools,
  errorMessage,
  isAuthenticationError,
  isMissingAgentError,
  isRetryableAgentError,
  type AgentRequest,
  type CursorAgent,
  type CursorRun,
  type CursorRuntime,
} from "../cursor/index.js"
import { AsyncQueue } from "./queue.js"
import { CursorModelCatalog } from "./catalog.js"
import { HeldToolTurn, type ParkedTool } from "./held-turn.js"
import { RetryWindow } from "./retry-window.js"
import type { DurableSession, DurableSessionStore } from "./sessions.js"
import { requestedReasoningEffort, toTokenUsage } from "./turn-support.js"

const HELD_TURN_TIMEOUT_MS = 15 * 60 * 1000

export type DurableTurnContext = { sessionId: string; abortSignal?: AbortSignal }

type AgentAttachment = {
  agent: CursorAgent
  prompt: "opening" | "follow-up"
}

export class DurableTurnExecutor {
  constructor(
    private readonly apiKey: string,
    private readonly cwd: string,
    private readonly runtime: CursorRuntime,
    private readonly catalog: CursorModelCatalog,
    private readonly sessions: DurableSessionStore,
  ) {}

  async execute(request: ChatCompletionRequest, context: DurableTurnContext, queue: AsyncQueue<CompletionEvent>): Promise<void> {
    const session = this.sessions.get(context.sessionId, request.model, this.apiKey, this.cwd)
    const results = trailingToolResults(request.messages)
    if (results && session.held && session.run) {
      await this.resumeHeld(session, results, queue, context.abortSignal)
      return
    }

    const models = await this.catalog.list()
    const selection = resolveModelSelection(models, request.model, requestedReasoningEffort(request))
    if (session.held) {
      await this.cancelHeld(session, "superseded by new turn")
    }

    const retry = new RetryWindow()
    while (true) {
      const attachment = await this.attachAgent(session, selection)
      const held = new HeldToolTurn()
      session.held = held
      session.agent = attachment.agent
      session.sink = queue
      session.streamedText = false
      let streamedText = false
      let keepSession = false

      try {
        const run = await attachment.agent.send({
          text: attachment.prompt === "follow-up" ? followUpPrompt(request.messages) : openingToolPrompt(request.messages),
          images: extractImages(request.messages),
          customTools: createCustomTools(request.tools, (name) => held.tool(name), skillCatalog(request.messages)),
          onDelta: (update) => {
            if (update.type === "text-delta" && update.text) {
              streamedText = true
              session.streamedText = true
              session.sink?.push({ type: "text", text: update.text })
            }
            if (update.type === "thinking-delta" && update.text) {
              session.sink?.push({ type: "thinking", text: update.text })
            }
          },
        })
        session.run = run
        const outcome = await this.watchRun(session, held, run, queue, context.abortSignal, retry, () => streamedText)
        keepSession = session.held === held
        if (outcome === "retry") continue
        return
      } catch (error) {
        if (retry.consume() && isRetryableAgentError(error) && !streamedText) {
          await this.cancelHeld(session, "retry")
          await this.resetAgent(session)
          continue
        }
        throw error
      } finally {
        if (!keepSession) {
          session.run = undefined
          session.held = undefined
        }
      }
    }
  }

  private async attachAgent(
    session: DurableSession,
    model: { id: string; params?: import("../models/types.js").CursorParameterValue[] },
  ): Promise<AgentAttachment> {
    if (session.agent) return { agent: session.agent, prompt: "follow-up" }

    const input: AgentRequest = {
      apiKey: session.apiKey,
      cwd: session.cwd,
      model,
      tools: "mcp",
      agentId: durableAgentId(session.sessionId, session.modelId, session.cwd),
    }
    try {
      return { agent: await this.runtime.resumeAgent(input.agentId!, input), prompt: "opening" }
    } catch (error) {
      if (!isMissingAgentError(error) && !isAuthenticationError(error)) throw error
      return { agent: await this.runtime.createAgent(input), prompt: "opening" }
    }
  }

  private async resumeHeld(
    session: DurableSession,
    results: Array<{ id: string; content: string }>,
    queue: AsyncQueue<CompletionEvent>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const held = session.held
    const run = session.run
    if (!held || !run) {
      queue.push({ type: "error", error: "No in-flight Cursor run to resume" })
      queue.push({ type: "finish", reason: "error" })
      queue.close()
      return
    }
    session.sink = queue
    session.streamedText = false
    held.settleResults(results)
    await this.watchRun(session, held, run, queue, abortSignal, new RetryWindow(), () => session.streamedText)
  }

  private async watchRun(
    session: DurableSession,
    held: HeldToolTurn,
    run: CursorRun,
    queue: AsyncQueue<CompletionEvent>,
    abortSignal: AbortSignal | undefined,
    retry: RetryWindow,
    streamed: () => boolean,
  ): Promise<"closed" | "retry"> {
    let finished = false
    const timeout = setTimeout(() => {
      if (session.held === held) session.held = undefined
      held.abandon("timed out waiting for tool results")
      void run.cancel().catch(() => undefined)
    }, HELD_TURN_TIMEOUT_MS)
    const cancel = () => {
      if (session.held === held) session.held = undefined
      held.abandon("aborted")
      void run.cancel().catch(() => undefined)
    }
    abortSignal?.addEventListener("abort", cancel, { once: true })
    held.onBatchReady((batch) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      abortSignal?.removeEventListener("abort", cancel)
      queue.push({ type: "tool_calls", calls: batch.map(toToolCall) })
      queue.push({ type: "finish", reason: "tool_calls" })
      queue.close()
    })

    try {
      const result = await run.wait()
      if (finished) return "closed"
      if (held.hasBatch()) {
        held.flush()
        return "closed"
      }
      finished = true
      clearTimeout(timeout)
      abortSignal?.removeEventListener("abort", cancel)
      if (result.status === "error" && retry.consume() && isRetryableAgentError(result.error) && !streamed()) {
        await this.cancelHeld(session, "retry")
        await this.resetAgent(session)
        session.run = undefined
        return "retry"
      }
      if (session.held === held) {
        session.held = undefined
        session.run = undefined
      }
      if (result.usage) queue.push({ type: "usage", usage: toTokenUsage(result.usage) })
      if (result.status === "error") {
        queue.push({ type: "error", error: result.error?.message ?? "Cursor run failed" })
        queue.push({ type: "finish", reason: "error" })
      } else if (result.status === "cancelled" && abortSignal?.aborted) {
        queue.push({ type: "finish", reason: "stop" })
      } else {
        if (result.result && !streamed()) queue.push({ type: "text", text: result.result })
        queue.push({ type: "finish", reason: "stop" })
      }
      queue.close()
      return "closed"
    } catch (error) {
      if (finished) return "closed"
      finished = true
      clearTimeout(timeout)
      abortSignal?.removeEventListener("abort", cancel)
      if (retry.consume() && isRetryableAgentError(error) && !streamed()) {
        await this.cancelHeld(session, "retry")
        await this.resetAgent(session)
        session.run = undefined
        return "retry"
      }
      if (session.held === held) {
        session.held = undefined
        session.run = undefined
      }
      queue.push({ type: "error", error: errorMessage(error) })
      queue.push({ type: "finish", reason: "error" })
      queue.close()
      return "closed"
    }
  }

  private async cancelHeld(session: DurableSession, reason: string): Promise<void> {
    session.held?.abandon(reason)
    session.held = undefined
    await session.run?.cancel().catch(() => undefined)
    session.run = undefined
  }

  private async resetAgent(session: DurableSession): Promise<void> {
    await session.agent?.dispose().catch(() => undefined)
    session.agent = undefined
  }
}

function toToolCall(tool: ParkedTool) {
  return { id: tool.id, name: tool.name, arguments: JSON.stringify(tool.args ?? {}) }
}
