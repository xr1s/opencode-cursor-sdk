import { createHash } from "node:crypto"

export function durableAgentId(sessionId: string, modelId: string, cwd: string): string {
  const digest = createHash("sha256")
    .update(`${sessionId}\0${modelId}\0${cwd}`)
    .digest("hex")
    .slice(0, 32)
  return `agent-oc-${digest}`
}
