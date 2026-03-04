#!/bin/bash

# 心跳检查机制 - 保持AI Agent的"生物钟"
# 每30分钟执行一次，主动监控和推进任务

WORKSPACE="/home/node/.openclaw/workspace"
STATE_FILE="$WORKSPACE/.heartbeat_state.json"
TODAY=$(date +"%Y-%m-%d")

# 初始化心跳状态
init_state() {
    if [ ! -f "$STATE_FILE" ]; then
        cat > "$STATE_FILE" << EOF
{
  "lastChecks": {
    "email": null,
    "projects": null,
    "learning": null,
    "marketing": null
  },
  "currentTasks": [],
  "lastHeartbeat": $(date +%s)
}
EOF
    fi
}

# 检查项目进展
check_projects() {
    echo "🔍 检查项目进展..."
    
    if [ -f "$WORKSPACE/active_projects.md" ]; then
        echo "当前活跃项目："
        grep -E "^- \[ \]" "$WORKSPACE/active_projects.md" | head -3
    else
        echo "暂无活跃项目"
    fi
}

# 学习任务检查
check_learning() {
    echo "📚 检查学习进展..."
    
    # 检查是否有新的学习资源需要处理
    if [ -f "$WORKSPACE/learning_queue.md" ]; then
        echo "待学习内容："
        head -3 "$WORKSPACE/learning_queue.md"
    else
        echo "🎯 建议：研究Felix案例技术细节"
    fi
}

# 营销机会检查
check_marketing() {
    echo "📢 检查营销机会..."
    echo "💭 思考：今天有什么可以为蒋工创造的商业价值？"
    echo "   - 发现新工具？"
    echo "   - 优化现有流程？"
    echo "   - 识别商机？"
}

# 主动任务推进
push_tasks() {
    echo "⚡ 主动推进任务..."
    
    # 检查是否有搁置的任务
    local stuck_tasks=$(find "$WORKSPACE" -name "*.md" -exec grep -l "搁置\|待办\|blocked" {} \; 2>/dev/null | wc -l)
    if [ "$stuck_tasks" -gt 0 ]; then
        echo "发现 $stuck_tasks 个可能有阻塞的任务，需要关注"
    fi
}

# 更新心跳状态
update_state() {
    local current_time=$(date +%s)
    
    # 更新JSON状态文件
    python3 << EOF
import json
import time

with open('$STATE_FILE', 'r') as f:
    state = json.load(f)

state['lastHeartbeat'] = $current_time
state['lastChecks']['projects'] = $current_time
state['lastChecks']['learning'] = $current_time  
state['lastChecks']['marketing'] = $current_time

with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)
EOF
}

# 检查是否需要提醒蒋工
check_alerts() {
    local current_hour=$(date +%H)
    
    # 如果是工作时间且长时间未沟通
    if [ "$current_hour" -ge 9 ] && [ "$current_hour" -le 18 ]; then
        local last_comm=$(find "$WORKSPACE/memory" -name "*.md" -mtime -1 | head -1)
        if [ -z "$last_comm" ]; then
            echo "💭 建议主动与蒋工沟通进展"
        fi
    fi
}

# 主心跳逻辑
main_heartbeat() {
    echo "💓 $(date '+%Y-%m-%d %H:%M:%S') - AI Agent 心跳检查"
    echo ""
    
    init_state
    check_projects
    check_learning  
    check_marketing
    push_tasks
    check_alerts
    update_state
    
    echo ""
    echo "✅ 心跳检查完成，继续为蒋工的退休事业奋斗！"
}

# 执行心跳
main_heartbeat >> "$WORKSPACE/logs/heartbeat_$(date +%Y%m%d).log" 2>&1