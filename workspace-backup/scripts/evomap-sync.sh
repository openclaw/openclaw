#!/bin/bash
# EvoMap 自我进化脚本
# 功能：心跳保持在线 + 检索高GDI技能 + 自动安装

set -e

WORKSPACE="/home/node/.openclaw/workspace"
EVOMAP_DIR="$WORKSPACE/evomap"
LOG_FILE="$WORKSPACE/logs/evomap-sync.log"
NODE_ID_FILE="$EVOMAP_DIR/node_id.txt"
SKILLS_FILE="$EVOMAP_DIR/skills-marketplace.md"

# 创建日志目录
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$EVOMAP_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# 检查节点ID是否存在
if [ ! -f "$NODE_ID_FILE" ]; then
    log "节点ID不存在，生成新节点..."
    NODE_ID="node_$(head -c 16 /dev/urandom | od -A n -t x1 | tr -d ' ' | head -c 16)"
    echo "$NODE_ID" > "$NODE_ID_FILE"
else
    NODE_ID=$(cat "$NODE_ID_FILE")
fi

log "========== EvoMap 同步开始 =========="
log "节点ID: $NODE_ID"

# 1. 发送心跳（简化版，因为/a2a/hello超时）
log "步骤 1/4: 检查 EvoMap 状态..."
HUB_STATUS=$(curl -s --max-time 10 "https://evomap.ai/a2a/stats" 2>/dev/null || echo '{"error":"offline"}')
if echo "$HUB_STATUS" | grep -q "total_assets"; then
    TOTAL_ASSETS=$(echo "$HUB_STATUS" | grep -o '"total_assets":[0-9]*' | cut -d: -f2)
    log "EvoMap 在线，总资产数: $TOTAL_ASSETS"
else
    log "警告: EvoMap 离线或响应超时"
fi

# 2. 检索高GDI技能
log "步骤 2/4: 检索高GDI技能..."
curl -s --max-time 15 "https://evomap.ai/a2a/trending?limit=10" > "$EVOMAP_DIR/trending_latest.json" 2>/dev/null || true

if [ -f "$EVOMAP_DIR/trending_latest.json" ] && [ -s "$EVOMAP_DIR/trending_latest.json" ]; then
    SKILL_COUNT=$(grep -o '"asset_id"' "$EVOMAP_DIR/trending_latest.json" | wc -l)
    log "获取到 $SKILL_COUNT 个热门技能"
else
    log "警告: 无法获取热门技能"
fi

# 3. 分析技能价值
log "步骤 3/4: 分析技能价值..."
if [ -f "$EVOMAP_DIR/trending_latest.json" ]; then
    # 提取GDI最高的技能
    TOP_GDI=$(cat "$EVOMAP_DIR/trending_latest.json" | grep -o '"gdi_score":[0-9.]*' | cut -d: -f2 | sort -rn | head -1)
    if [ -n "$TOP_GDI" ]; then
        log "最高GDI分数: $TOP_GDI"
    fi
fi

# 4. 生成进化报告
log "步骤 4/4: 生成进化报告..."
REPORT_FILE="$WORKSPACE/logs/evomap-report-$(date +%Y%m%d).md"

cat > "$REPORT_FILE" << EOF
# EvoMap 进化报告 - $(date '+%Y-%m-%d')

## 节点状态
- 节点ID: $NODE_ID
- 同步时间: $(date '+%Y-%m-%d %H:%M:%S')
- Hub 状态: $(echo "$HUB_STATUS" | grep -q "total_assets" && echo "在线" || echo "离线")

## 技能市场概览
$(cat "$EVOMAP_DIR/trending_latest.json" 2>/dev/null | grep -o '"summary":"[^"]*"' | head -5 | sed 's/"summary":"/- /' | sed 's/"$//')

## 下一步行动
- [ ] 完成节点注册（等待/a2a/hello响应）
- [ ] 安装GDI>60的技能
- [ ] 发布原创技能

---
生成时间: $(date '+%Y-%m-%d %H:%M:%S')
EOF

log "进化报告已生成: $REPORT_FILE"

log "========== EvoMap 同步完成 =========="
