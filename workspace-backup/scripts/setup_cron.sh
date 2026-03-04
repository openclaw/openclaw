#!/bin/bash

# 设置定时任务 - 为蒋工的数字资产保驾护航

echo "⏰ 配置定时备份任务..."

# 添加定时任务到crontab
(crontab -l 2>/dev/null; cat << 'EOF'
# OpenClaw 基础设施任务
# 每6小时检查备份
0 */6 * * * /home/node/.openclaw/workspace/scripts/backup.sh >> /home/node/.openclaw/workspace/logs/backup.log 2>&1

# 每日凌晨2点进行深度复盘和学习
0 2 * * * /home/node/.openclaw/workspace/scripts/daily_review.sh >> /home/node/.openclaw/workspace/logs/review.log 2>&1

# 每30分钟心跳检查（保持Agent活跃）
*/30 * * * * /home/node/.openclaw/workspace/scripts/heartbeat_check.sh >> /home/node/.openclaw/workspace/logs/heartbeat.log 2>&1
EOF
) | crontab -

echo "✅ 定时任务配置完成"