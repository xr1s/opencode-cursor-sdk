import type { ChatCompletionRequest, TokenUsage } from "../openai-types.js"

export function requestedReasoningEffort(request: ChatCompletionRequest): string | undefined {
  if (typeof request.reasoning_effort === "string" && request.reasoning_effort) {
    return request.reasoning_effort
  }
  if (typeof request.reasoningEffort === "string" && request.reasoningEffort) {
    return request.reasoningEffort
  }
  return undefined
}

export function toTokenUsage(usage: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
}): TokenUsage {
  const prompt = usage.inputTokens ?? 0
  const completion = usage.outputTokens ?? 0
  const result: TokenUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  }
  if (usage.reasoningTokens) result.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
  return result
}
