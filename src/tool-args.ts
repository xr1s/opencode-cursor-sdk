/** Map Cursor-native tool args onto OpenCode's schema before forwarding. */

type FieldAliases = Record<string, readonly string[]>

const TOOL_FIELDS: Record<string, FieldAliases> = {
  glob: {
    pattern: ["pattern", "glob_pattern", "globPattern"],
    path: ["path", "target_directory", "targetDirectory", "directory"],
  },
  grep: {
    pattern: ["pattern", "regex", "query"],
    path: ["path", "target_directory", "targetDirectory"],
    include: ["include", "glob", "glob_pattern", "globPattern"],
  },
  read: {
    filePath: ["filePath", "file_path", "target_file", "targetFile", "path"],
    offset: ["offset"],
    limit: ["limit"],
  },
  edit: {
    filePath: ["filePath", "file_path", "target_file", "targetFile", "path"],
    oldString: ["oldString", "old_string"],
    newString: ["newString", "new_string"],
    replaceAll: ["replaceAll", "replace_all"],
  },
  write: {
    filePath: ["filePath", "file_path", "target_file", "targetFile", "path"],
    content: ["content", "contents"],
  },
  bash: {
    command: ["command", "cmd"],
    workdir: ["workdir", "working_directory", "workingDirectory", "cwd"],
    timeout: ["timeout", "block_until_ms"],
  },
  webfetch: {
    url: ["url", "uri"],
    format: ["format"],
  },
  skill: {
    name: ["name", "skill", "skill_name", "skillName", "id"],
  },
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

export function compatToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fields = TOOL_FIELDS[name.toLowerCase()]
  const out: Record<string, unknown> = { ...(args ?? {}) }
  if (!fields) return out

  for (const [canonical, aliases] of Object.entries(fields)) {
    if (!present(out[canonical])) {
      for (const alias of aliases) {
        if (alias === canonical || !present(out[alias])) continue
        out[canonical] = out[alias]
        break
      }
    }
    for (const alias of aliases) {
      if (alias !== canonical) delete out[alias]
    }
  }
  return out
}
