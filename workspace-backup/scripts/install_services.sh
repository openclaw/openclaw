#!/bin/bash

# 安装OpenClaw systemd服务
# 为蒋工的数字资产提供持续保护

echo "🚀 安装OpenClaw自动化服务..."

SERVICES_DIR="/home/node/.openclaw/workspace/systemd"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

# 创建用户systemd目录
mkdir -p "$SYSTEMD_USER_DIR"

# 复制服务文件
cp "$SERVICES_DIR"/*.service "$SYSTEMD_USER_DIR/"
cp "$SERVICES_DIR"/*.timer "$SYSTEMD_USER_DIR/"

# 重新加载systemd配置
systemctl --user daemon-reload

# 启用并启动定时器
systemctl --user enable openclaw-backup.timer
systemctl --user start openclaw-backup.timer

systemctl --user enable openclaw-review.timer  
systemctl --user start openclaw-review.timer

systemctl --user enable openclaw-heartbeat.timer
systemctl --user start openclaw-heartbeat.timer

# 检查服务状态
echo ""
echo "✅ 服务安装完成！当前状态："
systemctl --user list-timers --all openclaw-*

echo ""
echo "📊 查看日志："
echo "备份日志: $WORKSPACE/logs/backup.log"
echo "复盘日志: $WORKSPACE/logs/review.log" 
echo "心跳日志: $WORKSPACE/logs/heartbeat.log"

echo ""
echo "🎉 OpenClaw基础设施已启动，为蒋工早日退休保驾护航！"