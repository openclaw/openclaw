# 提案：启用 Discord Channel（用于 Radar → Discord 投递）

## 现状（2026-02-10）
- OpenClaw stock 插件里 **Discord 插件存在但当前 disabled**：`@openclaw/discord`。
- 当前 `~/.openclaw/openclaw.json` 里 **没有** `channels.discord` 配置。
- 因此 `message` 工具无法识别 `discord` channel（之前 Radar 推送报 Unknown channel）。

## 目标
- 让 OpenClaw 能把“雷达监控”的消息发到 Discord 指定频道（例如 `#常规`，channel id: `1469556111181877342`）。
- 先实现“只发消息”，不做复杂读历史/反向对话，权限最小化。

## 最小化启用步骤（建议顺序）

### 1) 创建/准备 Discord Bot
- Discord Developer Portal → Applications → Bot
- 复制 bot token（**不要**贴进聊天；建议放环境变量）
- 开启 Privileged Gateway Intents：
  - ✅ Message Content Intent（如果要读消息/提及触发则必须；纯发消息可不强制，但建议开）
  - （可选）✅ Server Members Intent（做 allowlist/用户名解析时更顺）

### 2) 邀请 bot 入群（guild）
- OAuth2 URL Generator scopes：`bot` + `applications.commands`（后者可选）
- Bot permissions（最低）：View Channels / Send Messages / Read Message History / Embed Links

### 3) 写入 OpenClaw 配置（两种方式选一）

**方式 A：环境变量（更安全）**
- 设置：`DISCORD_BOT_TOKEN=...`
- 然后只在 `openclaw.json` 里加：

```json5
{
  channels: {
    discord: { enabled: true }
  }
}
```

**方式 B：直接写 config（不推荐，但方便）**

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN"
    }
  }
}
```

> 注意：目前 `openclaw.json` 里已经包含 telegram botToken 等敏感信息；如果继续把 discord token 写进去，建议确保文件权限严格（600）并避免备份外泄。

### 4) 最小化 allowlist（只允许特定 guild + channel）
建议把 guild channel 收紧，避免 bot 在所有频道乱发/乱响应：

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      groupPolicy: "allowlist",
      guilds: {
        "YOUR_GUILD_ID": {
          requireMention: true,
          channels: {
            "1469556111181877342": { allow: true, requireMention: false }
          }
        }
      }
    }
  }
}
```

- 这里 `requireMention:false` 是为了让“工具投递”（非被 mention）也能直接发消息到该频道。
- 如果你不希望 OpenClaw 在频道里主动回复任何人，可以把“入口路由”做成：只允许工具 send，不允许从 Discord 输入触发（需要进一步的 routing/deny，后面再细化）。

### 5) 重启 gateway
- `openclaw gateway restart`
- 验证：`openclaw plugins list` 中 discord 应变为 loaded。

## 发送目标格式（给脚本/工具用）
- guild channel：`channel:<channelId>`
- DM：`user:<userId>`

## 文档来源
- `/home/leonard/moltbot/docs/channels/discord.md`

## 下一步（如果 Leonard 同意我可以继续做）
1) 帮你把 `channels.discord` 最小配置 patch 到 `openclaw.json`（需要你提供 guild id + bot token/环境变量方式）。
2) Radar 监控脚本里新增一个“投递到 Discord”出口（用 message tool），并把 Unknown channel 的失败路径变成明确提示（"Discord channel not configured").
