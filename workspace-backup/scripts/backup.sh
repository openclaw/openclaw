#!/bin/bash
# OpenClaw Workspace 自动备份脚本
# 功能：本地备份 + 远程备份（支持iCloud），7天轮转

set -e

# 配置
WORKSPACE="/home/node/.openclaw/workspace"
BACKUP_DIR="/home/node/.openclaw/backups"
REMOTE_BACKUP_DIR=""  # iCloud 或其他远程路径，由用户配置
DAYS=("mon" "tue" "wed" "thu" "fri" "sat" "sun")
MAX_SIZE_CHANGE=10240  # 10KB

# 获取今天是周几 (0=周日, 1=周一, ...)
DAY_INDEX=$(date +%w)
TODAY=${DAYS[$DAY_INDEX]}

# 创建备份目录
mkdir -p "$BACKUP_DIR"

# 本地备份函数
local_backup() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始本地备份..."
    
    # 创建今天的备份目录
    TODAY_DIR="$BACKUP_DIR/$TODAY"
    mkdir -p "$TODAY_DIR"
    
    # 备份workspace
    TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
    BACKUP_FILE="$TODAY_DIR/workspace_${TIMESTAMP}.tar.gz"
    
    tar -czf "$BACKUP_FILE" -C "$WORKSPACE" . 2>/dev/null || true
    
    # 计算备份大小
    BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "0")
    
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 本地备份完成: $BACKUP_FILE ($(numfmt --to=iec $BACKUP_SIZE 2>/dev/null || echo $BACKUP_SIZE bytes))"
    
    # 清理今天的旧备份（保留最新的3个）
    cd "$TODAY_DIR"
    ls -t workspace_*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm
    
    echo "$BACKUP_FILE"
}

# 远程备份函数
remote_backup() {
    if [ -z "$REMOTE_BACKUP_DIR" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 远程备份目录未配置，跳过"
        return 0
    fi
    
    if [ ! -d "$REMOTE_BACKUP_DIR" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 远程备份目录不存在: $REMOTE_BACKUP_DIR"
        return 1
    fi
    
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始远程备份到 $REMOTE_BACKUP_DIR..."
    
    REMOTE_TODAY_DIR="$REMOTE_BACKUP_DIR/$TODAY"
    mkdir -p "$REMOTE_TODAY_DIR"
    
    # 复制最新的本地备份到远程
    LATEST_BACKUP=$(ls -t "$BACKUP_DIR/$TODAY"/workspace_*.tar.gz 2>/dev/null | head -1)
    if [ -n "$LATEST_BACKUP" ]; then
        cp "$LATEST_BACKUP" "$REMOTE_TODAY_DIR/"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 远程备份完成"
    fi
}

# 检查是否需要备份
should_backup() {
    LAST_BACKUP="$BACKUP_DIR/.last_backup"
    
    # 如果没有备份记录，需要备份
    if [ ! -f "$LAST_BACKUP" ]; then
        return 0
    fi
    
    # 检查时间（超过24小时）
    LAST_TIME=$(cat "$LAST_BACKUP")
    CURRENT_TIME=$(date +%s)
    TIME_DIFF=$((CURRENT_TIME - LAST_TIME))
    
    if [ $TIME_DIFF -gt 86400 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 距离上次备份已超过24小时"
        return 0
    fi
    
    # 检查文件大小变化
    CURRENT_SIZE=$(du -sb "$WORKSPACE" 2>/dev/null | cut -f1)
    LAST_SIZE=$(cat "$BACKUP_DIR/.last_size" 2>/dev/null || echo "0")
    SIZE_DIFF=$((CURRENT_SIZE - LAST_SIZE))
    
    if [ ${SIZE_DIFF#-} -gt $MAX_SIZE_CHANGE ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 文件大小变化超过10KB"
        return 0
    fi
    
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 无需备份"
    return 1
}

# 主流程
main() {
    echo "========== OpenClaw 备份任务开始 =========="
    
    if should_backup; then
        local_backup
        remote_backup
        
        # 记录备份时间和大小
        date +%s > "$BACKUP_DIR/.last_backup"
        du -sb "$WORKSPACE" 2>/dev/null | cut -f1 > "$BACKUP_DIR/.last_size"
    fi
    
    echo "========== OpenClaw 备份任务结束 =========="
}

main "$@"
