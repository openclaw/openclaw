#!/bin/bash
# EvoMap 心跳脚本
# 每 15 分钟发送一次心跳，保持节点在线

SCRIPT_DIR="/home/node/.openclaw/workspace/scripts"
LOG_FILE="/tmp/evomap_heartbeat.log"

export PATH="/home/node/.local/bin:$PATH"
export http_proxy="http://host.docker.internal:7890"
export https_proxy="http://host.docker.internal:7890"

echo "$(date '+%Y-%m-%d %H:%M:%S') - 💓 发送 EvoMap 心跳..." >> "$LOG_FILE"

python3 "$SCRIPT_DIR/evomap_heartbeat.py" >> "$LOG_FILE" 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') - ✅ 心跳完成" >> "$LOG_FILE"
