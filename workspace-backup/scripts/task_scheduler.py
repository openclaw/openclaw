#!/usr/bin/env python3

"""
OpenClaw 任务调度器
为蒋工的AI Agent提供定时任务支持
替代systemd/cron的轻量级解决方案
"""

import time
import json
import subprocess
import threading
from datetime import datetime, timedelta
from pathlib import Path

class OpenClawScheduler:
    def __init__(self, workspace="/home/node/.openclaw/workspace"):
        self.workspace = Path(workspace)
        self.logs_dir = self.workspace / "logs"
        self.scripts_dir = self.workspace / "scripts"
        self.state_file = self.workspace / ".scheduler_state.json"
        
        # 确保目录存在
        self.logs_dir.mkdir(exist_ok=True)
        
        # 任务配置
        self.tasks = {
            "backup": {
                "script": str(self.scripts_dir / "backup.sh"),
                "interval": 6 * 3600,  # 6小时
                "last_run": 0,
                "log_file": self.logs_dir / "backup.log"
            },
            "review": {
                "script": str(self.scripts_dir / "daily_review.sh"), 
                "interval": 24 * 3600,  # 24小时
                "last_run": 0,
                "log_file": self.logs_dir / "review.log",
                "specific_time": "02:00"  # 凌晨2点
            },
            "heartbeat": {
                "script": str(self.scripts_dir / "heartbeat_check.sh"),
                "interval": 30 * 60,  # 30分钟
                "last_run": 0,
                "log_file": self.logs_dir / "heartbeat.log"
            }
        }
        
        self.load_state()
        
    def load_state(self):
        """加载任务状态"""
        try:
            if self.state_file.exists():
                with open(self.state_file, 'r') as f:
                    state = json.load(f)
                    for task_name, task_data in self.tasks.items():
                        if task_name in state:
                            task_data["last_run"] = state[task_name].get("last_run", 0)
        except Exception as e:
            print(f"加载状态失败: {e}")
            
    def save_state(self):
        """保存任务状态"""
        try:
            state = {}
            for task_name, task_data in self.tasks.items():
                state[task_name] = {"last_run": task_data["last_run"]}
            
            with open(self.state_file, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            print(f"保存状态失败: {e}")
    
    def should_run_task(self, task_name, task_data):
        """检查是否应该运行任务"""
        now = time.time()
        last_run = task_data["last_run"]
        interval = task_data["interval"]
        
        # 基础时间间隔检查
        if now - last_run < interval:
            return False
            
        # 特定时间检查（如凌晨2点）
        if "specific_time" in task_data:
            current_time = datetime.now().strftime("%H:%M")
            if current_time != task_data["specific_time"]:
                return False
        
        return True
    
    def run_task(self, task_name, task_data):
        """执行任务"""
        print(f"🔄 执行任务: {task_name} - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        
        try:
            # 运行脚本
            result = subprocess.run(
                task_data["script"],
                shell=True,
                capture_output=True,
                text=True,
                timeout=300  # 5分钟超时
            )
            
            # 记录日志
            log_content = f"""
=== {task_name.upper()} 任务执行 - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===
STDOUT:
{result.stdout}
STDERR:
{result.stderr}
返回码: {result.returncode}
---
"""
            
            with open(task_data["log_file"], 'a', encoding='utf-8') as f:
                f.write(log_content)
            
            # 更新最后运行时间
            self.tasks[task_name]["last_run"] = time.time()
            self.save_state()
            
            print(f"✅ 任务 {task_name} 执行完成")
            
        except subprocess.TimeoutExpired:
            print(f"⏰ 任务 {task_name} 执行超时")
        except Exception as e:
            print(f"❌ 任务 {task_name} 执行失败: {e}")
    
    def run_once(self):
        """执行一次所有到期任务"""
        for task_name, task_data in self.tasks.items():
            if self.should_run_task(task_name, task_data):
                self.run_task(task_name, task_data)
    
    def start_daemon(self):
        """启动守护进程"""
        print("🚀 OpenClaw任务调度器启动...")
        print(f"📁 工作目录: {self.workspace}")
        print("📋 监控任务:")
        for task_name, task_data in self.tasks.items():
            interval_hours = task_data["interval"] // 3600
            print(f"   - {task_name}: 每{interval_hours}小时执行一次")
        
        print("\n按 Ctrl+C 停止调度器...")
        
        try:
            while True:
                self.run_once()
                time.sleep(60)  # 每分钟检查一次
        except KeyboardInterrupt:
            print("\n🛑 调度器已停止")

if __name__ == "__main__":
    scheduler = OpenClawScheduler()
    
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        scheduler.start_daemon()
    else:
        # 单次执行
        scheduler.run_once()