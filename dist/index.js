import {
  CURSOR_LOCAL_BASE_URL,
  FALLBACK_MODELS,
  getDefaultRuntime,
  isAuthError,
  isMissingAgentError,
  loadSdkRuntime,
  resolveModelSelection,
  setDefaultRuntime,
  toConfigModels,
  toolsToCustomTools
} from "./chunk-VU7MVYH4.js";

// src/index.ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// src/completions.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/bridge.ts
import { randomUUID } from "crypto";

// src/agent-id.ts
import { createHash } from "crypto";
function durableAgentId(sessionId, modelId, cwd) {
  const digest = createHash("sha256").update(`${sessionId}\0${modelId}\0${cwd}`).digest("hex").slice(0, 32);
  return `agent-oc-${digest}`;
}

// src/messages.ts
var NO_TOOLS_GUARD = "Do not call tools, search the filesystem, or run shell commands. Reply with text only.";
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && typeof part === "object" && part.type === "text" && "text" in part) {
      return String(part.text ?? "");
    }
    return "";
  }).filter(Boolean).join("\n");
}
function extractImages(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser || !Array.isArray(lastUser.content)) return [];
  const images = [];
  for (const part of lastUser.content) {
    if (!part || typeof part !== "object" || part.type !== "image_url") continue;
    const url = part.image_url?.url;
    if (!url) continue;
    const parsed = parseDataUrl(url);
    if (parsed) images.push(parsed);
  }
  return images;
}
function parseDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return void 0;
  return { mimeType: match[1], data: match[2] };
}
function trailingToolResults(messages) {
  if (messages.length === 0) return void 0;
  const results = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "tool") {
      results.push({
        id: message.tool_call_id ?? "",
        content: textOf(message.content) || "(empty tool result)"
      });
      continue;
    }
    break;
  }
  if (results.length === 0) return void 0;
  return results.reverse();
}
function latestUserText(messages) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  return lastUser ? textOf(lastUser.content) : "";
}
function openingPrompt(messages, opts) {
  const lines = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = textOf(message.content).trim();
    if (text) lines.push(text);
  }
  lines.push(latestUserText(messages).trim() || "Continue.");
  if (!opts?.hasTools) lines.push(NO_TOOLS_GUARD);
  return lines.filter(Boolean).join("\n\n");
}
function followUpPrompt(messages) {
  return latestUserText(messages).trim() || "Continue.";
}

// src/bridge.ts
var TOOL_BATCH_MS = 40;
var HELD_TIMEOUT_MS = 15 * 60 * 1e3;
var SESSION_TTL_MS = 30 * 60 * 1e3;
var CursorBridge = class {
  sessions = /* @__PURE__ */ new Map();
  apiKey;
  cwd;
  runtime;
  catalog;
  catalogAt = 0;
  constructor(options) {
    this.apiKey = options.apiKey;
    this.cwd = options.cwd || process.cwd();
    this.runtime = options.runtime ?? getDefaultRuntime();
  }
  async complete(request, opts) {
    const events = [];
    for await (const event of this.stream(request, opts)) events.push(event);
    return events;
  }
  async *stream(request, opts) {
    this.evictExpired();
    const session = this.session(opts.sessionId, request.model);
    const queue = new AsyncQueue();
    const abort = opts.abortSignal;
    const stop = () => {
      queue.close();
    };
    abort?.addEventListener("abort", stop, { once: true });
    void this.runTurn(session, request, queue, abort).catch((error) => {
      queue.push({ type: "error", error: errorMessage(error) });
      queue.push({ type: "finish", reason: "error" });
      queue.close();
    });
    try {
      yield* queue;
    } finally {
      abort?.removeEventListener("abort", stop);
    }
  }
  async dispose() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => this.drop(session)));
  }
  session(sessionId, modelId) {
    const key = `${sessionId}::${modelId}`;
    const existing = this.sessions.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const session = {
      key,
      sessionId,
      apiKey: this.apiKey,
      cwd: this.cwd,
      modelId,
      catalog: [],
      streamedText: false,
      lastUsed: Date.now()
    };
    this.sessions.set(key, session);
    return session;
  }
  async runTurn(session, request, queue, abort) {
    const results = trailingToolResults(request.messages);
    if (results && session.held && session.run) {
      await this.resumeHeld(session, results, queue, abort);
      return;
    }
    const hasTools = (request.tools?.length ?? 0) > 0;
    const catalog = await this.models();
    session.catalog = catalog;
    const effort = typeof request.reasoning_effort === "string" && request.reasoning_effort || typeof request.reasoningEffort === "string" && request.reasoningEffort || void 0;
    const model = resolveModelSelection(catalog, request.model, effort);
    if (hasTools && session.held) {
      this.abandonHeld(session, "superseded by new turn");
      await session.run?.cancel().catch(() => void 0);
      session.run = void 0;
    }
    let refresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const attached = hasTools ? await this.attachDurableAgent(session, model, refresh) : {
        agent: await this.runtime.createAgent({
          apiKey: session.apiKey,
          cwd: session.cwd,
          model,
          mcp: false
        }),
        continued: false
      };
      const agent = attached.agent;
      const held = this.newHeld();
      const customTools = toolsToCustomTools(
        request.tools,
        (name) => this.parkTool(held, name)
      );
      let streamedText = false;
      let keepHeld = false;
      if (hasTools) {
        session.held = held;
        session.agent = agent;
        session.sink = queue;
        session.streamedText = false;
      }
      const push = (event) => {
        if (hasTools) session.sink?.push(event);
        else queue.push(event);
      };
      const streamed = () => hasTools ? session.streamedText : streamedText;
      try {
        const run = await agent.send({
          text: attached.continued ? followUpPrompt(request.messages) : openingPrompt(request.messages, { hasTools }),
          images: extractImages(request.messages),
          customTools,
          force: true,
          onDelta: (update) => {
            if (update.type === "text-delta" && update.text) {
              streamedText = true;
              if (hasTools) session.streamedText = true;
              push({ type: "text", text: update.text });
            }
            if (update.type === "thinking-delta" && update.text) {
              push({ type: "thinking", text: update.text });
            }
          }
        });
        if (hasTools) session.run = run;
        const outcome = await this.watchRun(session, held, run, queue, abort, {
          streamedText: streamed,
          canRetry: attempt === 0
        });
        keepHeld = hasTools && session.held === held;
        if (outcome === "retry-auth") {
          refresh = true;
          continue;
        }
        return;
      } catch (error) {
        if (attempt === 0 && isAuthError(error) && !streamed()) {
          this.abandonHeld(session, "auth retry");
          refresh = true;
          continue;
        }
        throw error;
      } finally {
        if (!keepHeld) {
          session.run = void 0;
          if (!hasTools) {
            await agent.dispose().catch(() => void 0);
          }
        }
      }
    }
  }
  async attachDurableAgent(session, model, refresh = false) {
    if (refresh) {
      await session.agent?.dispose().catch(() => void 0);
      session.agent = void 0;
    } else if (session.agent) {
      return { agent: session.agent, continued: true };
    }
    const agentId = durableAgentId(session.sessionId, session.modelId, session.cwd);
    const input = {
      apiKey: session.apiKey,
      cwd: session.cwd,
      model,
      mcp: true,
      agentId
    };
    try {
      return { agent: await this.runtime.resumeAgent(agentId, input), continued: true };
    } catch (error) {
      if (!isMissingAgentError(error) && !isAuthError(error)) throw error;
      return { agent: await this.runtime.createAgent(input), continued: false };
    }
  }
  async resumeHeld(session, results, queue, abort) {
    const held = session.held;
    const run = session.run;
    if (!held || !run) {
      queue.push({ type: "error", error: "No in-flight Cursor run to resume" });
      queue.push({ type: "finish", reason: "error" });
      queue.close();
      return;
    }
    session.sink = queue;
    session.streamedText = false;
    for (const result of results) {
      const parked = held.parked.get(result.id);
      if (!parked) continue;
      parked.resolve(result.content);
      held.parked.delete(result.id);
    }
    for (const leftover of held.parked.values()) {
      leftover.resolve("(tool result was not returned by the caller)");
    }
    held.parked.clear();
    held.batch = [];
    await this.watchRun(session, held, run, queue, abort, {
      streamedText: () => session.streamedText
    });
  }
  async watchRun(session, held, run, queue, abort, flags = { streamedText: () => false }) {
    let finished = false;
    const cancelThis = (reason) => {
      if (session.held === held) this.abandonHeld(session, reason);
      run.cancel().catch(() => void 0);
    };
    const timeout = setTimeout(() => cancelThis("timed out waiting for tool results"), HELD_TIMEOUT_MS);
    const onAbort = () => cancelThis("aborted");
    abort?.addEventListener("abort", onAbort, { once: true });
    held.onBatch = (batch) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      abort?.removeEventListener("abort", onAbort);
      queue.push({
        type: "tool_calls",
        calls: batch.map((item) => ({
          id: item.id,
          name: item.name,
          arguments: JSON.stringify(item.args ?? {})
        }))
      });
      queue.push({ type: "finish", reason: "tool_calls" });
      queue.close();
    };
    try {
      const result = await run.wait();
      if (finished) return "closed";
      finished = true;
      clearTimeout(timeout);
      abort?.removeEventListener("abort", onAbort);
      if (held.batch.length > 0) {
        if (session.held === held) {
          session.held = void 0;
          session.run = void 0;
        }
        held.onBatch(held.batch.splice(0));
        return "closed";
      }
      if (result.status === "error" && flags.canRetry && isAuthError(result.error) && !flags.streamedText()) {
        this.abandonHeld(session, "auth retry");
        session.run = void 0;
        return "retry-auth";
      }
      if (session.held === held) {
        session.held = void 0;
        session.run = void 0;
      }
      if (result.usage) queue.push({ type: "usage", usage: toUsage(result.usage) });
      if (result.status === "error") {
        queue.push({
          type: "error",
          error: result.error?.message ?? "Cursor run failed"
        });
        queue.push({ type: "finish", reason: "error" });
      } else if (result.status === "cancelled" && abort?.aborted) {
        queue.push({ type: "finish", reason: "stop" });
      } else {
        if (result.result && !flags.streamedText()) {
          queue.push({ type: "text", text: result.result });
        }
        queue.push({ type: "finish", reason: "stop" });
      }
      queue.close();
      return "closed";
    } catch (error) {
      if (finished) return "closed";
      finished = true;
      clearTimeout(timeout);
      abort?.removeEventListener("abort", onAbort);
      if (flags.canRetry && isAuthError(error) && !flags.streamedText()) {
        this.abandonHeld(session, "auth retry");
        session.run = void 0;
        return "retry-auth";
      }
      if (session.held === held) {
        session.held = void 0;
        session.run = void 0;
      }
      queue.push({ type: "error", error: errorMessage(error) });
      queue.push({ type: "finish", reason: "error" });
      queue.close();
      return "closed";
    }
  }
  newHeld() {
    return { batch: [], parked: /* @__PURE__ */ new Map() };
  }
  parkTool(held, name) {
    return (args, context) => new Promise((resolve, reject) => {
      const id = context.toolCallId || `call_${randomUUID()}`;
      const parked = {
        id,
        name,
        args: args ?? {},
        resolve,
        reject
      };
      held.parked.set(id, parked);
      held.batch.push(parked);
      if (held.timer) clearTimeout(held.timer);
      held.timer = setTimeout(() => {
        const batch = held.batch.splice(0);
        if (batch.length) held.onBatch?.(batch);
      }, TOOL_BATCH_MS);
    });
  }
  abandonHeld(session, reason) {
    const held = session.held;
    session.held = void 0;
    if (!held) return;
    if (held.timer) clearTimeout(held.timer);
    for (const parked of held.parked.values()) {
      parked.reject(new Error(reason));
    }
    held.parked.clear();
    held.batch = [];
  }
  async models() {
    const now = Date.now();
    if (this.catalog && now - this.catalogAt < 6e4) return this.catalog;
    try {
      this.catalog = await this.runtime.listModels(this.apiKey);
      this.catalogAt = now;
      return this.catalog;
    } catch {
      return this.catalog ?? [];
    }
  }
  evictExpired() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastUsed > SESSION_TTL_MS && !session.held) {
        void this.drop(session);
        this.sessions.delete(session.key);
      }
    }
  }
  async drop(session) {
    this.abandonHeld(session, "session disposed");
    await session.run?.cancel().catch(() => void 0);
    await session.agent?.dispose().catch(() => void 0);
  }
};
var AsyncQueue = class {
  items = [];
  waiters = [];
  done = false;
  push(item) {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length) {
      this.waiters.shift()({ value: void 0, done: true });
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) {
        yield this.items.shift();
        continue;
      }
      if (this.done) return;
      const next = await new Promise((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
};
function toUsage(usage) {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  const total = usage.totalTokens ?? prompt + completion;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total
  };
  if (usage.reasoningTokens) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var bridges = /* @__PURE__ */ new Map();
function bridgeFor(options) {
  const key = `${options.apiKey}::${options.cwd ?? ""}`;
  const existing = bridges.get(key);
  if (existing) return existing;
  const created = new CursorBridge(options);
  bridges.set(key, created);
  return created;
}

// src/completions.ts
function sessionIdFrom(headers) {
  return headers.get("x-session-id") || randomUUID2();
}
async function handleChatCompletions(request, options) {
  const bridge = bridgeFor(options);
  const id = `chatcmpl_${randomUUID2()}`;
  const created = Math.floor(Date.now() / 1e3);
  const model = request.model;
  if (request.stream) {
    const stream = encodeSse(
      bridge.stream(request, options),
      { id, created, model, includeUsage: request.stream_options?.include_usage !== false }
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      }
    });
  }
  const events = await bridge.complete(request, options);
  return jsonResponse(eventsToCompletion(events, { id, created, model }));
}
function eventsToCompletion(events, meta) {
  let content = "";
  let reasoning = "";
  let usage;
  let error;
  let finish = "stop";
  const toolCalls = [];
  for (const event of events) {
    if (event.type === "text") content += event.text;
    else if (event.type === "thinking") reasoning += event.text;
    else if (event.type === "tool_calls") toolCalls.push(...event.calls);
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "error") error = event.error;
    else if (event.type === "finish") finish = event.reason;
  }
  if (error && finish === "error") {
    return {
      error: {
        message: error,
        type: "api_error",
        code: "cursor_error"
      }
    };
  }
  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments }
    }));
  }
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish === "error" ? "stop" : finish
      }
    ],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}
function encodeSse(events, meta) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}

`));
      };
      send({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      });
      let finish = "stop";
      let usage;
      let toolIndex = 0;
      try {
        for await (const event of events) {
          if (event.type === "text") {
            send(chunk(meta, { content: event.text }));
          } else if (event.type === "thinking") {
            send(chunk(meta, { reasoning_content: event.text }));
          } else if (event.type === "tool_calls") {
            for (const call of event.calls) {
              send(
                chunk(meta, {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: "" }
                    }
                  ]
                })
              );
              send(
                chunk(meta, {
                  tool_calls: [
                    {
                      index: toolIndex,
                      function: { arguments: call.arguments }
                    }
                  ]
                })
              );
              toolIndex++;
            }
          } else if (event.type === "usage") {
            usage = event.usage;
          } else if (event.type === "error") {
            send({
              error: { message: event.error, type: "api_error", code: "cursor_error" }
            });
          } else if (event.type === "finish") {
            finish = event.reason;
          }
        }
        send({
          id: meta.id,
          object: "chat.completion.chunk",
          created: meta.created,
          model: meta.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finish === "error" ? "stop" : finish
            }
          ],
          ...meta.includeUsage && usage ? { usage } : {}
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        send({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "api_error"
          }
        });
      } finally {
        controller.close();
      }
    }
  });
}
function chunk(meta, delta) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: null }]
  };
}
function jsonResponse(body) {
  const isError = Boolean(body.error);
  return new Response(JSON.stringify(body), {
    status: isError ? 502 : 200,
    headers: { "Content-Type": "application/json" }
  });
}

// src/fetch.ts
function cursorFetch(options, runtime) {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = mergeHeaders(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0);
    if (url.includes("/models") && method === "GET") {
      return listModelsResponse(options.apiKey, runtime);
    }
    if (url.includes("/chat/completions") && method === "POST") {
      const body = await readBody(input, init);
      const request = JSON.parse(body || "{}");
      return handleChatCompletions(request, {
        apiKey: options.apiKey,
        cwd: options.cwd,
        runtime,
        sessionId: sessionIdFrom(headers),
        abortSignal: signal ?? void 0
      });
    }
    return new Response(`Cursor provider: unsupported ${method} ${url}`, { status: 404 });
  };
}
async function listModelsResponse(apiKey, runtime) {
  let models = [];
  try {
    models = await (runtime ?? getDefaultRuntime()).listModels(apiKey);
  } catch {
    models = Object.keys(FALLBACK_MODELS).map((id) => ({ id, displayName: FALLBACK_MODELS[id].name }));
  }
  const data = Object.entries(toConfigModels(models)).map(([id, model]) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
    name: model.name
  }));
  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json" }
  });
}
function mergeHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : void 0);
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
  return headers;
}
async function readBody(input, init) {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (input instanceof Request) return input.text();
  return "";
}

// src/index.ts
var sdkReady;
function ensureRuntime() {
  if (!sdkReady) {
    sdkReady = loadSdkRuntime().then((runtime) => setDefaultRuntime(runtime)).catch((error) => {
      sdkReady = void 0;
      throw error;
    });
  }
  return sdkReady;
}
function createCursor(options) {
  if (!options.apiKey) {
    throw new Error("Cursor: `apiKey` is required; run OpenCode `/connect`");
  }
  const ready = ensureRuntime();
  return createOpenAICompatible({
    name: options.name ?? "cursor",
    baseURL: CURSOR_LOCAL_BASE_URL,
    apiKey: options.apiKey,
    fetch: async (input, init) => {
      await ready;
      return cursorFetch(options)(input, init);
    }
  });
}
export {
  createCursor
};
