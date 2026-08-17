import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  extractImages,
  followUpPrompt,
  formatTranscript,
  parseDataUrl,
  textOf,
  trailingToolResults,
} from "../src/messages.js"

test("textOf joins text parts and ignores images", () => {
  assert.equal(textOf("hello"), "hello")
  assert.equal(
    textOf([
      { type: "text", text: "a" },
      { type: "image_url", image_url: { url: "http://x" } },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  )
})

test("trailingToolResults only reads a suffix of tool messages", () => {
  assert.equal(
    trailingToolResults([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]),
    undefined,
  )

  const results = trailingToolResults([
    { role: "user", content: "hi" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "out" },
  ])
  assert.deepEqual(results, [{ id: "c1", content: "out" }])
})

test("formatTranscript includes system prompt and a no-tools guard", () => {
  const text = formatTranscript(
    [
      { role: "system", content: "You are OpenCode." },
      { role: "user", content: "Hello" },
    ],
    { hasTools: false },
  )
  assert.match(text, /You are OpenCode/)
  assert.match(text, /User:\nHello/)
  assert.match(text, /Reply with text only/)
})

test("formatTranscript omits the no-tools guard when tools are present", () => {
  const text = formatTranscript([{ role: "user", content: "Hi" }], { hasTools: true })
  assert.doesNotMatch(text, /Reply with text only/)
})

test("followUpPrompt uses the latest user text", () => {
  assert.equal(
    followUpPrompt([
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "two" },
    ]),
    "two",
  )
})

test("parseDataUrl and extractImages read base64 image parts", () => {
  const parsed = parseDataUrl("data:image/png;base64,abcd")
  assert.deepEqual(parsed, { mimeType: "image/png", data: "abcd" })
  const images = extractImages([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,xyz" } }],
    },
  ])
  assert.deepEqual(images, [{ mimeType: "image/jpeg", data: "xyz" }])
})
