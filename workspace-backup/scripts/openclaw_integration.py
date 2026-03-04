#!/usr/bin/env python3

"""
OpenClaw集成层
将智能路由器集成到OpenClaw系统中
"""

import json
import sys
import time
from pathlib import Path
from model_router import ModelRouter

class OpenClawIntegration:
    def __init__(self):
        self.workspace = Path("/home/node/.openclaw/workspace")
        self.router = ModelRouter()
        self.integration_config = self.workspace / "config" / "integration_config.json"
        
        # 加载集成配置
        self.load_config()
        
    def load_config(self):
        """加载集成配置"""
        try:
            if self.integration_config.exists():
                with open(self.integration_config, 'r') as f:
                    self.config = json.load(f)
            else:
                self.config = {
                    "auto_routing": True,
                    "fallback_enabled": True,
                    "performance_monitoring": True,
                    "cost_tracking": True
                }
        except Exception as e:
            print(f"加载集成配置失败: {e}")
            self.config = {}
    
    def save_config(self):
        """保存配置"""
        try:
            self.integration_config.parent.mkdir(exist_ok=True)
            with open(self.integration_config, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            print(f"保存配置失败: {e}")
    
    def process_user_input(self, user_input, session_context=None):
        """处理用户输入，返回路由建议"""
        if not self.config.get("auto_routing", True):
            # 如果禁用自动路由，返回默认模型
            return {
                "action": "use_default",
                "model": "default/glm-4.6",
                "reason": "自动路由已禁用"
            }
        
        # 使用智能路由器
        routing_result = self.router.route_request(user_input, session_context)
        
        # 添加OpenClaw特定配置
        pool_config = routing_result["pool_config"]
        
        return {
            "action": "route_request",
            "model": routing_result["model"],
            "pool": routing_result["selected_pool"],
            "pool_name": pool_config["name"],
            "timeout": pool_config["timeout"],
            "max_tokens": pool_config["max_tokens"],
            "estimated_cost": pool_config["cost_per_token"] * len(user_input.split()),
            "confidence": self.calculate_confidence(routing_result["pool_scores"]),
            "routing_scores": routing_result["pool_scores"],
            "timestamp": routing_result["timestamp"]
        }
    
    def calculate_confidence(self, pool_scores):
        """计算路由置信度"""
        total_score = sum(pool_scores.values())
        if total_score == 0:
            return 0.5  # 默认置信度
        
        # 计算最高分占比
        max_score = max(pool_scores.values())
        confidence = max_score / total_score
        
        # 最低置信度设为0.3
        return max(0.3, confidence)
    
    def get_session_optimization_suggestion(self, session_history):
        """基于会话历史提供优化建议"""
        if not session_history or len(session_history) < 3:
            return "会话历史不足，无法提供优化建议"
        
        # 分析会话模式
        simple_queries = 0
        complex_queries = 0
        text_queries = 0
        
        for msg in session_history[-10:]:  # 分析最近10条消息
            if isinstance(msg, str) and len(msg) > 0:
                scores, _ = self.router.analyze_task_complexity(msg)
                if scores["speed"] > scores["intelligence"] and scores["speed"] > scores["text"]:
                    simple_queries += 1
                elif scores["intelligence"] > scores["speed"] and scores["intelligence"] > scores["text"]:
                    complex_queries += 1
                elif scores["text"] > scores["speed"] and scores["text"] > scores["intelligence"]:
                    text_queries += 1
        
        # 生成建议
        suggestions = []
        
        if simple_queries > 5:
            suggestions.append("检测到大量简单查询，建议启用高速池以提升响应速度")
        
        if text_queries > 3:
            suggestions.append("检测到写作任务，建议使用文本专用模型以提升内容质量")
        
        if complex_queries < 2 and simple_queries > 5:
            suggestions.append("当前会话以简单任务为主，系统运行效率良好")
        
        return "\n".join(suggestions) if suggestions else "当前会话模式正常，无特殊优化建议"
    
    def generate_performance_dashboard(self):
        """生成性能仪表板数据"""
        stats = self.router.stats
        pool_usage = stats["pool_usage"]
        total = stats["total_requests"]
        
        dashboard = {
            "summary": {
                "total_requests": total,
                "daily_cost": f"${stats['daily_cost']:.4f}",
                "avg_response_time": f"{stats['avg_response_time']:.3f}s",
                "error_rate": f"{stats['error_rate']*100:.2f}%"
            },
            "pool_distribution": {
                "speed": {
                    "count": pool_usage["speed"],
                    "percentage": (pool_usage["speed"] / total * 100) if total > 0 else 0,
                    "name": "高速池"
                },
                "intelligence": {
                    "count": pool_usage["intelligence"], 
                    "percentage": (pool_usage["intelligence"] / total * 100) if total > 0 else 0,
                    "name": "智能池"
                },
                "text": {
                    "count": pool_usage["text"],
                    "percentage": (pool_usage["text"] / total * 100) if total > 0 else 0,
                    "name": "文本池"
                }
            },
            "recommendations": []
        }
        
        # 生成优化建议
        if total > 0:
            speed_ratio = pool_usage["speed"] / total
            if speed_ratio < 0.3:
                dashboard["recommendations"].append("建议增加简单任务识别，提升高速池使用率")
            
            if stats["daily_cost"] > 30:
                dashboard["recommendations"].append("成本较高，考虑优化模型选择策略")
            
            if stats["error_rate"] > 0.05:
                dashboard["recommendations"].append("错误率偏高，检查模型健康状态")
        
        return dashboard
    
    def enable_routing_mode(self, mode="auto"):
        """启用路由模式"""
        if mode == "auto":
            self.config["auto_routing"] = True
            self.config["fallback_enabled"] = True
        elif mode == "manual":
            self.config["auto_routing"] = False
        elif mode == "cost_optimized":
            self.config["auto_routing"] = True
            self.config["cost_limit_per_day"] = 20.0  # 严格成本控制
        
        self.save_config()
        return f"已启用{mode}路由模式"
    
    def get_system_status(self):
        """获取系统状态"""
        return {
            "router_status": "✅ 运行正常",
            "integration_status": "✅ 集成完成", 
            "auto_routing": self.config.get("auto_routing", False),
            "fallback_enabled": self.config.get("fallback_enabled", True),
            "performance_monitoring": self.config.get("performance_monitoring", True),
            "last_update": time.strftime("%Y-%m-%d %H:%M:%S")
        }

if __name__ == "__main__":
    integration = OpenClawIntegration()
    
    # 测试集成
    test_inputs = [
        "你好",
        "帮我写一个复杂的Python程序",
        "分析这个商业模式",
        "写一篇技术文章"
    ]
    
    print("🚀 OpenClaw集成测试")
    print("=" * 50)
    
    for test_input in test_inputs:
        result = integration.process_user_input(test_input)
        print(f"\n📝 输入: {test_input}")
        print(f"🎯 路由: {result['pool_name']} ({result['model']})")
        print(f"💰 预估成本: ${result['estimated_cost']:.6f}")
        print(f"📊 置信度: {result['confidence']:.2f}")
        print(f"⏱️ 超时: {result['timeout']}s")
    
    print(f"\n{integration.get_system_status()}")