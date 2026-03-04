#!/usr/bin/env python3

"""
模型池监控服务
实时监控模型池性能和成本
"""

import json
import time
from datetime import datetime
from pathlib import Path

class ModelPoolMonitor:
    def __init__(self):
        self.workspace = Path("/home/node/.openclaw/workspace")
        self.config_file = self.workspace / "config" / "model_pool_config.json"
        self.stats_file = self.workspace / "config" / "usage_stats.json"
        self.alerts_file = self.workspace / "logs" / "model_pool_alerts.json"
        
        self.alerts_file.parent.mkdir(exist_ok=True)
        
    def load_config(self):
        """加载配置"""
        try:
            with open(self.config_file, 'r') as f:
                return json.load(f)
        except:
            return {}
    
    def load_stats(self):
        """加载统计数据"""
        try:
            with open(self.stats_file, 'r') as f:
                return json.load(f)
        except:
            return {"daily_cost": 0.0, "error_rate": 0.0}
    
    def check_cost_alert(self, stats, config):
        """检查成本告警"""
        daily_cost = stats.get("daily_cost", 0.0)
        daily_limit = config.get("cost_limits", {}).get("daily_limit", 50.0)
        warning_threshold = config.get("cost_limits", {}).get("warning_threshold", 0.8)
        
        cost_ratio = daily_cost / daily_limit
        
        alerts = []
        if cost_ratio >= warning_threshold:
            alerts.append({
                "type": "cost_warning",
                "message": f"日消费已达{cost_ratio*100:.1f}%，请注意控制成本",
                "current_cost": daily_cost,
                "limit": daily_limit,
                "timestamp": datetime.now().isoformat()
            })
        
        return alerts
    
    def check_performance_alert(self, stats, config):
        """检查性能告警"""
        error_rate = stats.get("error_rate", 0.0)
        error_threshold = config.get("health_monitoring", {}).get("error_threshold", 0.05)
        
        alerts = []
        if error_rate > error_threshold:
            alerts.append({
                "type": "performance_warning", 
                "message": f"错误率{error_rate*100:.2f}%超过阈值",
                "current_error_rate": error_rate,
                "threshold": error_threshold,
                "timestamp": datetime.now().isoformat()
            })
        
        return alerts
    
    def run_monitoring(self):
        """运行监控检查"""
        config = self.load_config()
        stats = self.load_stats()
        
        all_alerts = []
        all_alerts.extend(self.check_cost_alert(stats, config))
        all_alerts.extend(self.check_performance_alert(stats, config))
        
        # 保存告警
        if all_alerts:
            current_alerts = []
            if self.alerts_file.exists():
                with open(self.alerts_file, 'r') as f:
                    current_alerts = json.load(f)
            
            current_alerts.extend(all_alerts)
            
            with open(self.alerts_file, 'w') as f:
                json.dump(current_alerts, f, indent=2)
            
            print(f"⚠️ 发现{len(all_alerts)}个告警")
            for alert in all_alerts:
                print(f"   - {alert['message']}")
        else:
            print("✅ 系统运行正常")

if __name__ == "__main__":
    monitor = ModelPoolMonitor()
    monitor.run_monitoring()
