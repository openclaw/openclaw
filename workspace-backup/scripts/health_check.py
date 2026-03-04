#!/usr/bin/env python3

"""
模型健康检查器
为蒋工的AI Agent提供模型池监控
"""

import json
import time
from datetime import datetime
from pathlib import Path

class ModelHealthChecker:
    def __init__(self):
        self.config_file = Path("/home/node/.openclaw/workspace/config/model_status.json")
        self.models = {
            "glm_4_5_air": {
                "name": "GLM-4.5-Air (高速池)",
                "api_endpoint": "待配置",
                "pool": "speed",
                "status": "unknown",
                "last_check": 0,
                "response_time": None,
                "error_count": 0
            },
            "glm_4_6": {
                "name": "GLM-4.6 (智能池)",
                "api_endpoint": "待配置", 
                "pool": "intelligence",
                "status": "unknown",
                "last_check": 0,
                "response_time": None,
                "error_count": 0
            },
            "gpt_4o": {
                "name": "GPT-4o (文本池)",
                "api_endpoint": "待配置",
                "pool": "text", 
                "status": "unknown",
                "last_check": 0,
                "response_time": None,
                "error_count": 0
            }
        }
        self.load_status()
    
    def load_status(self):
        """加载模型状态"""
        try:
            if self.config_file.exists():
                with open(self.config_file, 'r') as f:
                    saved_status = json.load(f)
                    for model_id, status in saved_status.items():
                        if model_id in self.models:
                            self.models[model_id].update(status)
        except Exception as e:
            print(f"加载模型状态失败: {e}")
    
    def save_status(self):
        """保存模型状态"""
        try:
            with open(self.config_file, 'w') as f:
                json.dump(self.models, f, indent=2)
        except Exception as e:
            print(f"保存模型状态失败: {e}")
    
    def check_model_health(self, model_id):
        """检查单个模型健康状态"""
        model = self.models[model_id]
        
        # 如果API端点未配置，跳过检查
        if model["api_endpoint"] == "待配置":
            model["status"] = "pending_config"
            return model
        
        try:
            start_time = time.time()
            
            # TODO: 实际API健康检查逻辑
            # 这里先用模拟数据
            import random
            success = random.random() > 0.1  # 90%成功率模拟
            
            response_time = time.time() - start_time
            
            if success:
                model["status"] = "healthy"
                model["response_time"] = round(response_time * 1000, 2)  # 毫秒
                model["error_count"] = 0
            else:
                model["status"] = "unhealthy"
                model["error_count"] += 1
                
        except Exception as e:
            model["status"] = "error"
            model["error_count"] += 1
            print(f"模型 {model_id} 检查失败: {e}")
        
        model["last_check"] = datetime.now().isoformat()
        return model
    
    def run_health_check(self):
        """运行所有模型健康检查"""
        print("🔍 开始模型健康检查...")
        
        for model_id in self.models:
            self.check_model_health(model_id)
        
        self.save_status()
        
        # 生成健康报告
        self.generate_health_report()
    
    def generate_health_report(self):
        """生成健康检查报告"""
        print("\n📊 模型池健康报告")
        print("=" * 50)
        
        for pool_name in ["speed", "intelligence", "text"]:
            pool_models = [m for m in self.models.values() if m["pool"] == pool_name]
            
            pool_display = {
                "speed": "🚀 高速池",
                "intelligence": "🧠 智能池", 
                "text": "📝 文本池"
            }
            
            print(f"\n{pool_display[pool_name]}:")
            for model in pool_models:
                status_icon = {
                    "healthy": "✅",
                    "unhealthy": "❌", 
                    "error": "⚠️",
                    "pending_config": "⏳"
                }
                
                status = model["status"]
                response_time = f" ({model['response_time']}ms)" if model["response_time"] else ""
                errors = f" [错误: {model['error_count']}]" if model["error_count"] > 0 else ""
                
                print(f"  {status_icon.get(status, '❓')} {model['name']}{response_time}{errors}")
        
        print(f"\n📅 检查时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("\n💡 明日任务：配置模型API端点并集成真实健康检查")

if __name__ == "__main__":
    checker = ModelHealthChecker()
    checker.run_health_check()