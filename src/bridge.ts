import { randomUUID } from "node:crypto"
import { durableAgentId } from "./agent-id.js"
import {
  extractImages,
  followUpPrompt,
  openingPrompt,
  trailingToolResults,
} from "./messages.js"
import { resolveModelSelection, type CursorModelListItem, type CursorParameterValue } from "./models.js"
import type {
  ChatCompletionRequest,
  CompletionEvent,
  TokenUsage,
} from "./openai-types.js"
import {
  getDefaultRuntime,
  isAuthError,
  isMissingAgentError,
  toolsToCustomTools,
  type CursorAgent,
  type CursorRun,
  type CursorRuntime,
  type CustomToolExecute,
} from "./runtime.js"

const TOOL_BATCH_MS = 40
const HELD_TIMEOUT_MS = 15 * 60 * 1000
const SESSION_TTL_MS = 30 * 60 * 1000

type ParkedTool = {
  id: string
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type HeldTurn = {
  batch: ParkedTool[]
  parked: Map<string, ParkedTool>
  timer?: ReturnType<typeof setTimeout>
  onBatch?: (batch: ParkedTool[]) => void
}

type Session = {
  key: string
  sessionId: string
  apiKey: string
  cwd: string
  modelId: string
  agent?: CursorAgent
  catalog: CursorModelListItem[]
  held?: HeldTurn
  run?: CursorRun
  sink?: AsyncQueue<CompletionEvent>
  streamedText: boolean
  lastUsed: number
}

export type BridgeOptions = {
  apiKey: string
  cwd?: string
  runtime?: CursorRuntime
}

export class CursorBridge {
  private readonly sessions = new Map<string, Session>()
  private readonly apiKey: string
  private readonly cwd: string
  private readonly runtime: CursorRuntime
  private catalog: CursorModelListItem[] | undefined
  private catalogAt = 0

  constructor(options: BridgeOptions) {
    this.apiKey = options.apiKey
    this.cwd = options.cwd || process.cwd()
    this.runtime = options.runtime ?? getDefaultRuntime()
  }

  async complete(
    request: ChatCompletionRequest,
    opts: { sessionId: string; abortSignal?: AbortSignal },
  ): Promise<CompletionEvent[]> {
    const events: CompletionEvent[] = []
    for await (const event of this.stream(request, opts)) events.push(event)
    return events
  }

  async *stream(
    request: ChatCompletionRequest,
    opts: { sessionId: string; abortSignal?: AbortSignal },
  ): AsyncGenerator<CompletionEvent> {
    this.evictExpired()
    const session = this.session(opts.sessionId, request.model)
    const queue = new AsyncQueue<CompletionEvent>()
    const abort = opts.abortSignal

    const stop = () => {
      queue.close()
    }
    abort?.addEventListener("abort", stop, { once: true })

    void this.runTurn(session, request, queue, abort).catch((error) => {
      queue.push({ type: "error", error: errorMessage(error) })
      queue.push({ type: "finish", reason: "error" })
      queue.close()
    })

    try {
      yield* queue
    } finally {
      abort?.removeEventListener("abort", stop)
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(sessions.map((session) => this.drop(session)))
  }

  private session(sessionId: string, modelId: string): Session {
    const key = `${sessionId}::${modelId}`
    const existing = this.sessions.get(key)
    if (existing) {
      existing.lastUsed = Date.now()
      return existing
    }
    const session: Session = {
      key,
      sessionId,
      apiKey: this.apiKey,
      cwd: this.cwd,
      modelId,
      catalog: [],
      streamedText: false,
      lastUsed: Date.now(),
    }
    this.sessions.set(key, session)
    return session
  }

  private async runTurn(
    session: Session,
    request: ChatCompletionRequest,
    queue: AsyncQueue<CompletionEvent>,
    abort?: AbortSignal,
  ): Promise<void> {
    const results = trailingToolResults(request.messages)
    if (results && session.held && session.run) {
      await this.resumeHeld(session, results, queue, abort)
      return
    }

    const hasTools = (request.tools?.length ?? 0) > 0
    const catalog = await this.models()
    session.catalog = catalog
    const effort =
      (typeof request.reasoning_effort === "string" && request.reasoning_effort) ||
      (typeof request.reasoningEffort === "string" && request.reasoningEffort) ||
      undefined
    const model = resolveModelSelection(catalog, request.model, effort)

    // Title/compaction share this session id but must not reuse — or cancel —
    // a Cursor agent that is already in a tool loop for the main turn.
    if (hasTools && session.held) {
      this.abandonHeld(session, "superseded by new turn")
      await session.run?.cancel().catch(() => undefined)
      session.run = undefined
    }

    let refresh = false
    for (let attempt = 0; attempt < 2; attempt++) {
      const attached = hasTools
        ? await this.attachDurableAgent(session, model, refresh)
        : {
            agent: await this.runtime.createAgent({
              apiKey: session.apiKey,
              cwd: session.cwd,
              model,
              mcp: false,
            }),
            continued: false,
          }
      const agent = attached.agent

      const held = this.newHeld()
      const customTools = toolsToCustomTools(request.tools, (name) =>
        this.parkTool(held, name),
      )

      let streamedText = false
      let keepHeld = false
      if (hasTools) {
        session.held = held
        session.agent = agent
        session.sink = queue
        session.streamedText = false
      }

      const push = (event: CompletionEvent) => {
        if (hasTools) session.sink?.push(event)
        else queue.push(event)
      }
      const streamed = () => (hasTools ? session.streamedText : streamedText)

      try {
        const run = await agent.send({
          text: attached.continued
            ? followUpPrompt(request.messages)
            : openingPrompt(request.messages, { hasTools }),
          images: extractImages(request.messages),
          customTools,
          force: true,
          onDelta: (update) => {
            if (update.type === "text-delta" && update.text) {
              streamedText = true
              if (hasTools) session.streamedText = true
              push({ type: "text", text: update.text })
            }
            if (update.type === "thinking-delta" && update.text) {
              push({ type: "thinking", text: update.text })
            }
          },
        })
        if (hasTools) session.run = run
        const outcome = await this.watchRun(session, held, run, queue, abort, {
          streamedText: streamed,
          canRetry: attempt === 0,
        })
        keepHeld = hasTools && session.held === held
        if (outcome === "retry-auth") {
          refresh = true
          continue
        }
        return
      } catch (error) {
        if (attempt === 0 && isAuthError(error) && !streamed()) {
          this.abandonHeld(session, "auth retry")
          refresh = true
          continue
        }
        throw error
      } finally {
        if (!keepHeld) {
          session.run = undefined
          if (!hasTools) {
            await agent.dispose().catch(() => undefined)
          }
        }
      }
    }
  }

  private async attachDurableAgent(
    session: Session,
    model: { id: string; params?: CursorParameterValue[] },
    refresh = false,
  ): Promise<{ agent: CursorAgent; continued: boolean }> {
    if (refresh) {
      await session.agent?.dispose().catch(() => undefined)
      session.agent = undefined
    } else if (session.agent) {
      return { agent: session.agent, continued: true }
    }
    const agentId = durableAgentId(session.sessionId, session.modelId, session.cwd)
    const input = {
      apiKey: session.apiKey,
      cwd: session.cwd,
      model,
      mcp: true,
      agentId,
    }
    try {
      return { agent: await this.runtime.resumeAgent(agentId, input), continued: true }
    } catch (error) {
      if (!isMissingAgentError(error) && !isAuthError(error)) throw error
      return { agent: await this.runtime.createAgent(input), continued: false }
    }
  }

  private async resumeHeld(
    session: Session,
    results: Array<{ id: string; content: string }>,
    queue: AsyncQueue<CompletionEvent>,
    abort?: AbortSignal,
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

    for (const result of results) {
      const parked = held.parked.get(result.id)
      if (!parked) continue
      parked.resolve(result.content)
      held.parked.delete(result.id)
    }

    for (const leftover of held.parked.values()) {
      leftover.resolve("(tool result was not returned by the caller)")
    }
    held.parked.clear()
    held.batch = []

    await this.watchRun(session, held, run, queue, abort, {
      streamedText: () => session.streamedText,
    })
  }

  private async watchRun(
    session: Session,
    held: HeldTurn,
    run: CursorRun,
    queue: AsyncQueue<CompletionEvent>,
    abort?: AbortSignal,
    flags: { streamedText: () => boolean; canRetry?: boolean } = { streamedText: () => false },
  ): Promise<"closed" | "retry-auth"> {
    let finished = false
    const cancelThis = (reason: string) => {
      if (session.held === held) this.abandonHeld(session, reason)
      run.cancel().catch(() => undefined)
    }
    const timeout = setTimeout(() => cancelThis("timed out waiting for tool results"), HELD_TIMEOUT_MS)

    const onAbort = () => cancelThis("aborted")
    abort?.addEventListener("abort", onAbort, { once: true })

    held.onBatch = (batch) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      abort?.removeEventListener("abort", onAbort)
      queue.push({
        type: "tool_calls",
        calls: batch.map((item) => ({
          id: item.id,
          name: item.name,
          arguments: JSON.stringify(item.args ?? {}),
        })),
      })
      queue.push({ type: "finish", reason: "tool_calls" })
      queue.close()
    }

    try {
      const result = await run.wait()
      if (finished) return "closed"
      finished = true
      clearTimeout(timeout)
      abort?.removeEventListener("abort", onAbort)

      if (held.batch.length > 0) {
        if (session.held === held) {
          session.held = undefined
          session.run = undefined
        }
        held.onBatch(held.batch.splice(0))
        return "closed"
      }

      if (
        result.status === "error" &&
        flags.canRetry &&
        isAuthError(result.error) &&
        !flags.streamedText()
      ) {
        this.abandonHeld(session, "auth retry")
        session.run = undefined
        return "retry-auth"
      }

      if (session.held === held) {
        session.held = undefined
        session.run = undefined
      }

      if (result.usage) queue.push({ type: "usage", usage: toUsage(result.usage) })
      if (result.status === "error") {
        queue.push({
          type: "error",
          error: result.error?.message ?? "Cursor run failed",
        })
        queue.push({ type: "finish", reason: "error" })
      } else if (result.status === "cancelled" && abort?.aborted) {
        queue.push({ type: "finish", reason: "stop" })
      } else {
        if (result.result && !flags.streamedText()) {
          queue.push({ type: "text", text: result.result })
        }
        queue.push({ type: "finish", reason: "stop" })
      }
      queue.close()
      return "closed"
    } catch (error) {
      if (finished) return "closed"
      finished = true
      clearTimeout(timeout)
      abort?.removeEventListener("abort", onAbort)
      if (flags.canRetry && isAuthError(error) && !flags.streamedText()) {
        this.abandonHeld(session, "auth retry")
        session.run = undefined
        return "retry-auth"
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

  private newHeld(): HeldTurn {
    return { batch: [], parked: new Map() }
  }

  private parkTool(held: HeldTurn, name: string): CustomToolExecute {
    return (args, context) =>
      new Promise((resolve, reject) => {
        const id = context.toolCallId || `call_${randomUUID()}`
        const parked: ParkedTool = {
          id,
          name,
          args: (args ?? {}) as Record<string, unknown>,
          resolve,
          reject,
        }
        held.parked.set(id, parked)
        held.batch.push(parked)
        if (held.timer) clearTimeout(held.timer)
        held.timer = setTimeout(() => {
          const batch = held.batch.splice(0)
          if (batch.length) held.onBatch?.(batch)
        }, TOOL_BATCH_MS)
      })
  }

  private abandonHeld(session: Session, reason: string): void {
    const held = session.held
    session.held = undefined
    if (!held) return
    if (held.timer) clearTimeout(held.timer)
    for (const parked of held.parked.values()) {
      parked.reject(new Error(reason))
    }
    held.parked.clear()
    held.batch = []
  }

  private async models(): Promise<CursorModelListItem[]> {
    const now = Date.now()
    if (this.catalog && now - this.catalogAt < 60_000) return this.catalog
    try {
      this.catalog = await this.runtime.listModels(this.apiKey)
      this.catalogAt = now
      return this.catalog
    } catch {
      return this.catalog ?? []
    }
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      if (now - session.lastUsed > SESSION_TTL_MS && !session.held) {
        void this.drop(session)
        this.sessions.delete(session.key)
      }
    }
  }

  private async drop(session: Session): Promise<void> {
    this.abandonHeld(session, "session disposed")
    await session.run?.cancel().catch(() => undefined)
    await session.agent?.dispose().catch(() => undefined)
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiters: Array<(item: IteratorResult<T>) => void> = []
  private done = false

  push(item: T): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.items.push(item)
  }

  close(): void {
    if (this.done) return
    this.done = true
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift() as T
        continue
      }
      if (this.done) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve)
      })
      if (next.done) return
      yield next.value
    }
  }
}

function toUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}): TokenUsage {
  const prompt = usage.inputTokens ?? 0
  const completion = usage.outputTokens ?? 0
  const total = usage.totalTokens ?? prompt + completion
  const out: TokenUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  }
  if (usage.reasoningTokens) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  }
  return out
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const bridges = new Map<string, CursorBridge>()

export function bridgeFor(options: BridgeOptions): CursorBridge {
  const key = `${options.apiKey}::${options.cwd ?? ""}`
  const existing = bridges.get(key)
  if (existing) return existing
  const created = new CursorBridge(options)
  bridges.set(key, created)
  return created
}

export async function resetBridges(): Promise<void> {
  const all = [...bridges.values()]
  bridges.clear()
  await Promise.all(all.map((bridge) => bridge.dispose()))
}
