# MEMORY.md - 核心记忆索引（< 40 行）

> 📌 **说明**：这是记忆系统的"入口"，只包含索引和摘要。详情见 `memory/` 目录。

---

## 👤 用户画像

- **称呼**：主人
- **核心目标**：被动收入系统（$1,000 MRR）
- **沟通风格**：简洁高效，不要废话
- **详细画像**：见 [`USER.md`](USER.md)

---

## 🎯 活跃项目

- **[Polymarket 自动交易](memory/active-projects/polymarket-sniper.md)** ⭐
  - 状态：⚠️ 浏览器服务不可用，API搜索未配置
  - 预期收益：$1,000-50,000/月
  - 最新：消息面狙击系统开发中（2026-03-03 21:27）

- **[被动收入系统](memory/active-projects/passive-income.md)**
  - 水产市场：23 个资产
  - EvoMap：节点在线
  - MRR：$5.74 / $1,000（0.57%）

- **其他项目**：见 [`memory/active-projects/`](memory/active-projects/)

---

## 🖥️ 关键基础设施

- **系统环境**：Windows 10 + WSL2 + Docker
- **AI 模型**：GLM-5（主） → GLM-4.7（备） → Qwen3.5（本地）
- **代理**：`http://host.docker.internal:7890`
- **IM 渠道**：飞书
- **详细配置**：见 [`memory/tacit-knowledge/infra.md`](memory/tacit-knowledge/infra.md)

---

## ⚠️ 重要教训

- 2026-03-03: Polymarket 自动交易失败 → [余额不足，需充值](memory/tacit-knowledge/lessons-learned.md#polymarket-余额不足)
- 2026-03-03: 水产市场发布失败 → [需授权设备](memory/tacit-knowledge/lessons-learned.md#水产市场授权)
- 2026-03-03: Python 依赖缺失 → [使用 --break-system-packages](memory/tacit-knowledge/lessons-learned.md#pip-安装)

---

## 📅 近期日志

- [2026-03-03](memory/daily-notes/2026-03-03.md) - Polymarket 自动交易部署
- [2026-03-02](memory/daily-notes/2026-03-02.md) - 三省六部能力矩阵完善
- [2026-03-01](memory/daily-notes/2026-03-01.md) - 安全审计完成

---

## 📂 记忆结构

```
memory/
├── daily-notes/        ← 日志层（每天记录）
├── active-projects/    ← 项目层（项目状态）
├── tacit-knowledge/    ← 经验层（教训、技巧）
└── heartbeat-state.json ← 心跳状态
```

---

**最后更新**：2026-03-03 15:50
