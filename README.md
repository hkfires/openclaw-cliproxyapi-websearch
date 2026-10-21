# openclaw-cliproxyapi-websearch

A native `web_search` plugin for [OpenClaw](https://github.com/openclaw) paired with [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider). It directly reuses your existing CLIProxyAPI connection and credentials with no extra search API key or secondary authentication required.

[English](#openclaw-cliproxyapi-websearch) | [中文说明](#中文说明)

## Features

- **Zero Configuration**: No plugin settings or setup commands required.
- **Follows Active Model**: Always searches with the active CLIProxyAPI session model ID; fails directly without switching or falling back when the session uses another provider.
- **Isolated Sub-requests**: Dispatches standalone Responses requests containing only the native `web_search` tool, without session history or local tools.
- **Sources & Elapsed Time**: Streams search results and returns the summary, deduplicated source links, and execution time.

## Requirements

- **OpenClaw**: `>=2026.9.4`
- **Node.js**: `>=24.16.0 <25 || >=26.1.0`
- **CLIProxyAPI**: `>=v7.3.5` (with an active model that supports native web search)
- [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider) installed and configured

## Installation & Setup

### 1. Install Plugins

```sh
# 1. Install and enable the CLIProxyAPI provider plugin (if not already installed)
openclaw plugins install clawhub:openclaw-cliproxyapi-provider
openclaw plugins enable cliproxyapi

# 2. Install and enable this web search plugin
openclaw plugins install clawhub:openclaw-cliproxyapi-websearch
openclaw plugins enable cliproxyapi-websearch
```

Or install from npm:

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
openclaw plugins install npm:openclaw-cliproxyapi-websearch
```

Local development install:

```sh
npm ci && npm run build
openclaw plugins install --link .
openclaw plugins enable cliproxyapi-websearch
```

### 2. Configure & Enable

#### Option 1: Via CLI Commands (Recommended)

Disable OpenClaw's built-in `web_search` tool (to avoid name conflicts), allow this plugin tool, and restart the gateway:

```sh
openclaw plugins enable cliproxyapi-websearch
openclaw config set tools.web.search.enabled false --strict-json
openclaw config set tools.alsoAllow '["cliproxyapi-websearch"]' --strict-json
openclaw gateway restart
```

#### Option 2: Edit Configuration File

Or edit `~/.openclaw/openclaw.json` directly:

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": false
      }
    },
    "alsoAllow": ["cliproxyapi-websearch"]
  },
  "plugins": {
    "entries": {
      "cliproxyapi-websearch": {
        "enabled": true
      }
    }
  }
}
```

Then validate and restart the gateway:

```sh
openclaw config validate
openclaw gateway restart
```

> Do not use `tools.deny: ["web_search"]` to disable built-in search, as that will also block this plugin's `web_search` tool. If `plugins.allow` is configured, add `cliproxyapi-websearch` to the allowlist.

Once restarted, the agent will automatically call `web_search({ query })` whenever the session uses a `cliproxyapi/<model-id>` model.

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

- **零配置**：没有插件配置项，也不需要设置命令。
- **跟随当前模型**：始终使用当前会话的 CLIProxyAPI 模型 ID 发起搜索；当前不是 CLIProxyAPI 模型时直接报错，不自动切换或回退。
- **纯净子请求**：独立发起仅包含原生 `web_search` 的 Responses 请求，不携带会话历史或本地工具，避免混合工具冲突。
- **自动附加来源与耗时**：流式接收搜索结果，返回总结、去重来源链接与执行耗时。

## 环境要求

- **OpenClaw**：`>=2026.9.4`
- **Node.js**：`>=24.16.0 <25 || >=26.1.0`
- **CLIProxyAPI**：`>=v7.3.5`，且当前模型支持原生网络搜索
- 已安装并配置 [`openclaw-cliproxyapi-provider`](https://www.npmjs.com/package/openclaw-cliproxyapi-provider)

## 安装与配置

### 1. 安装插件

```sh
# 1. 安装并启用 CLIProxyAPI Provider 插件（若未安装）
openclaw plugins install clawhub:openclaw-cliproxyapi-provider
openclaw plugins enable cliproxyapi

# 2. 安装并启用本搜索插件
openclaw plugins install clawhub:openclaw-cliproxyapi-websearch
openclaw plugins enable cliproxyapi-websearch
```

也可以从 npm 安装：

```sh
openclaw plugins install npm:openclaw-cliproxyapi-provider
openclaw plugins install npm:openclaw-cliproxyapi-websearch
```

本地开发安装：

```sh
npm ci && npm run build
openclaw plugins install --link .
openclaw plugins enable cliproxyapi-websearch
```

### 2. 配置与启用

#### 方式 1：通过命令行配置（推荐）

关闭 OpenClaw 内置 `web_search`（避免同名冲突）、放行本插件工具并重启网关：

```sh
openclaw plugins enable cliproxyapi-websearch
openclaw config set tools.web.search.enabled false --strict-json
openclaw config set tools.alsoAllow '["cliproxyapi-websearch"]' --strict-json
openclaw gateway restart
```

#### 方式 2：修改配置文件

也可以直接编辑 `~/.openclaw/openclaw.json`：

```json
{
  "tools": {
    "web": {
      "search": {
        "enabled": false
      }
    },
    "alsoAllow": ["cliproxyapi-websearch"]
  },
  "plugins": {
    "entries": {
      "cliproxyapi-websearch": {
        "enabled": true
      }
    }
  }
}
```

保存后校验并重启网关：

```sh
openclaw config validate
openclaw gateway restart
```

> 不要使用 `tools.deny: ["web_search"]` 关闭内置搜索，否则本插件注册的同名工具也会被禁用。若配置了 `plugins.allow`，请将 `cliproxyapi-websearch` 加入列表。

重启后，当会话使用 `cliproxyapi/<model-id>` 模型时，Agent 会自动调用 `web_search({ query })` 执行实时搜索。

## 开发与测试

```sh
npm run check      # 类型检查与单元测试
npm run test:host  # OpenClaw 宿主测试
npm run build      # 构建
```

## License

MIT
