# Brave Search API 配置指南

**配置时间**: 2026-02-26
**目的**: 为 OpenClaw 配置免费的网页搜索能力

---

## 📌 什么是 Brave Search API

Brave Search 是一个注重隐私的搜索引擎，提供免费的 API 供开发者使用。

**优势**:
- ✅ 免费使用
- ✅ 无需信用卡
- ✅ 注重隐私
- ✅ 搜索质量高
- ✅ 每月 2000 次免费查询

---

## 🚀 快速配置步骤（3 分钟）

### 步骤 1：获取 Brave Search API Key

1. **访问 Brave Search API**:
   ```
   https://brave.com/search/api/
   ```

2. **点击 "Get Started"** 或 **"Sign Up"**

3. **注册账号**（如果还没有）
   - 可以用 Google/GitHub/Microsoft 账号快速注册

4. **创建 API Key**:
   - 登录后进入 Dashboard
   - 点击 "Create API Key"
   - 复制生成的 API Key（格式：`BSA******************`）

**API Key 示例**:
```
BSA1234567890abcdefghijklmnopqrstuvwxyz
```

---

### 步骤 2：配置到 OpenClaw

**方式 A：交互式配置（推荐）**

在终端运行：
```bash
openclaw configure --section web
```

然后按提示输入你的 Brave API Key。

---

**方式 B：使用 config set 命令**

```bash
openclaw config set brave.apiKey "你的API_KEY"
```

示例：
```bash
openclaw config set brave.apiKey "BSA1234567890abcdefghijklmnopqrstuvwxyz"
```

---

**方式 C：设置环境变量**

编辑 `~/.bashrc` 或 `~/.zshrc`，添加：
```bash
export BRAVE_API_KEY="BSA1234567890abcdefghijklmnopqrstuvwxyz"
```

然后重启终端或运行：
```bash
source ~/.bashrc
```

---

### 步骤 3：测试配置

运行以下命令测试：
```bash
openclaw config get brave.apiKey
```

如果返回你的 API Key，说明配置成功！

---

## 💡 使用方法

配置完成后，可以直接在对话中使用：

**示例 1：搜索 OpenClaw 相关信息**
```
"帮我搜索 OpenClaw 的最新使用教程"
```

**示例 2：搜索小红书相关内容**
```
"帮我搜索小红书上最火的 AI 自动化笔记"
```

**示例 3：搜索技术文章**
```
"帮我搜索最近关于 AI Agent 的技术文章"
```

---

## 📊 配置后能力

配置 Brave Search 后，你将获得：

1. ✅ **全网搜索能力**
   - 实时搜索结果
   - 高质量内容

2. ✅ **内容提取能力**
   - 网页内容提取
   - Markdown 格式输出

3. ✅ **小红书调研能力**
   - 搜索小红书相关内容
   - 分析热门话题
   - 获取创作灵感

---

## ⚠️ 注意事项

1. **API 限制**:
   - 免费版：每月 2000 次查询
   - 如果不够用，可以考虑付费升级

2. **隐私保护**:
   - Brave 不会追踪你的搜索
   - 数据不会被出售

3. **使用建议**:
   - 避免短时间内大量搜索
   - 合理使用免费额度

---

## 🔧 故障排查

**问题 1：API Key 无效**
- 检查是否完整复制
- 检查是否有多余空格
- 重新生成一个新的 Key

**问题 2：配置后无法使用**
- 检查环境变量是否设置成功
- 重启 OpenClaw Gateway
- 检查 API Key 是否过期

**问题 3：搜索次数用完**
- 等待下月重置
- 或升级付费计划

---

## 🚀 配置完成后

配置成功后，臣（朝堂）可以帮你：

1. **搜集小红书爆款**
   - "帮我搜小红书上最近 7 天点赞最多的'AI 自动化'笔记"

2. **追踪行业热点**
   - "帮我搜最近关于 OpenClaw 的技术文章"

3. **竞品分析**
   - "帮我搜小红书上大家怎么评价'XX 竞品'"

4. **内容创作**
   - "帮我搜 B 站上关于 AI Agent 的视频"

---

## 📝 配置检查清单

- [ ] 访问 Brave Search API 网站
- [ ] 注册/登录账号
- [ ] 创建 API Key
- [ ] 复制 API Key
- [ ] 运行 `openclaw configure --section web`
- [ ] 输入 API Key
- [ ] 测试搜索功能

---

**准备时间**: 约 3 分钟
**难度**: ⭐（非常简单）
**费用**: 免费

---

**下一步**: 获取 API Key 后，告诉臣，臣会帮你完成配置！
