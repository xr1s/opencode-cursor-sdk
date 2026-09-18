export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? error)
  }
  return String(error)
}

export function isMissingAgentError(error: unknown): boolean {
  return /not found/i.test(errorMessage(error))
}

export function isAuthenticationError(error: unknown): boolean {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error && "errorName" in error
        ? String((error as { errorName?: unknown }).errorName ?? "")
        : ""
  return name === "AuthenticationError" ||
    /authentication error|unauthenticated|try logging out and back in/i.test(errorMessage(error))
}

export function isTransientNetworkError(error: unknown): boolean {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : ""
  return /premature close|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|ERR_STREAM|NGHTTP2|http\/2 stream|ERR_HTTP2|connection aborted|protocol error|session closed with error/i.test(
    `${code} ${errorMessage(error)}`,
  )
}

export function isRetryableAgentError(error: unknown): boolean {
  return isAuthenticationError(error) || isTransientNetworkError(error)
}
