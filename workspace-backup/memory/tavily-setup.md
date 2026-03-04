# Tavily API 配置指南

**配置时间**: 2026-02-26
**目的**: 为 OpenClaw 配置 AI 优化的网页搜索能力
**状态**: ✅ 技能已安装，只需配置 API Key

---

## 📌 什么是 Tavily

Tavily 是专门为 AI Agent 设计的搜索引擎 API，返回干净、相关的内容片段。

**优势**:
- ✅ AI 优化（专为 Agent 设计）
- ✅ 返回简洁、相关的内容
- ✅ 支持深度搜索（--deep）
- ✅ 支持新闻搜索（--topic news）
- ✅ 可提取网页内容
- ✅ 免费版：每月 1000 次搜索

**对比 Brave Search**:
- Brave：通用搜索，免费 2000 次/月
- **Tavily**：AI 优化，免费 1000 次/月，结果更精准

---

## 🚀 快速配置步骤（3 分钟）

### 步骤 1：获取 Tavily API Key

1. **访问 Tavily 官网**:
   ```
   https://tavily.com
   ```

2. **点击 "Get Started Free"** 或 **"Sign Up"**

3. **注册账号**（可以用 Google/GitHub 账号）

4. **获取 API Key**:
   - 登录后进入 Dashboard
   - 找到 API Key（格式：`tvly-xxxxxxxxxxxxxxxxxxxxxxxx`）
   - 复制保存

**API Key 示例**:
```
tvly-1234567890abcdefghijklmnopqrstuvwxyz
```

**免费额度**: 每月 1000 次搜索

---

### 步骤 2：配置到 OpenClaw

**方式 A：设置环境变量（推荐）**

编辑 `~/.bashrc` 或 `~/.zshrc`，添加：
```bash
export TAVILY_API_KEY="tvly-你的API_KEY"
```

示例：
```bash
export TAVILY_API_KEY="tvly-1234567890abcdefghijklmnopqrstuvwxyz"
```

然后重启终端或运行：
```bash
source ~/.bashrc
```

---

**方式 B：使用 openclaw config set**

```bash
openclaw config set tavily.apiKey "tvly-你的API_KEY"
```

---

**方式 C：直接在 Gateway 环境中设置**

如果你使用 Gateway，可以在启动前设置：
```bash
export TAVILY_API_KEY="tvly-你的API_KEY"
openclaw gateway
```

---

### 步骤 3：测试配置

运行测试命令：
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/search.mjs "OpenClaw AI"
```

如果返回搜索结果，说明配置成功！

---

## 💡 使用方法

### 基础搜索（5 个结果）
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/search.mjs "小红书 AI 自动化"
```

### 增加结果数量（10 个）
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/search.mjs "小红书 AI 自动化" -n 10
```

### 深度搜索（更全面）
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/search.mjs "OpenClaw 使用教程" --deep
```

### 新闻搜索
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/search.mjs "AI Agent 最新动态" --topic news
```

### 提取网页内容
```bash
node /home/node/.openclaw/workspace/skills/tavily-search/scripts/extract.mjs "https://example.com/article"
```

---

## 📊 配置后能力

配置 Tavily 后，臣（朝堂）可以帮你：

### 1. 小红书调研
```
"帮我搜索小红书上最火的 AI 自动化笔记"
→ 臣会调用 Tavily 搜索并分析结果
```

### 2. 竞品分析
```
"帮我搜竞品 XX 的用户评价"
→ 搜索各大平台的相关讨论
```

### 3. 内容创作
```
"帮我搜最近关于 AI Agent 的技术文章"
→ 获取最新的技术文章和教程
```

### 4. 深度研究
```
"帮我深入研究 OpenClaw 的最佳实践"
→ 使用 --deep 参数进行全面搜索
```

### 5. 新闻追踪
```
"帮我搜最近 7 天的 AI 行业新闻"
→ 使用 --topic news 参数
```

---

## 🎯 实际应用场景（小红书获客）

### 场景 1：爆款研究
```bash
# 搜索小红书热门内容
node .../search.mjs "小红书 AI 自动化 热门" -n 10

# 分析标题、内容、互动数据
# 模仿并优化
```

### 场景 2：用户痛点挖掘
```bash
# 搜索用户吐槽
node .../search.mjs "飞书 自动化 问题 难用" --deep

# 了解真实需求
# 打造解决方案
```

### 场景 3：行业趋势追踪
```bash
# 搜索最新趋势
node .../search.mjs "AI Agent 2026 趋势" --topic news --days 7

# 抢占先机
# 创作相关内容
```

---

## ⚠️ 注意事项

1. **API 限制**:
   - 免费版：1000 次/月
   - 如果不够，可升级付费（$29/月，10,000 次）

2. **使用建议**:
   - 优先使用基础搜索（5 个结果）
   - 重要任务才用 --deep
   - 避免短时间内大量请求

3. **对比 Tavily vs Brave**:
   - **Tavily**: AI 优化，结果更精准，1000 次/月
   - **Brave**: 通用搜索，次数更多，2000 次/月
   - **建议**: 都配置上，根据场景选择

---

## 🔧 故障排查

**问题 1：API Key 无效**
- 检查格式：应该是 `tvly-` 开头
- 检查是否完整复制
- 重新获取新的 Key

**问题 2：环境变量不生效**
- 确认重启了终端
- 确认在正确的 shell 配置文件中设置
- 运行 `echo $TAVILY_API_KEY` 检查

**问题 3：搜索失败**
- 检查网络连接
- 检查 API 额度是否用完
- 查看 Tavily Dashboard 的使用情况

---

## 🚀 配置完成后

配置成功后，臣会立即帮你：

1. **搜集小红书爆款**
   ```
   "帮我搜小红书上最近最火的 AI 自动化笔记"
   ```

2. **分析竞品**
   ```
   "帮我搜竞品 XX 的优缺点"
   ```

3. **追踪热点**
   ```
   "帮我搜最近 3 天的 AI 行业新闻"
   ```

---

## 📝 配置检查清单

- [ ] 访问 https://tavily.com
- [ ] 注册/登录账号
- [ ] 获取 API Key
- [ ] 复制 API Key（tvly-...）
- [ ] 设置环境变量或配置
- [ ] 测试搜索功能
- [ ] 开始使用！

---

## 💰 费用说明

**免费版**:
- ✅ 1000 次搜索/月
- ✅ 基础搜索
- ✅ 内容提取
- ✅ 新闻搜索

**付费版**（$29/月）:
- ✅ 10,000 次搜索/月
- ✅ 深度搜索
- ✅ 优先支持
- ✅ 高级功能

**建议**: 先用免费版，不够再升级

---

**准备时间**: 约 3 分钟
**难度**: ⭐（非常简单）
**费用**: 免费（1000 次/月）
**状态**: ✅ 技能已安装，只需配置 API Key

---

**下一步**:
1. 现在去 https://tavily.com 获取 API Key
2. 拿到 Key 后告诉臣，臣帮你完成配置
3. 配置完成后立即开始小红书调研！

---

**配置命令**（拿到 Key 后运行）:
```bash
export TAVILY_API_KEY="tvly-你的API_KEY"
```
