# Agent Reach - AI Agent 全网调研工具

**整理时间**: 2026-02-26
**来源**: Jackao 赛人笔记

---

## 📌 项目简介

**Agent Reach** 是一个开源的 AI Agent 调研能力增强工具，一句话就能让 Agent 具备全网数据获取能力。

**核心数据**:
- GitHub 星标：1.4k+
- 开源免费
- 零 API 费用
- 维护活跃（2 小时前还在更新）

**项目地址**: https://github.com/Pannantong/Agent-Reach

---

## 🎯 解决的痛点

现在的 AI Agent 写代码、生成文档、管项目已经很强了，但一到"上网查资料"就原形毕露：

1. ❌ "帮我总结这个 YouTube 教程" → 拿不到字幕
2. ❌ "小红书上这个产品口碑如何？" → 登录墙+反爬
3. ❌ "推特上大家怎么吐槽竞品？" → Twitter API 按量付费
4. ❌ "Reddit 有类似 bug 的帖子吗？" → 服务器 IP 直接 403
5. ❌ "GitHub 这个仓库最新 Issue 说了啥？" → 配置 gh CLI 超麻烦

**Agent Reach 的解决方案**: 一键把"眼睛"安上，把所有选型、配置、维护的脏活累活全干了。

---

## ✨ 核心亮点

### 1. 一句话安装

```
帮我安装 Agent Reach: https://raw.githubusercontent.com/Pannantong/agent-reach/main/docs/install.md
```

### 2. 完全免费，零 API 费用

所有底层工具都是开源免费的：
- Jina Reader
- yt-dlp
- bird
- mcpporter
- gh CLI

唯一可能花钱的是上网代理。

### 3. 隐私安全拉满

- Cookie/Token 只存在本地 `~/.agent-reach/config.yaml`（权限 600）
- 不上传、不外传
- 支持 `--safe` 安全模式和 `--dry-run` 预览

### 4. 可插拔架构

每个平台一个独立 channel 文件（web、twitter、xiaohongshu...）。
不喜欢当前工具？换掉就行，不影响其他。

### 5. 自带医生+监控

- `agent-reach doctor` 一键体检
- `agent-reach watch` 可设每日自动巡检

### 6. 兼容所有主流 Agent

Claude Code / Cursor / OpenClaw / Windsurf 都能用，本地电脑/服务器都行。

---

## 📊 支持的平台

**目前已支持**（持续更新）:

| 平台 | 功能 |
|------|------|
| 任意网页 | Jina Reader 清洗 |
| YouTube / B站 | 字幕+搜索 |
| Twitter/X | 读帖+搜索+发帖 |
| Reddit | 搜索+读帖 |
| GitHub | 公开/私有+搜索 |
| 小红书 | 读+搜+发帖+评论+点赞 |
| LinkedIn / Boss直聘 | 最新 v1.0 新增 |
| RSS / 全网语义搜索 | Exa via MCP，免费无 Key |

---

## 🚀 安装教程

### 方式一：一键全自动（推荐）

```
帮我安装 Agent Reach: https://raw.githubusercontent.com/Pannantong/agent-reach/main/docs/install.md
```

Agent 会自动：
1. pip 安装主包
2. 检测环境（本地/服务器）
3. 安装 Node.js、gh CLI、bird、mcpporter 等依赖
4. 配置 Exa 搜索引擎
5. 在 skills 目录写入 SKILL.md
6. 最后跑 `agent-reach doctor` 给你看报告

### 方式二：安全模式（服务器/谨慎用户）

```
帮我安装 Agent Reach（安全模式）: https://raw.githubusercontent.com/Pannantong/agent-reach/main/docs/install.md
```

（内部用 `--safe` 参数，不会自动装系统包）

### 方式三：纯预览（先看看会干啥）

```
agent-reach install --env=auto --dry
```

### 安装后必跑

```
agent-reach doctor
```

看到 ✅ 的就直接用，❌ 的按提示配就行。

---

## 🔧 需要人工配置的渠道

### 1. Twitter/X（搜索+发帖必配）

告诉 Agent："帮我配 Twitter"
它会引导你用 Chrome 插件 Cookie-Editor 导出 Header String（推荐用小号）

命令：`agent-reach configure twitter-cookies "你的字符串"`

### 2. 小红书（最强信息源）

需要 Docker 跑 MCP 服务。
Agent 会自动帮你拉镜像、扫码登录（本地）或引导导出 Cookie（服务器）。
服务器建议加代理防风控。

### 3. Reddit / B站（服务器必配）

`agent-reach configure proxy http://user:pass@ip:port`

推荐 Webshare 住宅代理（1$/月，够用）

### 4. LinkedIn / Boss直聘（v1.0 新增）

同样引导扫码或 VNC 登录，超简单。

**小贴士**: 所有 Cookie 建议用专用小号，一旦泄露损失可控。

---

## 💡 实际使用例子

Agent 自己会读 SKILL.md，零记忆负担：

1. "帮我看看这个 YouTube 视频讲了啥"
   → 自动 yt-dlp 提取字幕+总结

2. "小红书上搜'极简收纳'最新笔记"
   → mcpporter 调用 xiaohongshu.search_feeds

3. "推特上大家怎么评价 Grok 4？"
   → bird 搜索

4. "GitHub 上最新的 LLM 框架对比仓库"
   → gh search

5. "全网语义搜索 2026 年最佳 AI Agent 工具"
   → Exa 免费搜索

6. "这个链接内容总结一下"
   → curl https://r.jina.ai/URL

**最爽的是**: 你完全不用记命令，Agent 全自动。

---

## 📊 深度分析

### 优点（9.5/10）

1. ✅ 真正解决了"配置地狱"
2. ✅ 免费+可插拔，长期主义者的福音
3. ✅ 维护极度活跃（2 小时前还在更新）
4. ✅ 性能极轻，本地电脑几乎零成本

### 潜在不足

1. ⚠️ 依赖 Cookie 的平台有一定风控风险（用小号可规避）
2. ⚠️ 平台一旦改反爬，需要等作者/社区修复（目前更新非常快）

### 对比其他方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| Perplexity / Tavily | 方便 | 贵，数据新鲜度一般 |
| Firecrawl + 自写 skill | 强大 | 配置麻烦 |
| **Agent Reach** | 免费 + 简单 + 可自定义 | 需要配置 Cookie |

**结论**: Agent Reach = 免费 + 简单 + 可自定义 的最优解

---

## 🎯 使用建议

### 1. 本地电脑优先

完全不需要代理，体验最佳。

### 2. 服务器部署

先买个 1$/月代理，配好后让 Agent 设 watch 每日巡检。

### 3. 安全第一

永远用小号 Cookie，定期备份 `~/.agent-reach/`。

### 4. 进阶玩法

clone 仓库，自己改 channel 文件（加 Instagram、抖音等）。

### 5. 组合使用

Agent Reach 负责"取数据"，再喂给 Claude / Grok / Gemini 做深度分析，效果翻倍。

### 6. 监控更新

每周跑一次 `agent-reach check-update`，或设 cron 自动通知。

---

## 🔗 对 OpenClaw 用户的价值

**完美契合 OpenClaw**:

1. ✅ 可以直接用 OpenClaw 安装
2. ✅ 安装后自动写入 skills 目录
3. ✅ OpenClaw 可以自动调用 Agent Reach 的能力
4. ✅ 支持设置 `agent-reach watch` 每日自动巡检

**实际应用场景**:

1. **市场调研**: 搜集小红书、知乎、B站上的用户反馈
2. **竞品分析**: 追踪竞品在各大平台的表现
3. **内容创作**: 获取热门话题和素材
4. **客户服务**: 快速检索相关问题和解决方案

---

## 🚀 快速启动

复制下面这句话，现在就去试试：

```
帮我安装 Agent Reach: https://raw.githubusercontent.com/Pannantong/agent-reach/main/docs/install.md
```

---

**整理者**: 朝堂（三省六部 AI 助手）
**整理时间**: 2026-02-26
