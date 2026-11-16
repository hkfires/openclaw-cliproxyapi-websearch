# openclaw-cliproxyapi-websearch

A native `web_search` plugin for [OpenClaw](https://github.com/openclaw) paired with [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider). It directly reuses your existing CLIProxyAPI connection and credentials with no extra search API key or secondary authentication required.

[English](#openclaw-cliproxyapi-websearch) | [中文说明](#中文说明)

## Features

- **No Extra Auth**: Reuses your existing CLIProxyAPI connection and credentials out of the box with zero required settings.
- **Active Model & Optional Fallback**: Uses the active CLIProxyAPI session model by default; optionally prefers a dedicated `searchModel` and automatically falls back to the active session model if unavailable.
- **Isolated Sub-requests**: Dispatches standalone Responses requests containing only the native `web_search` tool, without session history or local tools.
- **Sources & Elapsed Time**: Streams search results and returns the summary, deduplicated source links, and execution time.

## Requirements

- **OpenClaw**: `>=2026.9.4`
- **Node.js**: `>=24.16.0 <25 || >=26.1.0`
- **CLIProxyAPI**: `>=v7.3.5` (with a search model that supports native web search)
- [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider) installed and configured

## Installation & Configuration

### 1. Install Plugin

Choose one method below:

#### Install from ClawHub

```sh
openclaw plugins install clawhub:openclaw-cliproxyapi-websearch
```

#### Install from npm

```sh
openclaw plugins install npm:openclaw-cliproxyapi-websearch
```

#### Local development

```sh
npm ci && npm run build
openclaw plugins install --link .
```

### 2. Configure

Disable OpenClaw's built-in `web_search` tool to avoid name conflicts, and optionally configure a preferred `searchModel`. Changes take effect automatically via hot reload without manual Gateway restart.

#### Option 1: Via CLI Commands (Recommended)

```sh
# Required: disable built-in web_search
openclaw config set tools.web.search.enabled false --strict-json

# Optional: prefer a dedicated search model (falls back to the active session model if unavailable)
openclaw config set plugins.entries.cliproxyapi-websearch.config.searchModel gpt-6-luna
```

To clear `searchModel` and return to using the active session model directly:

```sh
openclaw config unset plugins.entries.cliproxyapi-websearch.config.searchModel
```

#### Option 2: Edit `~/.openclaw/openclaw.json`

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": false
      }
    }
  },
  "plugins": {
    "entries": {
      "cliproxyapi-websearch": {
        "enabled": true,
        "config": {
          "searchModel": "gpt-6-luna"
        }
      }
    }
  }
}
```

*(Omit `config.searchModel` if you always want to search with the active session model. You can run `openclaw config validate` to verify syntax after editing.)*

> Do not use `tools.deny: ["web_search"]` to disable built-in search, as that will also block this plugin's `web_search` tool. If `plugins.allow` is configured, add `cliproxyapi-websearch` to the allowlist.

Whenever a session uses a `cliproxyapi/<model-id>` model, the agent will automatically call `web_search({ query })` for online research.

## Development

```sh
npm run check      # Typecheck and unit tests
npm run test:host  # OpenClaw host smoke test
npm run build      # Build
```

---

# 中文说明

为 [OpenClaw](https://github.com/openclaw) 提供 CLIProxyAPI 原生 `web_search` 工具，搭配 [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider) 使用。直接复用 Provider 已有的连接与凭据，无需额外搜索 API Key 或二次认证。

## 特性

- **免额外鉴权**：直接复用已有 CLIProxyAPI 连接与凭据，默认零配置开箱即用。
- **跟随当前模型与按需回退**：默认使用当前会话的 CLIProxyAPI 模型；也可配置专用 `searchModel`，不可用时自动回退到当前会话模型。
- **纯净子请求**：独立发起仅包含原生 `web_search` 的 Responses 请求，不携带会话历史或本地工具，避免混合工具冲突。
- **自动附加来源与耗时**：流式接收搜索结果，返回总结、去重来源链接与执行耗时。

## 环境要求

- **OpenClaw**：`>=2026.9.4`
- **Node.js**：`>=24.16.0 <25 || >=26.1.0`
- **CLIProxyAPI**：`>=v7.3.5`，且搜索所用模型支持原生网络搜索
- 已安装并配置 [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider)

## 安装与配置

### 1. 安装插件

以下方式任选其一：

#### 从 ClawHub 安装

```sh
openclaw plugins install clawhub:openclaw-cliproxyapi-websearch
```

#### 从 npm 安装

```sh
openclaw plugins install npm:openclaw-cliproxyapi-websearch
```

#### 本地开发安装

```sh
npm ci && npm run build
openclaw plugins install --link .
```

### 2. 配置

关闭 OpenClaw 内置 `web_search` 以避免同名冲突，并可按需指定专用搜索模型 `searchModel`。修改会自动热加载生效，无需手动重启网关。

#### 方式 1：通过命令行配置（推荐）

```sh
# 必选：关闭内置 web_search
openclaw config set tools.web.search.enabled false --strict-json

# 可选：指定专用搜索模型（不可用时自动回退到当前会话模型）
openclaw config set plugins.entries.cliproxyapi-websearch.config.searchModel gpt-6-luna
```

如需取消专用搜索模型、恢复直接使用当前会话模型：

```sh
openclaw config unset plugins.entries.cliproxyapi-websearch.config.searchModel
```

#### 方式 2：编辑 `~/.openclaw/openclaw.json`

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": false
      }
    }
  },
  "plugins": {
    "entries": {
      "cliproxyapi-websearch": {
        "enabled": true,
        "config": {
          "searchModel": "gpt-6-luna"
        }
      }
    }
  }
}
```

*（若希望始终跟随当前会话模型，省略 `config.searchModel` 即可；手动编辑后可运行 `openclaw config validate` 校验语法。）*

> 不要使用 `tools.deny: ["web_search"]` 关闭内置搜索，否则本插件注册的同名工具也会被禁用。若配置了 `plugins.allow`，请将 `cliproxyapi-websearch` 加入列表。

配置完成后，当会话使用 `cliproxyapi/<model-id>` 模型时，Agent 会自动调用 `web_search({ query })` 执行实时搜索。

## 开发与测试

```sh
npm run check      # 类型检查与单元测试
npm run test:host  # OpenClaw 宿主测试
npm run build      # 构建
```

## License

MIT
