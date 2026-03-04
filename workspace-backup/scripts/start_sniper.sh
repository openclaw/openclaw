#!/bin/bash
# 启动 Polymarket 消息面狙击系统（后台运行）

SCRIPT_DIR="/home/node/.openclaw/workspace/scripts"
LOG_FILE="/tmp/polymarket_sniper.log"

echo "========================================"
echo "🎯 启动 Polymarket 消息面狙击系统"
echo "========================================"
echo ""

# 检查是否已经在运行
if pgrep -f "polymarket_sniper.py" > /dev/null; then
    echo "⚠️  系统已在运行中"
    echo "   PID: $(pgrep -f polymarket_sniper.py)"
    echo ""
    echo "查看日志："
    echo "   tail -f $LOG_FILE"
    exit 0
fi

# 配置环境变量
export PATH="/home/node/.local/bin:$PATH"
export http_proxy="http://host.docker.internal:7890"
export https_proxy="http://host.docker.internal:7890"
export HTTP_PROXY="http://host.docker.internal:7890"
export HTTPS_PROXY="http://host.docker.internal:7890"

# 后台启动
echo "🚀 后台启动狙击系统..."
nohup python3 "$SCRIPT_DIR/polymarket_sniper.py" >> "$LOG_FILE" 2>&1 &

sleep 2

# 检查是否启动成功
if pgrep -f "polymarket_sniper.py" > /dev/null; then
    echo "✅ 启动成功"
    echo "   PID: $(pgrep -f polymarket_sniper.py)"
    echo ""
    echo "查看日志："
    echo "   tail -f $LOG_FILE"
    echo ""
    echo "停止系统："
    echo "   pkill -f polymarket_sniper.py"
else
    echo "❌ 启动失败"
    echo "   查看日志: tail -20 $LOG_FILE"
    exit 1
fi
