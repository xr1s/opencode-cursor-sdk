import type { ChatContentPart, ChatMessage } from "./openai-types.js"

export type PromptImage = { data: string; mimeType: string }

export type ToolResult = { id: string; content: string }

const NO_TOOLS_GUARD =
  "Do not call tools, search the filesystem, or run shell commands. Reply with text only."

export function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (part && typeof part === "object" && part.type === "text" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "")
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

export function extractImages(messages: ChatMessage[]): PromptImage[] {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")
  if (!lastUser || !Array.isArray(lastUser.content)) return []

  const images: PromptImage[] = []
  for (const part of lastUser.content as ChatContentPart[]) {
    if (!part || typeof part !== "object" || part.type !== "image_url") continue
    const url = (part as { image_url?: { url?: string } }).image_url?.url
    if (!url) continue
    const parsed = parseDataUrl(url)
    if (parsed) images.push(parsed)
  }
  return images
}

export function parseDataUrl(url: string): PromptImage | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) return undefined
  return { mimeType: match[1], data: match[2] }
}

export function trailingToolResults(messages: ChatMessage[]): ToolResult[] | undefined {
  if (messages.length === 0) return undefined
  const results: ToolResult[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === "tool") {
      results.push({
        id: message.tool_call_id ?? "",
        content: textOf(message.content) || "(empty tool result)",
      })
      continue
    }
    break
  }
  if (results.length === 0) return undefined
  return results.reverse()
}

export function latestUserText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user")
  return lastUser ? textOf(lastUser.content) : ""
}

export function openingPrompt(messages: ChatMessage[], opts?: { hasTools?: boolean }): string {
  const lines: string[] = []
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue
    const text = textOf(message.content).trim()
    if (text) lines.push(text)
  }
  lines.push(latestUserText(messages).trim() || "Continue.")
  if (!opts?.hasTools) lines.push(NO_TOOLS_GUARD)
  return lines.filter(Boolean).join("\n\n")
}

export function followUpPrompt(messages: ChatMessage[]): string {
  return latestUserText(messages).trim() || "Continue."
}
