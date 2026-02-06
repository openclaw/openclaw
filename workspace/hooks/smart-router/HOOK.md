---
name: smart-router
description: "Smart model routing based on context length and task type"
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["model:select"],
        "install": [{ "id": "workspace", "kind": "workspace", "label": "Workspace hook" }],
      },
  }
---

# Smart Router Hook

智能路由 hook，根据 context 长度和任务类型选择最适合的模型。

## 功能

1. **Context 长度路由** — 长 context 优先用大 context window 模型
2. **任务类型路由** — 代码任务用 Claude，对话用 DeepSeek
3. **成本优化** — 简单任务用便宜模型

## 事件

监听 `model:select` 事件，在模型选择前介入。

## 路由规则

| 条件                    | 选择模型                    |
| ----------------------- | --------------------------- |
| `taskHint === "code"`   | `anthropic/claude-opus-4-5` |
| `taskHint === "chat"`   | `deepseek/deepseek-chat`    |
| `contextLength > 64000` | `anthropic/claude-opus-4-5` |
| `contextLength < 4000`  | `deepseek/deepseek-chat`    |
| 默认                    | 不干预                      |

## 返回值

```javascript
return {
  overrideModel: "provider/model",     // 覆盖首选模型
  // 或
  prependCandidates: [                 // 在候选列表前添加
    { provider: "anthropic", model: "claude-opus-4-5" }
  ],
  // 或
  overrideCandidates: [...]            // 完全替换候选列表
};
```

## 配置

在 `openclaw.json` 启用：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "smart-router": {
          "enabled": true
        }
      }
    }
  }
}
```
