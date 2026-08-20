# AGENTS.md

本仓库是 Cursor Agent 接入 OpenCode 的 **provider** 与 **plugin** 代码。OpenCode 保留自己的 agent loop 和工具；本包通过官方 `@cursor/sdk` 把 Cursor 托管模型暴露成 OpenAI-compatible 后端。Cursor 自带的文件系统/shell 工具会被关掉，OpenCode 的工具以 custom tools 注册进 Cursor，再由 hold-mode bridge 交回 OpenCode 执行。

两块入口由 OpenCode 分别加载：

- **provider**：`src/index.ts` 的 `createCursor()`（`exports["."]`）
- **plugin**：`src/plugin.ts`（`exports["./server"]`），负责 `/connect` 鉴权和 `Cursor.models.list()` 模型发现

## 结构

```
src/
  index.ts         provider 工厂：包一层 @ai-sdk/openai-compatible，用进程内 fetch，不走网络
  plugin.ts        plugin 入口，只导出 createCursorPlugin()
  plugin-core.ts   /connect + 模型发现实现
  fetch.ts         把 /models、/chat/completions 转成本地处理
  completions.ts   chat completions → SSE/非流式 Response
  bridge.ts        Cursor Agent ↔ OpenCode tools 的 hold-mode 桥
  runtime.ts       @cursor/sdk 运行时封装
  messages.ts      OpenAI messages ↔ Cursor prompt / tool results
  models.ts        模型列表、variant、fallback
  agent-id.ts      agent / tool-call id
  options.ts       provider options 与本地 baseURL
  openai-types.ts  OpenAI-compatible 请求/事件类型
test/              对应单元测试
dist/              tsup 产物（提交进 git，git 依赖安装时无需构建）
```

## 禁忌

Cursor Agent 是有状态的 runtime，不是无状态 chat-completions API。OpenCode 保留 agent loop；本包只做适配。下面是已经用 commit 修掉的坑。

**不要把 OpenAI transcript 整段再喂给 Cursor。** 有 tools 的主会话用 durable `agentId`（session + model + cwd），进程重启后 `Agent.resume`。`openingPrompt` 只发 system/developer + 最新 user；follow-up 只发最新 user。

**title / compaction / 无 tools 的 turn 不要碰主 agent。** 必须新建一次性 agent（无 `agentId`、`mcp: false`），禁止复用或 cancel 正在 hold 的工具循环。

**不要 TTL 清掉 idle session。** 进程内 handle 要留着；只有 agent not found / auth 失败才落到 `create`。

**重试必须很窄。** 只对 auth 和瞬时网络错误（premature close 等）重试一次，且还没向 OpenCode 吐过 text。已经 stream 过再 retry 会重复输出。model overloaded 这类不要 retry。SSE cancel 之后禁止再 `enqueue` / `close`。

**不要打开 Cursor 自带 filesystem/shell。** `tools: ["mcp"]` 才允许 OpenCode custom tools；不要上 Cloud Agent（`Agent.create({ cloud })`）。Cursor 的 `toolCallId` 可能超长、含换行，出站前压成 OpenAI 兼容（≤64，`[A-Za-z0-9_-]`）。

**打包 / OpenCode 加载**

- `dist/` 提交进 git；script 禁止叫 `build` / `prepare` / `postinstall`（OpenCode 内置 npm 拉 git 依赖会套一层 install 然后失败）；不要 sourcemap
- `plugin.ts` 只能导出 plugin 函数，其它放 `plugin-core.ts`
- 模型列表用 `config()` 注入，不要指望 `provider.models()`（自定义 provider 不会被调）
- 不要把 `apiKey` 写进 `opencode.json`

## 常用命令

- `pnpm install`
- `pnpm run build:tsup`（不要用名为 `build` / `prepare` / `postinstall` 的 script）
- `pnpm test`
- `pnpm run typecheck`
