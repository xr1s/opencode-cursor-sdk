import { errorMessage, type CursorRuntime } from "../cursor/index.js"
import type { ChatCompletionRequest, CompletionEvent } from "../openai-types.js"
import { AsyncQueue } from "./queue.js"
import { CursorModelCatalog } from "./catalog.js"
import { DurableSessionStore } from "./sessions.js"
import { DurableTurnExecutor } from "./durable-turn.js"
import { TextTurnExecutor } from "./text-turn.js"

export type BridgeOptions = {
  apiKey: string
  cwd?: string
  runtime: CursorRuntime
}

export type BridgeRequestContext = { sessionId: string; abortSignal?: AbortSignal }

export class CursorBridge {
  private readonly catalog: CursorModelCatalog
  private readonly sessions: DurableSessionStore
  private readonly durableTurns: DurableTurnExecutor
  private readonly textTurns: TextTurnExecutor
  private readonly cwd: string

  constructor(options: BridgeOptions) {
    this.cwd = options.cwd ?? process.cwd()
    this.catalog = new CursorModelCatalog(options.runtime, options.apiKey)
    this.sessions = new DurableSessionStore(options.runtime)
    this.durableTurns = new DurableTurnExecutor(options.apiKey, this.cwd, options.runtime, this.catalog, this.sessions)
    this.textTurns = new TextTurnExecutor(options.apiKey, this.cwd, options.runtime, this.catalog)
  }

  async complete(request: ChatCompletionRequest, context: BridgeRequestContext): Promise<CompletionEvent[]> {
    const events: CompletionEvent[] = []
    for await (const event of this.stream(request, context)) events.push(event)
    return events
  }

  async *stream(request: ChatCompletionRequest, context: BridgeRequestContext): AsyncGenerator<CompletionEvent> {
    const queue = new AsyncQueue<CompletionEvent>()
    const stop = () => queue.close()
    context.abortSignal?.addEventListener("abort", stop, { once: true })

    const execution = request.tools?.length
      ? this.durableTurns.execute(request, context, queue)
      : this.textTurns.execute(request, context, queue)
    void execution.catch((error) => {
      queue.push({ type: "error", error: errorMessage(error) })
      queue.push({ type: "finish", reason: "error" })
      queue.close()
    })

    try {
      yield* queue
    } finally {
      context.abortSignal?.removeEventListener("abort", stop)
    }
  }

  dispose(): Promise<void> {
    return this.sessions.dispose()
  }
}
