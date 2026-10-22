export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool"

export type ChatTextPart = { type: "text"; text: string }

export type ChatImagePart = {
  type: "image_url"
  image_url: { url: string; detail?: string }
}

export type ChatContentPart = ChatTextPart | ChatImagePart | { type: string; [key: string]: unknown }

export type ChatToolCall = {
  id: string
  type?: string
  function: { name: string; arguments: string }
}

export type ChatMessage = {
  role: ChatRole | string
  content?: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

export type ChatToolDefinition = {
  type?: string
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export type ChatCompletionRequest = {
  model: string
  messages: ChatMessage[]
  tools?: ChatToolDefinition[]
  tool_choice?: unknown
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  reasoning_effort?: string
  reasoningEffort?: string
  max_tokens?: number
  temperature?: number
  [key: string]: unknown
}

export type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

export type CompletionEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_calls"
      calls: Array<{ id: string; name: string; arguments: string }>
    }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; error: string }
  | { type: "finish"; reason: "stop" | "tool_calls" | "error" }
