import { strict as assert } from "node:assert"
import { test } from "node:test"
import { durableAgentId } from "../src/agent-id.js"
import { CursorBridge, resetBridges } from "../src/bridge.js"
import { eventsToCompletion } from "../src/completions.js"
import type { ChatCompletionRequest } from "../src/openai-types.js"
import type { CreateAgentInput, CursorAgent, CursorRuntime, SendInput } from "../src/runtime.js"
import type { CursorModelListItem } from "../src/models.js"

type ScriptStep =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; args?: Record<string, unknown>; id?: string }
  | { type: "end" }
  | { type: "error"; error: string }
  | { type: "throw"; error: string }

function scriptedRuntime(
  script: ScriptStep[] | ((input: CreateAgentInput) => ScriptStep[]),
  models: CursorModelListItem[] = [{ id: "composer-2.5" }],
): CursorRuntime & {
  prompts: string[]
  created: CreateAgentInput[]
  resumed: string[]
  disposed: number
} {
  const prompts: string[] = []
  const created: CreateAgentInput[] = []
  const resumed: string[] = []
  const store = new Map<string, CursorAgent>()
  const runtime: CursorRuntime & {
    prompts: string[]
    created: CreateAgentInput[]
    resumed: string[]
    disposed: number
  } = {
    prompts,
    created,
    resumed,
    disposed: 0,
    async listModels() {
      return models
    },
    async createAgent(input) {
      created.push(input)
      const agentId = input.agentId ?? `agent-throwaway-${created.length}`
      const steps = typeof script === "function" ? script(input) : script.map((step) => ({ ...step }))
      let index = 0
      const agent: CursorAgent = {
        agentId,
        async send(sendInput: SendInput) {
          prompts.push(sendInput.text)
          return {
            async wait() {
              let text = ""
              while (index < steps.length) {
                const step = steps[index++]
                if (step.type === "end") break
                if (step.type === "error") {
                  return { status: "error" as const, error: { message: step.error } }
                }
                if (step.type === "throw") {
                  throw new Error(step.error)
                }
                if (step.type === "text") {
                  text += step.text
                  await sendInput.onDelta?.({ type: "text-delta", text: step.text })
                } else if (step.type === "thinking") {
                  await sendInput.onDelta?.({ type: "thinking-delta", text: step.text })
                } else if (step.type === "tool") {
                  const tool = sendInput.customTools?.[step.name]
                  if (!tool) throw new Error(`missing tool ${step.name}`)
                  await tool.execute(step.args ?? {}, { toolCallId: step.id ?? "call_1" })
                }
              }
              return {
                status: "finished" as const,
                result: text,
                usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
              }
            },
            async cancel() {},
          }
        },
        async dispose() {
          runtime.disposed++
        },
      }
      store.set(agentId, agent)
      return agent
    },
    async resumeAgent(agentId) {
      const agent = store.get(agentId)
      if (!agent) throw new Error(`Agent ${agentId} not found`)
      resumed.push(agentId)
      return agent
    },
  }
  return runtime
}

function request(over: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "composer-2.5",
    messages: [{ role: "user", content: "Hello" }],
    ...over,
  }
}

const bashTools = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
]

test("text-only completion streams deltas once and reports usage", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([{ type: "text", text: "Hi" }])
  const bridge = new CursorBridge({ apiKey: "k", runtime })
  const events = await bridge.complete(request(), { sessionId: "s1" })
  const text = events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)
  assert.deepEqual(text, ["Hi"])
  assert.equal(events.at(-1)?.type, "finish")
  assert.ok(events.find((event) => event.type === "usage"))
  assert.equal(runtime.created[0]?.mcp, false)
  assert.equal(runtime.created[0]?.agentId, undefined)
})

test("hold-mode tool calls pause the run until tool results arrive", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([
    { type: "tool", name: "bash", args: { command: "ls" }, id: "call_1" },
    { type: "text", text: "listed" },
  ])
  const bridge = new CursorBridge({ apiKey: "k", runtime })

  const first = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "list files" }] }),
    { sessionId: "s2" },
  )
  const toolEvent = first.find((event) => event.type === "tool_calls")
  assert.ok(toolEvent && toolEvent.type === "tool_calls")
  assert.equal(toolEvent.calls[0].name, "bash")
  assert.equal(JSON.parse(toolEvent.calls[0].arguments).command, "ls")
  const finish = first.at(-1)
  assert.ok(finish?.type === "finish")
  assert.equal(finish.reason, "tool_calls")
  assert.equal(runtime.created[0]?.mcp, true)
  assert.equal(
    runtime.created[0]?.agentId,
    durableAgentId("s2", "composer-2.5", process.cwd()),
  )

  const second = await bridge.complete(
    request({
      tools: bashTools,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "README.md" },
      ],
    }),
    { sessionId: "s2" },
  )
  const reply = second.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)
  assert.deepEqual(reply, ["listed"])
  assert.equal(runtime.created.length, 1)
  await bridge.dispose()
})

test("title-style calls do not mix into a held tool loop", async () => {
  await resetBridges()
  const runtime = scriptedRuntime((input) =>
    input.mcp
      ? [
          { type: "tool", name: "bash", args: { command: "ls" }, id: "call_1" },
          { type: "text", text: "listed" },
        ]
      : [{ type: "text", text: "short title" }],
  )
  const bridge = new CursorBridge({ apiKey: "k", runtime })

  const held = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "list files" }] }),
    { sessionId: "s3" },
  )
  const heldFinish = held.at(-1)
  assert.ok(heldFinish?.type === "finish")
  assert.equal(heldFinish.reason, "tool_calls")

  const title = await bridge.complete(
    request({
      messages: [
        { role: "system", content: "Generate a 3 word title" },
        { role: "user", content: "list files" },
      ],
    }),
    { sessionId: "s3" },
  )
  const titleText = title
    .filter((event) => event.type === "text")
    .map((event) => (event as { text: string }).text)
    .join("")
  assert.equal(titleText, "short title")
  assert.match(runtime.prompts[1] ?? "", /Generate a 3 word title/)

  const resumed = await bridge.complete(
    request({
      tools: bashTools,
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    }),
    { sessionId: "s3" },
  )
  const reply = resumed.filter((event) => event.type === "text").map((event) => (event as { text: string }).text)
  assert.deepEqual(reply, ["listed"])
  await bridge.dispose()
})

test("throwaway turns send an opening prompt, not a follow-up", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([{ type: "text", text: "ok" }])
  const bridge = new CursorBridge({ apiKey: "k", runtime })
  await bridge.complete(request({ messages: [{ role: "user", content: "first" }] }), { sessionId: "s4" })
  await bridge.complete(
    request({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    }),
    { sessionId: "s4" },
  )
  assert.equal(runtime.created.length, 2)
  assert.match(runtime.prompts[0] ?? "", /first/)
  assert.match(runtime.prompts[1] ?? "", /second/)
  assert.doesNotMatch(runtime.prompts[1] ?? "", /first/)
  await bridge.dispose()
})

test("tool turns reuse the Cursor agent and send only the follow-up", async () => {
  await resetBridges()
  const runtime = scriptedRuntime((input) =>
    input.mcp
      ? [
          { type: "text", text: "one" },
          { type: "end" },
          { type: "text", text: "two" },
        ]
      : [{ type: "text", text: "short title" }],
  )
  const bridge = new CursorBridge({ apiKey: "k", runtime })

  const first = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "first" }] }),
    { sessionId: "s5" },
  )
  assert.deepEqual(
    first.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["one"],
  )

  const title = await bridge.complete(
    request({
      messages: [
        { role: "system", content: "Generate a 3 word title" },
        { role: "user", content: "first" },
      ],
    }),
    { sessionId: "s5" },
  )
  assert.equal(
    title
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join(""),
    "short title",
  )

  const second = await bridge.complete(
    request({
      tools: bashTools,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "one" },
        { role: "user", content: "second" },
      ],
    }),
    { sessionId: "s5" },
  )
  assert.deepEqual(
    second.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["two"],
  )
  assert.equal(runtime.created.length, 2)
  assert.equal(runtime.disposed, 1)
  assert.equal(runtime.prompts[0], "first")
  assert.match(runtime.prompts[1] ?? "", /Generate a 3 word title/)
  assert.equal(runtime.prompts[2], "second")
  await bridge.dispose()
})

test("a new process resumes the Cursor agent and does not replay history", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([
    { type: "text", text: "one" },
    { type: "end" },
    { type: "text", text: "two" },
  ])
  const first = new CursorBridge({ apiKey: "k", cwd: "/tmp/proj", runtime })
  await first.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "first" }] }),
    { sessionId: "s6" },
  )
  await first.dispose()
  await resetBridges()

  const second = new CursorBridge({ apiKey: "k", cwd: "/tmp/proj", runtime })
  const events = await second.complete(
    request({
      tools: bashTools,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "one" },
        { role: "user", content: "second" },
      ],
    }),
    { sessionId: "s6" },
  )
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["two"],
  )
  assert.equal(runtime.created.length, 1)
  assert.deepEqual(runtime.resumed, [durableAgentId("s6", "composer-2.5", "/tmp/proj")])
  assert.equal(runtime.prompts[0], "first")
  assert.equal(runtime.prompts[1], "second")
  await second.dispose()
})

test("eventsToCompletion builds an OpenAI-shaped tool_calls response", () => {
  const body = eventsToCompletion(
    [
      { type: "thinking", text: "plan" },
      { type: "tool_calls", calls: [{ id: "c1", name: "bash", arguments: "{}" }] },
      { type: "finish", reason: "tool_calls" },
    ],
    { id: "id", created: 1, model: "composer-2.5" },
  )
  const choice = (body.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0]
  assert.equal(choice.finish_reason, "tool_calls")
  assert.equal(choice.message.reasoning_content, "plan")
  assert.ok(Array.isArray(choice.message.tool_calls))
})

const AUTH_ERROR = "Authentication error If you are logged in, try logging out and back in."

test("auth errors on a durable agent are retried after refresh", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([
    { type: "error", error: AUTH_ERROR },
    { type: "text", text: "recovered" },
  ])
  const bridge = new CursorBridge({ apiKey: "k", runtime })
  const events = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "hello" }] }),
    { sessionId: "s-auth" },
  )
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["recovered"],
  )
  assert.equal(events.find((event) => event.type === "error"), undefined)
  assert.equal(runtime.created.length, 1)
  assert.deepEqual(runtime.resumed, [durableAgentId("s-auth", "composer-2.5", process.cwd())])
  await bridge.dispose()
})

test("resume auth errors fall back to creating a new agent", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([{ type: "text", text: "fresh" }])
  const originalResume = runtime.resumeAgent.bind(runtime)
  runtime.resumeAgent = async (agentId, input) => {
    if (runtime.resumed.length === 0) {
      runtime.resumed.push(agentId)
      throw new Error(AUTH_ERROR)
    }
    return originalResume(agentId, input)
  }
  const bridge = new CursorBridge({ apiKey: "k", cwd: "/tmp/proj", runtime })
  const events = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "hello" }] }),
    { sessionId: "s-auth-resume" },
  )
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["fresh"],
  )
  assert.equal(runtime.created.length, 1)
  assert.equal(runtime.resumed[0], durableAgentId("s-auth-resume", "composer-2.5", "/tmp/proj"))
  await bridge.dispose()
})

test("non-auth errors are not retried", async () => {
  await resetBridges()
  const runtime = scriptedRuntime([{ type: "error", error: "model overloaded" }])
  const bridge = new CursorBridge({ apiKey: "k", runtime })
  const events = await bridge.complete(
    request({ tools: bashTools, messages: [{ role: "user", content: "hello" }] }),
    { sessionId: "s-other-err" },
  )
  const error = events.find((event) => event.type === "error")
  assert.ok(error && error.type === "error")
  assert.equal(error.error, "model overloaded")
  assert.equal(runtime.created.length, 1)
  assert.equal(runtime.resumed.length, 0)
  await bridge.dispose()
})

test("auth errors on throwaway turns retry with a new agent", async () => {
  await resetBridges()
  const runtime = scriptedRuntime((input) =>
    input.mcp
      ? [{ type: "text", text: "unused" }]
      : runtime.created.length === 1
        ? [{ type: "error", error: AUTH_ERROR }]
        : [{ type: "text", text: "ok" }],
  )
  const bridge = new CursorBridge({ apiKey: "k", runtime })
  const events = await bridge.complete(request({ messages: [{ role: "user", content: "hi" }] }), {
    sessionId: "s-auth-throwaway",
  })
  assert.deepEqual(
    events.filter((event) => event.type === "text").map((event) => (event as { text: string }).text),
    ["ok"],
  )
  assert.equal(runtime.created.length, 2)
  await bridge.dispose()
})


