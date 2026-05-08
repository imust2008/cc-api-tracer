# CC API Tracer

实时追踪和查看 Claude Code CLI 与 DeepSeek API 之间的请求/响应，类似 Chrome DevTools 的 Network 面板。

## 启动

```bash
node server.js
```

打开 http://localhost:3000 查看 Web UI。

## 配置 Claude Code

设置环境变量将 API 请求指向代理：

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
```

或在 `~/.claude/settings.json` 中持久化：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000"
  }
}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 代理服务器端口 |
| DEEPSEEK_BASE | https://api.deepseek.com | 目标 API 地址 |
| MAX_REQUESTS | 500 | 内存中最大请求数 |
| MAX_BODY_SIZE | 102400 | 单个 body 最大存储字节数 |

## 使用

1. 启动 `node server.js`
2. 浏览器打开 `http://localhost:3000`
3. 配置 Claude Code 使用 `http://localhost:3000` 作为 API 端点
4. 在 Claude Code 中发送消息，观察 Web UI 实时显示 API 请求
