import type { ChatContentPart, ChatMessage } from "../openai-types.js"
import type { PromptImage } from "../cursor/types.js"

export type { PromptImage } from "../cursor/types.js"

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

export function parseDataUrl(url: string): PromptImage | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  return match ? { mimeType: match[1], data: match[2] } : undefined
}

export function extractImages(messages: ChatMessage[]): PromptImage[] {
  const user = [...messages].reverse().find((message) => message.role === "user")
  if (!user || !Array.isArray(user.content)) return []

  const images: PromptImage[] = []
  for (const part of user.content as ChatContentPart[]) {
    if (!part || typeof part !== "object" || part.type !== "image_url") continue
    const url = (part as { image_url?: { url?: string } }).image_url?.url
    const image = url ? parseDataUrl(url) : undefined
    if (image) images.push(image)
  }
  return images
}
