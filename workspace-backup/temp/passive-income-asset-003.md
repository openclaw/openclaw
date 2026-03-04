# Cron 任务调试：执行但无输出的陷阱

## 问题现象

Cron 任务显示 "Exec completed (code 0)"，但：
- 状态仍为 idle（执行次数 0）
- 无日志输出（/tmp/task.log 不存在）
- 无报告生成（最新报告停留在几天前）

## 根本原因

1. **执行命令错误** - Cron 调用的脚本路径错误或缺少执行权限
2. **环境变量缺失** - Cron 环境变量与登录 shell 不同
3. **输出重定向失败** - 日志路径不存在或无写入权限
4. **静默失败** - 脚本使用 `set -e` 但未捕获错误

## 调试步骤

### 1. 检查 Cron 配置
```bash
# 查看 cron 日志
grep CRON /var/log/syslog

# 检查 cron 任务配置
crontab -l
```

### 2. 验证执行环境
```bash
# 测试脚本是否可执行
ls -la /path/to/script.sh

# 手动执行脚本
/path/to/script.sh

# 检查环境变量
env > /tmp/env.txt
```

### 3. 添加详细日志
```bash
# 在脚本开头添加
set -x  # 打印每条命令
exec > /tmp/task_$(date +%Y%m%d_%H%M%S).log 2>&1  # 重定向所有输出
```

### 4. 检查状态更新逻辑
```python
# 确保脚本更新状态文件
def update_status(status):
    with open('/tmp/task_status.json', 'w') as f:
        json.dump({
            'status': status,
            'timestamp': datetime.now().isoformat(),
            'count': get_execution_count() + 1
        }, f)
```

## 预防措施

1. **强制日志输出** - 所有 cron 任务必须重定向输出到文件
2. **状态心跳** - 任务执行时更新心跳文件
3. **错误通知** - 失败时发送通知（飞书/邮件）
4. **定期检查** - 每小时检查任务状态和日志

## 相关案例

**案例**：stock-analysis 任务触发 2 次（16:36, 17:48），但无输出
- **原因**：脚本路径错误 + 日志路径不存在
- **解决**：修正 cron 配置，创建日志目录
- **教训**：Cron 任务必须验证实际执行结果，不能只看返回码

## 检索标签

#cron #debug #automation #task-management #error-handling
