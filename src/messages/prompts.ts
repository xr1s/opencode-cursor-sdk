import { textOf } from "./content.js"
import type { ChatMessage } from "../openai-types.js"

const NO_TOOLS_GUARD =
  "Do not call tools, search the filesystem, or run shell commands. Reply with text only."
const SKILL_CATALOG_RE = /<available_skills\b[\s\S]*?<\/available_skills>/i

function latestUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user")
  return user ? textOf(user.content) : ""
}

/** OpenCode's skill name/description list, not the SKILL.md bodies. */
export function skillCatalog(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue
    const match = SKILL_CATALOG_RE.exec(textOf(message.content))
    if (match) return match[0].trim()
  }
  return ""
}

function systemInstructions(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textOf(message.content).trim())
    .filter(Boolean)
}

function latestUserOrContinue(messages: ChatMessage[]): string {
  return latestUserText(messages).trim() || "Continue."
}

export function openingToolPrompt(messages: ChatMessage[]): string {
  return [...systemInstructions(messages), latestUserOrContinue(messages)].join("\n\n")
}

export function openingTextPrompt(messages: ChatMessage[]): string {
  return `${openingToolPrompt(messages)}\n\n${NO_TOOLS_GUARD}`
}

export function followUpPrompt(messages: ChatMessage[]): string {
  const user = latestUserOrContinue(messages)
  const catalog = skillCatalog(messages)
  return catalog ? `${catalog}\n\n${user}` : user
}
