import { compatToolCallId } from "../agent-id.js"
import { compatToolArgs } from "../tool-args.js"
import type { CustomToolExecute } from "../cursor/index.js"

export type ParkedTool = {
  id: string
  name: string
  args: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

const TOOL_BATCH_DELAY_MS = 40

export class HeldToolTurn {
  private batch: ParkedTool[] = []
  private readonly parked = new Map<string, ParkedTool>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private batchHandler: ((batch: ParkedTool[]) => void) | undefined

  tool(name: string): CustomToolExecute {
    return (args, context) =>
      new Promise((resolve, reject) => {
        const id = compatToolCallId(context.toolCallId)
        const parked: ParkedTool = {
          id,
          name,
          args: compatToolArgs(name, args ?? {}),
          resolve,
          reject,
        }
        this.parked.set(id, parked)
        this.batch.push(parked)
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => this.flush(), TOOL_BATCH_DELAY_MS)
      })
  }

  onBatchReady(handler: (batch: ParkedTool[]) => void): void {
    this.batchHandler = handler
  }

  settleResults(results: Array<{ id: string; content: string }>): void {
    for (const result of results) {
      const parked = this.parked.get(result.id)
      if (!parked) continue
      parked.resolve(result.content)
      this.parked.delete(result.id)
    }
    for (const parked of this.parked.values()) parked.resolve("(tool result was not returned by the caller)")
    this.parked.clear()
    this.batch = []
  }

  abandon(reason: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const parked of this.parked.values()) parked.reject(new Error(reason))
    this.parked.clear()
    this.batch = []
    this.batchHandler = undefined
  }

  clearBatch(): ParkedTool[] {
    const batch = this.batch
    this.batch = []
    return batch
  }

  hasBatch(): boolean {
    return this.batch.length > 0
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const batch = this.clearBatch()
    if (batch.length > 0) this.batchHandler?.(batch)
  }
}
