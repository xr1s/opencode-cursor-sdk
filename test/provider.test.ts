import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createCursor } from "../src/index.js"

test("createCursor requires a /connect API key", () => {
  assert.throws(
    () => createCursor({ apiKey: "" } as never),
    /apiKey/,
  )
})

test("createCursor returns a languageModel factory", () => {
  const provider = createCursor({ apiKey: "test-key" })
  assert.equal(typeof provider.languageModel, "function")
})
