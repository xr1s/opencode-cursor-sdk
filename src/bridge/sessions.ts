import type { CursorAgent, CursorRun, CursorRuntime } from "../cursor/index.js"
import { HeldToolTurn } from "./held-turn.js"
import type { AsyncQueue } from "./queue.js"
import type { CompletionEvent } from "../openai-types.js"

export type DurableSession = {
  readonly sessionId: string
  readonly apiKey: string
  readonly cwd: string
  readonly modelId: string
  agent?: CursorAgent
  held?: HeldToolTurn
  run?: CursorRun
  sink?: AsyncQueue<CompletionEvent>
  streamedText: boolean
}

export class DurableSessionStore {
  private readonly sessions = new Map<string, DurableSession>()

  constructor(private readonly runtime: CursorRuntime) {}

  get(sessionId: string, modelId: string, apiKey: string, cwd: string): DurableSession {
    const key = `${sessionId}\0${modelId}`
    const existing = this.sessions.get(key)
    if (existing) return existing
    const created: DurableSession = {
      sessionId,
      apiKey,
      cwd,
      modelId,
      streamedText: false,
    }
    this.sessions.set(key, created)
    return created
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      sessions.map(async (session) => {
        session.held?.abandon("session disposed")
        await session.run?.cancel().catch(() => undefined)
        await session.agent?.dispose().catch(() => undefined)
      }),
    )
  }
}
