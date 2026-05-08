# CC API Tracer

实时追踪 Claude Code CLI 与 DeepSeek API 之间的请求/响应，提供 Web UI 和本地 Markdown 文件两种查看方式。

## 快速开始

```bash
node server.js
```

浏览器打开 `http://localhost:3000` 查看 Web 控制台。

## 配置 Claude Code

**方式一：环境变量**

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
```

**方式二：settings.json（持久化）**

编辑 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000"
  }
}
```

## 功能

### Web UI（`http://localhost:3000`）

- **实时请求列表** — 通过 SSE 实时推送，请求先显示为"等待"状态，完成后自动更新状态码和耗时
- **请求详情面板** — 点击请求行展开 Headers / Request / Response 三个 Tab
- **智能格式化** — 根据 Content-Type 自动格式化：JSON 语法高亮树形展开，SSE 流式响应逐事件解析
- **API Key 脱敏** — 界面中 Authorization header 显示为 `sk-****xxxx` 格式
- **清除按钮** — 一键清空当前会话记录

### Trace 文件（`./traces/`）

每次请求完成后自动生成文件，不依赖 Web UI 运行：

```
traces/
├── req-0001-2026-05-08T05-02-01.md          # 请求摘要
├── req-0001-2026-05-08T05-02-01-request.json  # 请求体
└── req-0001-2026-05-08T05-02-01-response.json # 响应体
```

请求体单独保存为 `.json` 或 `.txt` 文件，在 Markdown 中通过链接引用，避免大文件影响阅读。

Markdown 摘要包含：

- 基本信息表（Method、Path、Time、Duration、Status、Size）
- Request / Response Headers（API Key 脱敏）
- 指向 Request / Response Body 文件的链接

## 工作原理

```
Claude Code CLI ──→ Proxy (localhost:3000) ──→ DeepSeek API
                        │
                   Web UI (:3000)
                   Trace 文件 (./traces/)
```

代理透明透传所有请求，不修改 Authorization header，API Key 仅在你本地的 Claude Code 中配置。

流式响应采用逐块透传，Claude Code 实时收到 token，代理同时累积完整响应用于记录。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 代理服务器端口 |
| `DEEPSEEK_BASE` | `https://api.deepseek.com/anthropic` | 目标 API 地址 |
| `MAX_REQUESTS` | `500` | Web UI 内存中最大请求数 |
| `MAX_BODY_SIZE` | `2097152` (2MB) | Web UI 中单个 body 最大存储字节数 |
| `TRACE_DIR` | `./traces` | Trace 文件输出目录 |

> **注意**：`MAX_BODY_SIZE` 仅限制 Web UI 的展示，Trace 文件始终保存完整的请求/响应体。
