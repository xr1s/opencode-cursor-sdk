import { strict as assert } from "node:assert"
import { test } from "node:test"
import { compatToolArgs } from "../src/tool-args.js"

test("glob maps Cursor glob_pattern onto OpenCode pattern", () => {
  assert.deepEqual(compatToolArgs("glob", { glob_pattern: "**/*.ts", target_directory: "/tmp" }), {
    pattern: "**/*.ts",
    path: "/tmp",
  })
})

test("glob keeps OpenCode pattern and drops aliases", () => {
  assert.deepEqual(
    compatToolArgs("glob", { pattern: "src/**/*.ts", glob_pattern: "**/*" }),
    { pattern: "src/**/*.ts" },
  )
})

test("grep maps Cursor glob filter onto include", () => {
  assert.deepEqual(compatToolArgs("grep", { pattern: "compatToolArgs", glob: "*.ts" }), {
    pattern: "compatToolArgs",
    include: "*.ts",
  })
})

test("read and edit map target_file onto filePath", () => {
  assert.deepEqual(compatToolArgs("read", { target_file: "/tmp/a.ts", offset: 10 }), {
    filePath: "/tmp/a.ts",
    offset: 10,
  })
  assert.deepEqual(
    compatToolArgs("edit", {
      target_file: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    }),
    { filePath: "/tmp/a.ts", oldString: "a", newString: "b", replaceAll: true },
  )
})

test("write maps contents onto content", () => {
  assert.deepEqual(compatToolArgs("write", { target_file: "/tmp/a.ts", contents: "hi" }), {
    filePath: "/tmp/a.ts",
    content: "hi",
  })
})

test("bash maps working_directory onto workdir", () => {
  assert.deepEqual(compatToolArgs("bash", { command: "ls", working_directory: "/tmp" }), {
    command: "ls",
    workdir: "/tmp",
  })
})

test("skill maps Cursor skill_name onto OpenCode name", () => {
  assert.deepEqual(compatToolArgs("skill", { skill_name: "helper-zoom-docs" }), {
    name: "helper-zoom-docs",
  })
  assert.deepEqual(compatToolArgs("skill", { skill: "helper-zoom-docs" }), {
    name: "helper-zoom-docs",
  })
  assert.deepEqual(compatToolArgs("skill", { name: "helper-zoom-docs", skill: "other" }), {
    name: "helper-zoom-docs",
  })
})

test("unknown tools are left unchanged", () => {
  assert.deepEqual(compatToolArgs("question", { questions: ["a"] }), {
    questions: ["a"],
  })
})

test("empty glob args stay empty so OpenCode can reject them", () => {
  assert.deepEqual(compatToolArgs("glob", {}),
    {},
  )
})
