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

test("read and edit map Cursor path aliases onto path", () => {
  assert.deepEqual(compatToolArgs("read", { filePath: "/tmp/a.ts", offset: 10 }), {
    path: "/tmp/a.ts",
    offset: 10,
  })
  assert.deepEqual(
    compatToolArgs("edit", {
      target_file: "/tmp/a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    }),
    { path: "/tmp/a.ts", oldString: "a", newString: "b", replaceAll: true },
  )
})

test("write maps Cursor path and content aliases", () => {
  assert.deepEqual(compatToolArgs("write", { filePath: "/tmp/a.ts", contents: "hi" }), {
    path: "/tmp/a.ts",
    content: "hi",
  })
})

test("bash maps working_directory onto workdir", () => {
  assert.deepEqual(compatToolArgs("bash", { command: "ls", working_directory: "/tmp" }), {
    command: "ls",
    workdir: "/tmp",
  })
})

test("skill maps Cursor skill aliases onto OpenCode id", () => {
  assert.deepEqual(compatToolArgs("skill", { skill_name: "example-skill" }), {
    id: "example-skill",
  })
  assert.deepEqual(compatToolArgs("skill", { skill: "example-skill" }), {
    id: "example-skill",
  })
  assert.deepEqual(compatToolArgs("skill", { name: "example-skill", skill: "other" }), {
    id: "example-skill",
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
