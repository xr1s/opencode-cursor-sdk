import { createHash, randomUUID } from "node:crypto"

const MAX_TOOL_CALL_ID_LENGTH = 64
const TOOL_CALL_ID_RE = /^[A-Za-z0-9_-]+$/

export function durableAgentId(sessionId: string, modelId: string, cwd: string): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${modelId}\0${cwd}`)
    .digest("hex")
    .slice(0, 32)
  return `agent-oc-${digest}`
}

export function compatToolCallId(raw?: string): string {
  const candidate = raw?.trim() || `call_${randomUUID()}`
  if (candidate.length <= MAX_TOOL_CALL_ID_LENGTH && TOOL_CALL_ID_RE.test(candidate)) {
    return candidate
  }
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 32)
  return `call_${digest}`
}
