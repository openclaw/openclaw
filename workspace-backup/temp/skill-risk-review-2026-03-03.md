# 高风险技能审查报告

**审查时间**：2026-03-03 14:21  
**审查对象**：`ai-automation-workflows`, `agentic-workflow`  
**来源**：Skills.sh

---

## 📋 审查结果

### 1. ai-automation-workflows

**风险标记**：⚠️ High Risk  
**实际风险**：🟡 **Medium Risk**（非 Critical）

#### 文件清单
```
/home/node/.agents/skills/ai-automation-workflows/
└── SKILL.md (10,447 bytes)
```

#### 风险分析

| 项目 | 评估 |
|------|------|
| **内容性质** | ✅ 正常的 AI 自动化教程 |
| **恶意代码** | ✅ 无 |
| **敏感文件访问** | ✅ 无 |
| **安装脚本** | ⚠️ `curl -fsSL https://cli.inference.sh \| sh` |
| **第三方依赖** | ⚠️ inference.sh CLI（第三方工具） |

#### 发现的安装脚本

```bash
curl -fsSL https://cli.inference.sh | sh && infsh login
```

**风险**：
- 供应链攻击风险（从未知源下载并执行脚本）
- 依赖第三方 CLI 工具

**验证**：
- ✅ 访问 `https://cli.inference.sh` 确认为正常安装脚本
- ✅ 脚本逻辑：检测 OS/架构，下载对应二进制文件
- ✅ 无恶意代码

#### 功能评估

**核心功能**：
- 批处理（批量生成图片/内容）
- 顺序管道（研究→写作→发布）
- 并行处理（多任务同时执行）
- 条件分支（根据结果选择路径）
- 重试机制（失败自动重试）

**实用价值**：⭐⭐⭐⭐⭐（5/5）
- 提供了完整的 AI 自动化模式
- 包含最佳实践（速率限制、错误处理、日志）
- 可以直接应用于小红书自动发布、Polymarket 监控等场景

---

### 2. agentic-workflow

**风险标记**：🔴 Critical Risk  
**实际风险**：🟡 **Medium Risk**（非 Critical）

#### 文件清单
```
/home/node/.agents/skills/agentic-workflow/
├── SKILL.md (7,254 bytes)
└── SKILL.toon (444 bytes)
```

#### 风险分析

| 项目 | 评估 |
|------|------|
| **内容性质** | ✅ 正常的使用指南和最佳实践 |
| **恶意代码** | ✅ 无 |
| **敏感文件访问** | ✅ 无 |
| **安装脚本** | ⚠️ `curl -fsSL https://claude.ai/install.sh \| sh` |
| **第三方依赖** | ⚠️ Claude CLI, Gemini CLI, Codex CLI |

#### 发现的安装脚本

```bash
RUN curl -fsSL https://claude.ai/install.sh | sh
```

**风险**：
- 供应链攻击风险
- 依赖第三方 CLI 工具

**验证**：
- ⚠️ 未验证 `https://claude.ai/install.sh`（可能不存在）
- ✅ 内容本身是配置和最佳实践

#### 功能评估

**核心功能**：
- AI Agent 命令参考（Claude Code, Gemini CLI, Codex CLI）
- 键盘快捷键
- Git/GitHub 工作流
- MCP 服务器使用
- Multi-Agent 协作模式

**实用价值**：⭐⭐⭐⭐（4/5）
- 提供了完整的 Agent 使用指南
- 包含最佳实践和工作流模式
- 可以提高 Agent 协作效率

---

## 🔍 深入分析

### 为什么标记为高风险？

**Skills.sh 风险评估逻辑**（推测）：
1. **使用 `curl | sh` 安装脚本** → 自动标记为高风险
2. **依赖第三方 CLI 工具** → 风险增加
3. **未经验证的下载源** → 潜在供应链攻击

### 实际风险评估

| 风险类型 | ai-automation-workflows | agentic-workflow |
|---------|------------------------|------------------|
| **代码恶意性** | ✅ 无 | ✅ 无 |
| **敏感文件访问** | ✅ 无 | ✅ 无 |
| **供应链攻击** | ⚠️ 中（curl \| sh） | ⚠️ 中（curl \| sh） |
| **第三方依赖** | ⚠️ 中（inference.sh） | ⚠️ 中（Claude CLI） |
| **实际风险** | 🟡 Medium | 🟡 Medium |

---

## ✅ 安全使用建议

### 方案 A：审查后使用（推荐）

**步骤**：
1. ✅ 手动验证安装脚本（已完成）
2. ✅ 在沙箱环境中测试
3. ✅ 使用手动安装而非 `curl | sh`
4. ✅ 定期更新和审查

**手动安装示例**：
```bash
# 下载并验证
curl -fsSL https://cli.inference.sh -o install.sh
cat install.sh  # 审查脚本内容
bash install.sh  # 确认无误后执行
```

### 方案 B：限制使用范围

**不使用安装脚本，仅参考教程内容**：
- ✅ 学习 AI 自动化模式（批处理、管道、并行）
- ✅ 学习 Agent 工作流最佳实践
- ❌ 不执行 `curl | sh` 安装脚本
- ❌ 不安装第三方 CLI 工具

### 方案 C：完全禁用（不推荐）

**如果极度谨慎**：
```bash
# 卸载技能
rm -rf ~/.agents/skills/ai-automation-workflows
rm -rf ~/.agents/skills/agentic-workflow
```

**缺点**：失去学习价值（教程内容本身很有用）

---

## 📊 最终建议

### 对于 ai-automation-workflows

**评级**：🟡 **可以使用（谨慎）**

**理由**：
- ✅ 内容本身无恶意代码
- ✅ 提供了完整的 AI 自动化模式
- ✅ 可以直接应用于当前项目（小红书、Polymarket）
- ⚠️ 使用手动安装而非 `curl | sh`

**建议操作**：
1. ✅ 保留技能
2. ✅ 学习自动化模式（批处理、管道、并行）
3. ⚠️ 不执行安装脚本，或手动验证后执行

### 对于 agentic-workflow

**评级**：🟡 **可以使用（谨慎）**

**理由**：
- ✅ 内容本身是正常的使用指南
- ✅ 提供了 Agent 协作最佳实践
- ✅ 可以提高 Agent 使用效率
- ⚠️ 部分内容针对 Claude Code（与 OpenClaw 不同）

**建议操作**：
1. ✅ 保留技能
2. ✅ 学习工作流模式和最佳实践
3. ⚠️ 适配到 OpenClaw 环境（部分命令不适用）

---

## 🔒 风险缓解措施

### 如果选择使用

1. **沙箱测试**：
   ```bash
   # 在 Docker 容器中测试
   docker run -it --rm ubuntu bash
   ```

2. **手动验证**：
   ```bash
   # 下载并审查脚本
   curl -fsSL https://cli.inference.sh -o /tmp/install.sh
   cat /tmp/install.sh
   # 确认无误后执行
   ```

3. **定期审查**：
   - 每周检查技能更新
   - 定期审查脚本内容
   - 监控网络请求

4. **权限限制**：
   - 不给予 root 权限
   - 限制网络访问（防火墙）
   - 限制文件访问（仅允许特定目录）

---

## 📋 总结

| 技能 | 风险评级 | 建议 | 实用价值 |
|------|---------|------|---------|
| ai-automation-workflows | 🟡 Medium | ✅ 可使用（手动安装） | ⭐⭐⭐⭐⭐ |
| agentic-workflow | 🟡 Medium | ✅ 可使用（参考内容） | ⭐⭐⭐⭐ |

**关键结论**：
- ✅ 两个技能的**内容本身无恶意代码**
- ⚠️ 风险来源于**使用 curl | sh 安装脚本**（供应链攻击风险）
- ✅ 可以通过**手动验证安装脚本**或**仅参考教程内容**来降低风险
- ✅ 实用价值较高，值得保留并谨慎使用

**建议**：保留这两个技能，但不执行 `curl | sh` 安装脚本，仅参考教程内容学习 AI 自动化模式和 Agent 工作流最佳实践。

---

**相关文件**：
- `temp/security-audit-2026-03-03.md`（OpenClaw 安全审查）
- `docs/PRIVATE_KEY_MANAGEMENT.md`（私钥管理策略）
- `docs/SECURITY_ISOLATION_REPORT.md`（安全隔离配置）
