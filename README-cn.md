# opencode-cursor-sdk

一个基于官方 [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) 的 OpenCode V2
provider 包，不需要本地 HTTP 中转进程。

Cursor SDK 是**智能体运行时**，不是原始 chat completions 接口。OpenCode V2 配置中的
`aisdk:` 是 OpenCode 的 AI SDK provider 加载前缀；本包提供会被该机制加载的 provider
工厂。OpenCode 继续负责自己的 agent loop 和工具。Cursor 自带的文件系统和终端工具会被关闭，OpenCode 工具会注册为
Cursor custom tools，并在 OpenCode 执行前保持 hold 状态。

## 架构

包根入口同时导出 AI SDK provider 工厂和 V2 server plugin：

```text
providers.cursor.package = "aisdk:opencode-cursor-sdk"
plugins = ["opencode-cursor-sdk"]
          │
          ├─ V2 integration transform：/connect 凭证
          ├─ V2 provider transform：Cursor.models.list() 模型目录
          └─ createCursor() → 进程内 OpenAI-compatible fetch
```

provider 工厂保留现有 Cursor agent 和工具桥。plugin 使用 V2 的
`Plugin.define`、`integration.transform` 和 `provider.transform`；凭证变化后会自动
刷新模型。

## 安装配置

需要 **OpenCode V2** 和 **Node.js >= 26**。

把下面内容加入 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "name": "Cursor",
      "package": "aisdk:opencode-cursor-sdk"
    }
  },
  "plugins": ["opencode-cursor-sdk"]
}
```

provider 必须使用 `aisdk:` 前缀，表示让 OpenCode 使用 AI SDK provider loader 加载本包的
`createCursor()` 工厂，并向工厂传入 provider 配置和凭证。plugin 从包的 default export
加载。OpenCode 会通过包加载器解析这两个包名。

如果需要直接加载本地代码，可以将两个配置改为 `file://` URL：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "cursor": {
      "name": "Cursor",
      "package": "aisdk:file:///absolute/path/to/opencode-cursor-sdk"
    }
  },
  "plugins": ["file:///absolute/path/to/opencode-cursor-sdk"]
}
```

运行 `/connect`，选择 **Cursor**，然后使用浏览器登录，或粘贴
[Cursor Dashboard → API Keys](https://cursor.com/dashboard/api) 中的 key。OpenCode
会将凭证保存为 V2 integration credential，并在请求时注入。也可以设置
`CURSOR_API_KEY`，用于模型发现和请求。

## 选项

plugin 会自动把当前 OpenCode 项目目录作为 Cursor agent 的工作目录。不要把凭证写进
`opencode.json`。

| 选项 | 必填 | 含义 |
| --- | --- | --- |
| `apiKey` | 是 | Cursor 用户或服务账号 key，由 V2 integration 提供 |
| `cwd` | 自动 | 当前 OpenCode 项目目录 |

## 模型发现

plugin 会把 `Cursor.models.list()` 返回的全部模型发布到 V2 provider registry。

- provider 只发布 `Cursor.models.list()` 返回的实时模型。
- 如果 Cursor 没有返回模型，provider 仍然存在，但模型目录为空。
- 配置中的模型条目会作为 overlay，并在 ID 冲突时优先。
- Cursor variants 会转换为 OpenCode variants，包括 Fast 和 Max Mode。
- 凭证变化会触发刷新。

不加载 plugin 时，需要自己在 `providers.cursor.models` 中列出模型，并为 `cursor`
配置 V2 integration credential。

## 范围

- 这不是 ACP `cursor-agent` 包。
- 这不是嵌套 Cursor coding agent，也不接入 Cursor Cloud Agent。
- OpenCode 仍然负责文件、终端、编辑和 agent loop。
