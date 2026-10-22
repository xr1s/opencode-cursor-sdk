import { extractImages, openingTextPrompt } from "../messages/index.js"
import { resolveModelSelection } from "../models/index.js"
import type { ChatCompletionRequest, CompletionEvent } from "../openai-types.js"
import { errorMessage, isRetryableAgentError, type CursorRuntime } from "../cursor/index.js"
import { AsyncQueue } from "./queue.js"
import { CursorModelCatalog } from "./catalog.js"
import { RetryWindow } from "./retry-window.js"
import { requestedReasoningEffort, toTokenUsage } from "./turn-support.js"

export type TextTurnContext = { abortSignal?: AbortSignal }

export class TextTurnExecutor {
  constructor(
    private readonly apiKey: string,
    private readonly cwd: string,
    private readonly runtime: CursorRuntime,
    private readonly catalog: CursorModelCatalog,
  ) {}

  async execute(request: ChatCompletionRequest, context: TextTurnContext, queue: AsyncQueue<CompletionEvent>): Promise<void> {
    const models = await this.catalog.list()
    const model = resolveModelSelection(models, request.model, requestedReasoningEffort(request))
    const retry = new RetryWindow()

    while (true) {
      const agent = await this.runtime.createAgent({
        apiKey: this.apiKey,
        cwd: this.cwd,
        model,
        tools: "none",
      })
      let streamed = false
      try {
        const run = await agent.send({
          text: openingTextPrompt(request.messages),
          images: extractImages(request.messages),
          onDelta: (update) => {
            if (update.type === "text-delta" && update.text) {
              streamed = true
              queue.push({ type: "text", text: update.text })
            }
            if (update.type === "thinking-delta" && update.text) queue.push({ type: "thinking", text: update.text })
          },
        })
        const result = await run.wait()
        if (result.status === "error" && retry.consume() && isRetryableAgentError(result.error) && !streamed) continue
        if (result.usage) queue.push({ type: "usage", usage: toTokenUsage(result.usage) })
        if (result.status === "error") {
          queue.push({ type: "error", error: result.error?.message ?? "Cursor run failed" })
          queue.push({ type: "finish", reason: "error" })
        } else if (result.status === "cancelled" && context.abortSignal?.aborted) {
          queue.push({ type: "finish", reason: "stop" })
        } else {
          if (result.result && !streamed) queue.push({ type: "text", text: result.result })
          queue.push({ type: "finish", reason: "stop" })
        }
        queue.close()
        return
      } catch (error) {
        if (retry.consume() && isRetryableAgentError(error) && !streamed) continue
        queue.push({ type: "error", error: errorMessage(error) })
        queue.push({ type: "finish", reason: "error" })
        queue.close()
        return
      } finally {
        await agent.dispose().catch(() => undefined)
      }
    }
  }
}
