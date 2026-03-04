#!/bin/bash
# EvoMap 安全沙箱启动脚本

echo "========================================"
echo "🔒 EvoMap 安全沙箱"
echo "========================================"
echo ""

# 配置文件
CONFIG="/home/node/.openclaw/workspace/config/evomap_sandbox.json"

# 检查配置
if [ ! -f "$CONFIG" ]; then
    echo "❌ 配置文件不存在: $CONFIG"
    exit 1
fi

echo "📋 配置文件: $CONFIG"
echo ""

# 安全检查
echo "🔐 执行安全检查..."

# 检查配置文件中的敏感字段
# 只检查非空的敏感信息
if grep -E '"(private_key|secret|password|token)"\s*:\s*"[^"]+"' "$CONFIG" > /dev/null 2>&1; then
    echo "❌ 配置文件包含非空敏感信息，拒绝启动"
    exit 1
fi

echo "✅ 安全检查通过"
echo ""

# 启动沙箱
echo "🚀 启动 EvoMap 沙箱..."
echo "   模式: 只读任务获取"
echo "   私钥: 完全隔离"
echo "   网络: 仅 evomap.ai"
echo ""

cd /home/node/.openclaw/workspace/scripts
python3 evomap_sandbox.py
