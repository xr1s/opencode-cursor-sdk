# opencode-cursor-sdk

一个 OpenCode provider 包，通过官方
[`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) 调用你的 Cursor
订阅。不涉及任何本地 HTTP 中转进程。

Cursor SDK 是一套**智能体运行时**，不是原始的 chat completions 接口。本包仍然作为
OpenCode 的模型 provider 接入：OpenCode 继续跑自己的 agent 循环和工具，Cursor
托管的模型暴露成 OpenAI 兼容后端。Cursor 自带的文件系统/终端工具会被关掉；
OpenCode 的工具注册为 Cursor custom tools，并在 OpenCode 真正执行之前一直 hold
住。

`apiKey` 是必填项，缺失时会直接抛错。**永远不需要你自己手写 `apiKey`**：
OpenCode 会在启动时，把你通过 `/connect` 存好的 key 自动注入进来。

## 架构

这个包对 OpenCode 暴露了两个相互独立加载的部分：一个 **provider 工厂函数**
（`src/index.ts`）和一个**插件**（`src/plugin.ts`）。

```
                    ┌────────────────────────────────┐
                    │ provider: "cursor"             │
                    │ plugin: ["opencode-cursor-sdk"]    │
                    └───────────────┬────────────────┘
                                    │ OpenCode 启动时
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │ plugin.ts  auth + config()               │
                    │ /connect → Cursor API key                │
                    │ Cursor.models.list() → provider.models   │
                    └───────────────┬──────────────────────────┘
                                    │
                                    ▼
                    createCursor() → @ai-sdk/openai-compatible
                                    │ 进程内 fetch
                                    ▼
                    本地 Cursor Agent（无内置工具）
                    + hold 模式桥接 OpenCode 工具
```

| 部分 | 作用 |
| --- | --- |
| `src/index.ts` `createCursor()` | OpenCode 的 `create*` provider 工厂。用 `@ai-sdk/openai-compatible` 包一层进程内 `fetch`，不会打到真实网络。 |
| `src/plugin.ts` | 注册 `/connect`（浏览器登录或 API key），并用 `Cursor.models.list()` 发现模型。 |

真正和 Cursor 通信的是 `npm` 字段。如果自己手写 `models` 列表，plugin 可以不配；
但 `/connect` 里出现 **Cursor**、以及按账号自动填充 `/models`，都靠 plugin。

## 安装

需要 **Node.js >= 22.13**（`@cursor/sdk` 自己的最低版本）。

把本包加进 OpenCode 配置（已有 `provider` / `plugin` 的话只追加，不要覆盖）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "npm": "opencode-cursor-sdk",
      "name": "Cursor",
      "models": {},
      "options": {}
    }
  },
  "plugin": ["opencode-cursor-sdk"]
}
```

`plugin` 条目必须和 `provider.npm` 是**同一段字符串**，不要加 `/plugin` 或
`/server` 后缀。OpenCode 会在安装后从本包的 `exports["./server"]` 自己解析插件入口。

也可以不用 npm、改用 git URL。specifier 前面要带包名
（`opencode-cursor-sdk@git+https://github.com/<user>/<repo>.git`），否则 OpenCode
无法识别缓存、每次启动都会重新安装。npm 12+ 默认 `allow-git=none`；走 git
安装的话需要先执行 `npm config --global set allow-git all`，否则 OpenCode
的安装器会静默装成一个空包。

然后在 OpenCode 里运行 `/connect`，选择 **Cursor**，再二选一：

1. **Log in with Cursor (browser)** — 通过 `Cursor.auth.login()` 在浏览器登录并签发一把用户 API key（默认 90 天）
2. **Cursor API Key** — 从 [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api) 粘贴一把 key

OpenCode 会把凭证存到 `~/.local/share/opencode/auth.json`，启动时自动作为
`apiKey` 传给 provider 工厂。你也可以设置环境变量 `CURSOR_API_KEY`：还没跑过
`/connect` 时，插件会用它来做模型发现。

SDK 用量按你的 Cursor 套餐计费（和 IDE 同一套请求池 / Privacy Mode）。花费会出现在
usage dashboard 的 SDK 标签下。

### 本地开发

如果是在改这个包本身，用绝对 `file://` 路径指向本地目录。改完
`pnpm run build:tsup` 后重启 OpenCode 即可生效：

```json
{
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/opencode-cursor-sdk",
      "name": "Cursor",
      "models": {},
      "options": {}
    }
  },
  "plugin": ["file:///absolute/path/to/opencode-cursor-sdk/dist/plugin.js"]
}
```

```bash
pnpm install
pnpm run build:tsup
```

每次改完都要重新 `pnpm run build:tsup`，并重启 OpenCode。

## 选项

下面除了 `apiKey` 以外，都是你在 `opencode.json` 的
`provider.cursor.options` 里自己配的。`apiKey` 由 OpenCode 从 `/connect`
注入——不要把它写进配置文件。

| 选项 | 必填 | 含义 |
| --- | --- | --- |
| `apiKey` | 是 | Cursor 用户或服务账号 API key；由 `/connect` 注入 |
| `cwd` | 否 | 本地 Cursor agent 的工作目录。插件默认写成当前 OpenCode 项目目录 |

## 模型自动发现

注册捆绑插件后，**你 Cursor 账号能用的全部模型**会出现在 OpenCode 的
`/models` 选择器里。插件在 OpenCode 启动时调用 `Cursor.models.list()`，把结果写进
`provider.cursor.models`。

- 还没 `/connect`（也没设 `CURSOR_API_KEY`）时，使用一小份兜底列表：
  `composer-2.5` 和 `auto`。
- `/connect` 之后，实时目录会替换这份列表。你手写的 `models` 条目在 id 冲突时仍然优先。
- Cursor 的变体（例如 Composer Fast）会变成 OpenCode 的 `/variants`。用
  `opencode run --variant fast ...` 或 TUI 的变体选择器切换。

不配 plugin 时，OpenCode 仍会从 `npm` 加载 provider，但你必须自己在
`provider.cursor.models` 里列出模型，并用 `/connect` → Other、provider id 填
`cursor` 来登录。

## 范围

- **这不是 ACP / `cursor-agent` 那类接入。** 本包用官方 `@cursor/sdk`，OpenCode 仍然是 agent。
- **这不是套娃 Cursor 编程智能体。** OpenCode 仍然是 agent：读文件、跑命令、改代码
  都用它自己的工具。Cursor SDK 只作为这些回合的托管模型后端。
- **这不是 Cursor Cloud Agents / 自动开 PR。** 运行留在本地 runtime，才能桥接
  OpenCode 的工具。`Agent.create({ cloud })` 不在范围内。
- **不提供 embeddings。**
