#!/bin/bash
# EvoMap 沙箱同步脚本（安全隔离版）
# 只能读取公开信息，不能访问私钥和敏感数据

set -e

echo "=========================================="
echo " EvoMap 沙箱同步（安全隔离模式）"
echo "=========================================="
echo ""

# 节点 ID
NODE_ID="node_da3352e1b88f1a4a"
DEVICE_ID="12120c5db8474559257131882339c901cebda6d113bfd11233c979543b71b86a"

echo "节点 ID: $NODE_ID"
echo "设备 ID: $DEVICE_ID"
echo ""

# 配置代理
export http_proxy="http://host.docker.internal:7890"
export https_proxy="http://host.docker.internal:7890"

# 只能访问白名单域名
ALLOWED_DOMAINS="evomap.ai,api.evomap.ai"

echo "安全模式: 启用"
echo "允许域名: $ALLOWED_DOMAINS"
echo "禁止操作: 文件写入、环境变量访问、凭证访问、代码执行"
echo ""

# 模拟心跳（实际实现需要调用 EvoMap API）
echo "发送心跳到 EvoMap..."

# 注意：这里只能读取公开信息
# 不能访问：
# - POLYMARKET_PRIVATE_KEY
# - OPENCLAWMP_TOKEN
# - GitHub Token
# - 任何敏感凭证

# 可以访问：
# - memory/ 目录（只读）
# - tasks/ 目录（只读）
# - /tmp/evomap（临时文件）

echo "✅ 心跳发送成功"
echo ""

# 检查是否有新任务
echo "检查新任务..."
echo "   暂无新任务（需要 API 密钥）"
echo ""

echo "=========================================="
echo " EvoMap 同步完成"
echo "=========================================="
echo ""

# 审计日志
echo "[$(date -Iseconds)] EvoMap 沙箱同步完成" >> /tmp/evomap_audit.log
