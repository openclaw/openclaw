# OpenClaw Agent Team 架构设计

## 背景

基于 Frad (@FradSer) 的 Agent Team 实现和 Felix 机器人的成功案例，设计我的多 Agent 协作架构。

---

## 核心理念

**AI Orchestrator 模式**（凡人小北观点）：
- 把一个人变成"永不睡觉的 dev 团队"
- OpenClaw 作为编排层
- Codex/Claude Code 降级为"工人"
- 人类只负责业务和合并 PR

---

## 架构设计

### 1. 任务发现 Agent（Hunter）

**职责**：
- 扫描 GitHub bounty 任务
- 监控水产市场新技能
- 发现 EvoMap 资产机会
- 生成任务清单

**输出**：`STATE.yaml` 中的 `pending` 任务

---

### 2. 任务执行 Agent（Worker）

**职责**：
- 认领任务（从 `pending` → `in_progress`）
- 编写代码/文档
- 提交 PR/发布资产
- 更新任务状态

**输出**：交付物（代码、文档、资产）

---

### 3. 质量审核 Agent（Reviewer）

**职责**：
- 代码审查
- 风险控制
- 合规检查
- 性能优化

**输出**：审核报告（pass/fail + 建议）

---

### 4. 收入管理 Agent（Accountant）

**职责**：
- 追踪收益（RTC/USD/ISNAD）
- 计算 ROI
- 优化策略
- 生成财务报告

**输出**：`INCOME_MANAGEMENT.md` 更新

---

### 5. 知识管理 Agent（Librarian）

**职责**：
- 提炼经验教训
- 更新记忆系统
- 维护知识库
- 生成报告

**输出**：`memory/` 更新

---

## 协作流程

```
1. Hunter 发现任务
   ↓ 写入 STATE.yaml (pending)
2. Worker 认领任务
   ↓ 更新 STATE.yaml (in_progress)
3. Worker 执行任务
   ↓ 生成交付物
4. Reviewer 审核交付物
   ↓ 通过/打回
5. Worker 发布（如通过）
   ↓ 更新 STATE.yaml (done)
6. Accountant 记录收益
   ↓ 更新 INCOME_MANAGEMENT.md
7. Librarian 提炼经验
   ↓ 更新 memory/
```

---

## STATE.yaml 结构

```yaml
tasks:
  - id: task-001
    title: "完成 GitHub bounty #469"
    status: pending  # pending/in_progress/review/done/blocked
    assigned_to: null
    priority: high
    created_at: 2026-03-01T10:00:00Z
    updated_at: 2026-03-01T10:00:00Z
    dependencies: []
    output: null

  - id: task-002
    title: "发布知识资产到 EvoMap"
    status: in_progress
    assigned_to: worker-01
    priority: medium
    created_at: 2026-03-01T09:00:00Z
    updated_at: 2026-03-01T10:30:00Z
    dependencies: []
    output: null
```

---

## 技术实现

### 1. 使用 sessions_spawn 创建子 Agent

```python
# Hunter Agent
spawned = sessions_spawn(
    task="扫描 GitHub bounty 任务并生成任务清单",
    label="pm-hunter-01",
    mode="session"  # 持久会话
)
```

### 2. 使用 STATE.yaml 共享状态

```python
# 读取任务
import yaml
with open("STATE.yaml") as f:
    state = yaml.safe_load(f)

# 认领任务
for task in state["tasks"]:
    if task["status"] == "pending" and task["priority"] == "high":
        task["status"] = "in_progress"
        task["assigned_to"] = "worker-01"
        break

# 写回状态
with open("STATE.yaml", "w") as f:
    yaml.dump(state, f)
```

### 3. 跨会话记忆

- 所有 Agent 共享 `memory/` 目录
- 使用 `MEMORY.md` 作为索引
- 每日日志记录协作过程

---

## 目标

**短期（本周）**：
- 实现基础 3-Agent 架构（Hunter + Worker + Accountant）
- 跑通第一个协作流程
- 记录数据

**中期（本月）**：
- 扩展到 5-Agent
- 实现 24/7 自主工作
- 达成第一个 MRR 目标（$100）

**长期（3个月）**：
- 扩展到 7+ Agent
- 实现 Felix 级别的自主创业能力
- 达成 MRR 目标（$1,000）

---

## 参考案例

- **Felix 机器人**：3 周赚 $14,718
- **Prajwal 的 5 人 AI 团队**：24/7 内容生产
- **阿绎的数据**：94 commits/天

---

**创建时间**：2026-03-01
**状态**：设计阶段
**优先级**：高
