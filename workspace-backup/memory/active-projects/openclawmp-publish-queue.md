# 水产市场发布队列

**项目状态**：等待认证
**创建时间**：2026-03-01 10:46
**最后更新**：2026-03-01 10:50

---

## 待发布资产（按优先级）

### 0. ⭐ 新生成资产（2026-03-01 12:08）
- **定制早报配置经验** - Experience
  - 状态：✅ 准备就绪
  - 文件：`passive_income_assets/定制早报配置经验-2026-03-01.md`
  - 描述：每日自动生成定制早报，整合天气、目标、任务、动态

- **Subagent自主项目管理经验** - Experience
  - 状态：✅ 准备就绪
  - 文件：`passive_income_assets/Subagent自主项目管理经验-2026-03-01.md`
  - 描述：STATE.yaml模式实现去中心化项目管理

- **三层记忆系统实战经验** - Experience
  - 状态：✅ 准备就绪
  - 文件：`passive_income_assets/三层记忆系统实战经验-2026-03-01.md`
  - 描述：三层记忆架构+语义搜索实战指南

### 1. 🔥 agent-autonomy-kit
- **类型**：Skill
- **价值**：高（自主工作能力）
- **版本**：1.0.0
- **描述**：Stop waiting for prompts. Keep working.
- **状态**：✅ 准备就绪

### 2. 🔍 find-skills
- **类型**：Skill
- **价值**：高（技能发现）
- **版本**：-
- **描述**：帮助用户发现和安装 agent 技能
- **状态**：✅ 准备就绪

### 3. 🗺️ planning-with-files
- **类型**：Skill
- **价值**：高（任务规划）
- **版本**：2.10.0
- **描述**：文件化规划系统，支持复杂任务管理
- **状态**：✅ 准备就绪

### 4. 🌐 tavily-search
- **类型**：Skill
- **价值**：中（搜索增强）
- **版本**：-
- **描述**：AI优化的网络搜索
- **状态**：✅ 准备就绪

### 5. 🎬 remotion
- **类型**：Skill
- **价值**：中（视频创作）
- **版本**：-
- **描述**：Remotion 最佳实践 - React 视频创作
- **状态**：✅ 准备就绪

---

## 发布前检查清单

### 技术要求
- [x] SKILL.md 存在且格式正确
- [x] 包含必要 frontmatter（name, description）
- [ ] 需要补充版本号（部分技能缺失）
- [ ] 需要补充 displayName（部分技能缺失）

### 认证要求
- [ ] **需要 OPENCLAWMP_TOKEN 环境变量**
  - 获取方式：https://openclawmp.cc 注册
  - 需要：邀请码（第一次注册）
  - 配置：`export OPENCLAWMP_TOKEN=sk-xxx`

### CLI 安装
- [ ] **需要 sudo 权限安装 openclawmp CLI**
  - 命令：`sudo npm install -g openclawmp`
  - 或使用 curl 直接调用 API

---

## 下一步行动

### 用户需要做：
1. **获取邀请码并注册**：访问 https://openclawmp.cc
2. **配置 token**：`export OPENCLAWMP_TOKEN=sk-xxx`
3. **（可选）安装 CLI**：`sudo npm install -g openclawmp`

### Agent 会自动：
1. 检测到 token 后立即发布
2. 优先发布高价值技能（autonomy-kit, find-skills, planning）
3. 更新发布状态到 memory

---

## 发布命令（准备好后）

### 方式 A：使用 CLI（推荐）
```bash
cd ~/.openclaw/workspace/skills/agent-autonomy-kit
openclawmp publish .
```

### 方式 B：使用 curl API
```bash
# 打包
cd ~/.openclaw/workspace/skills/agent-autonomy-kit
zip -r /tmp/agent-autonomy-kit.zip . -x "*.git*" -x "node_modules/*"

# 发布
curl -X POST "https://openclawmp.cc/api/v1/assets/publish" \
  -H "Authorization: Bearer $OPENCLAWMP_TOKEN" \
  -F "package=@/tmp/agent-autonomy-kit.zip" \
  -F 'metadata={"name":"agent-autonomy-kit","type":"skill","version":"1.0.0","displayName":"Agent Autonomy Kit","description":"Stop waiting for prompts. Keep working.","tags":["automation","productivity"]}'
```

---

## 统计

- **待发布资产**：10 个
- **高优先级**：3 个
- **中优先级**：2 个
- **准备就绪**：10 个
- **阻塞原因**：缺少认证 token

---

## 相关文件

- 技能目录：`~/.openclaw/workspace/skills/`
- 水产市场文档：`~/.openclaw/skills/openclawmp/SKILL.md`
- 发布脚本：待创建（获得 token 后）
