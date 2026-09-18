import { strict as assert } from "node:assert"
import { test } from "node:test"
import {
  extractImages,
  followUpPrompt,
  openingTextPrompt,
  openingToolPrompt,
  parseDataUrl,
  textOf,
  trailingToolResults,
} from "../src/messages/index.js"

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

test("openingTextPrompt keeps system text and the latest user turn", () => {
  const text = openingTextPrompt([
    { role: "system", content: "You are OpenCode." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Next" },
  ])
  assert.match(text, /You are OpenCode/)
  assert.match(text, /Next/)
  assert.doesNotMatch(text, /Hello/)
  assert.doesNotMatch(text, /Assistant/)
  assert.match(text, /Reply with text only/)
})

test("openingToolPrompt omits the no-tools guard when tools are present", () => {
  const text = openingToolPrompt([{ role: "user", content: "Hi" }])
  assert.equal(text, "Hi")
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

test("followUpPrompt keeps OpenCode skill catalog metadata", () => {
  const catalog = [
    "<available_skills>",
    "  <skill>",
    "    <name>helper-zoom-docs</name>",
    "    <description>Zoom Docs via helper zoom CLI.</description>",
    "  </skill>",
    "</available_skills>",
  ].join("\n")
  const text = followUpPrompt([
    { role: "system", content: `Skills provide specialized instructions.\n${catalog}` },
    { role: "user", content: "one" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "https://docs.zoom.us/doc/abc" },
  ])
  assert.match(text, /helper-zoom-docs/)
  assert.match(text, /docs\.zoom\.us\/doc\/abc/)
  assert.doesNotMatch(text, /# helper zoom docs/)
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
