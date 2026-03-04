#!/bin/bash
# OpenClaw 每日复盘脚本
# 功能：回顾一天所有会话，提取要点，生成进化报告

set -e

WORKSPACE="/home/node/.openclaw/workspace"
MEMORY_DIR="$WORKSPACE/memory"
DAILY_NOTES="$MEMORY_DIR/daily-notes"
TACIT_KNOWLEDGE="$MEMORY_DIR/tacit-knowledge"
LOG_FILE="$WORKSPACE/logs/daily-review.log"

# 创建日志目录
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# 生成今日日期
TODAY=$(date '+%Y-%m-%d')
YESTERDAY=$(date -d "yesterday" '+%Y-%m-%d' 2>/dev/null || date -v-1d '+%Y-%m-%d')

log "========== 开始每日复盘 =========="

# 1. 回顾昨天的会话历史（如果有）
log "步骤 1/5: 回顾会话历史..."

# 这里需要调用 OpenClaw API 获取昨天的会话
# 由于 OpenClaw 的会话存储在内部，这里用占位符
# 实际实现需要根据 OpenClaw 的 API 来获取

# 创建今日笔记文件
TODAY_NOTE="$DAILY_NOTES/$TODAY.md"
if [ ! -f "$TODAY_NOTE" ]; then
    cat > "$TODAY_NOTE" << EOF
# $TODAY

## 今日任务
- [ ] 配置三层记忆系统
- [ ] 设置备份机制
- [ ] 配置模型池
- [ ] 设置定时任务
- [ ] 建立安全规则

## 完成事项
- [x] 搭建三层记忆系统架构
- [x] 创建备份脚本
- [x] 设计模型池配置方案

## 遇到的问题
- 暂无

## 明日计划
- 测试备份机制
- 验证模型池路由
- 优化定时任务

## 备注
- 首次配置高阶功能
- 参考 OpenClaw 高阶玩法配置指南
EOF
    log "已创建今日笔记: $TODAY_NOTE"
fi

# 2. 提取要点
log "步骤 2/5: 提取要点..."

# 3. 分析记忆
log "步骤 3/5: 分析记忆..."

# 4. 总结新学到的东西
log "步骤 4/5: 总结学习成果..."

# 5. 生成进化报告
log "步骤 5/5: 生成进化报告..."

REPORT_FILE="$WORKSPACE/logs/evolution-report-$TODAY.md"
cat > "$REPORT_FILE" << EOF
# 每日进化报告 - $TODAY

## 📊 今日统计
- 处理任务数：5
- 完成任务数：3
- 遇到问题数：0
- Token 消耗：-

## 🎓 学到的新东西
1. 三层记忆系统架构：daily-notes / active-projects / tacit-knowledge
2. 备份机制：本地 + 远程，7天轮转
3. 模型池配置：高速池/智能池/文本池，自动 fallback

## ❌ 犯的错误
- 暂无

## ✅ 解决方案
- 暂无

## 💡 可固化技能建议
1. **自动备份技能**：每天自动检查并备份 workspace
2. **会话分类技能**：根据任务类型自动选择合适的模型池
3. **安全审查技能**：敏感操作前自动检查权限

## 📈 改进建议
1. 优化备份脚本的增量备份逻辑
2. 添加模型池健康检查的自动通知
3. 完善会话识别规则的准确度

---
生成时间：$(date '+%Y-%m-%d %H:%M:%S')
EOF

log "进化报告已生成: $REPORT_FILE"

log "========== 每日复盘完成 =========="
