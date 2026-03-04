#!/usr/bin/env python3

"""
智能模型路由器
为蒋工的AI Agent提供最优模型选择
"""

import json
import re
import time
from datetime import datetime
from pathlib import Path

class ModelRouter:
    def __init__(self):
        self.workspace = Path("/home/node/.openclaw/workspace")
        self.config_file = self.workspace / "config" / "router_config.json"
        self.stats_file = self.workspace / "config" / "usage_stats.json"
        
        # 初始化配置
        self.load_config()
        self.init_stats()
        
        # 模型池定义
        self.model_pools = {
            "speed": {
                "name": "高速池",
                "models": ["default/glm-4.5-air"],
                "cost_per_token": 0.0001,
                "max_tokens": 8000,
                "timeout": 3
            },
            "intelligence": {
                "name": "智能池", 
                "models": ["default/glm-4.6"],
                "cost_per_token": 0.0003,
                "max_tokens": 16000,
                "timeout": 10
            },
            "text": {
                "name": "文本池",
                "models": ["default/glm-4.6"],  # 暂用智能池模型
                "cost_per_token": 0.0003,
                "max_tokens": 16000,
                "timeout": 8
            }
        }
        
        # 任务类型关键词
        self.task_keywords = {
            "speed": [
                # 简单问答
                "你好", "谢谢", "再见", "时间", "天气", "简单", "快速",
                # 状态查询
                "状态", "进度", "怎么样", "在吗", "帮忙看下",
                # 短命令
                "查看", "显示", "列出", "检查"
            ],
            "intelligence": [
                # 技术任务
                "代码", "编程", "开发", "架构", "设计", "调试", "优化",
                "API", "数据库", "算法", "系统", "部署", "测试",
                # 复杂推理
                "分析", "研究", "评估", "比较", "解释", "推理", "总结",
                "规划", "策略", "方案", "建议", "解决"
            ],
            "text": [
                # 写作任务
                "写", "编辑", "修改", "润色", "创作", "生成", "文案",
                "文章", "博客", "邮件", "报告", "总结", "翻译",
                # 内容处理
                "整理", "格式化", "重写", "扩写", "缩写", "优化"
            ]
        }
    
    def load_config(self):
        """加载路由配置"""
        try:
            if self.config_file.exists():
                with open(self.config_file, 'r') as f:
                    self.config = json.load(f)
            else:
                self.config = {
                    "fallback_enabled": True,
                    "cost_limit_per_day": 50.0,
                    "preferred_pool": "intelligence"
                }
        except Exception as e:
            print(f"加载配置失败: {e}")
            self.config = {}
    
    def save_config(self):
        """保存配置"""
        try:
            self.config_file.parent.mkdir(exist_ok=True)
            with open(self.config_file, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            print(f"保存配置失败: {e}")
    
    def init_stats(self):
        """初始化使用统计"""
        try:
            if self.stats_file.exists():
                with open(self.stats_file, 'r') as f:
                    self.stats = json.load(f)
            else:
                self.stats = {
                    "total_requests": 0,
                    "pool_usage": {"speed": 0, "intelligence": 0, "text": 0},
                    "daily_cost": 0.0,
                    "avg_response_time": 0.0,
                    "error_rate": 0.0
                }
        except Exception as e:
            print(f"加载统计失败: {e}")
            self.stats = {}
    
    def update_stats(self, pool, response_time, tokens_used, success=True):
        """更新使用统计"""
        self.stats["total_requests"] += 1
        self.stats["pool_usage"][pool] += 1
        
        # 更新响应时间
        if response_time:
            current_avg = self.stats["avg_response_time"]
            total = self.stats["total_requests"]
            self.stats["avg_response_time"] = ((current_avg * (total - 1)) + response_time) / total
        
        # 更新成本（估算）
        cost = tokens_used * self.model_pools[pool]["cost_per_token"]
        self.stats["daily_cost"] += cost
        
        # 更新错误率
        if not success:
            current_errors = self.stats["error_rate"] * (self.stats["total_requests"] - 1)
            self.stats["error_rate"] = (current_errors + 1) / self.stats["total_requests"]
        
        # 保存统计
        try:
            self.stats_file.parent.mkdir(exist_ok=True)
            with open(self.stats_file, 'w') as f:
                json.dump(self.stats, f, indent=2)
        except Exception as e:
            print(f"保存统计失败: {e}")
    
    def analyze_task_complexity(self, user_input):
        """分析任务复杂度"""
        # 基础复杂度评分
        complexity_score = 0
        pool_scores = {"speed": 0, "intelligence": 0, "text": 0}
        
        # 关键词匹配
        input_lower = user_input.lower()
        for pool, keywords in self.task_keywords.items():
            for keyword in keywords:
                if keyword in input_lower:
                    pool_scores[pool] += 1
                    complexity_score += 1
        
        # 文本长度分析
        if len(user_input) > 200:
            pool_scores["intelligence"] += 1
            complexity_score += 1
        elif len(user_input) > 50:
            pool_scores["speed"] += 0.5
        
        # 特殊模式检测
        # 代码相关
        if re.search(r'```|def |function|class |import |#include', user_input):
            pool_scores["intelligence"] += 3
            complexity_score += 2
        
        # 写作任务
        if re.search(r'写一篇|请写|帮我写|创作|生成.*文章', user_input):
            pool_scores["text"] += 3
            complexity_score += 2
        
        # 简单问答
        if re.search(r'^\?$|^你[是好在吗]|^\w{1,10}$|^[\u4e00-\u9fa5]{1,5}$', user_input.strip()):
            pool_scores["speed"] += 2
        
        return pool_scores, complexity_score
    
    def select_best_pool(self, user_input, context=None):
        """选择最优模型池"""
        pool_scores, complexity_score = self.analyze_task_complexity(user_input)
        
        # 基础选择逻辑
        if pool_scores["text"] >= 2:
            selected_pool = "text"
        elif pool_scores["intelligence"] >= 2 or complexity_score >= 3:
            selected_pool = "intelligence"
        elif pool_scores["speed"] >= 2 or complexity_score <= 1:
            selected_pool = "speed"
        else:
            # 默认智能池
            selected_pool = self.config.get("preferred_pool", "intelligence")
        
        # 成本控制检查
        daily_limit = self.config.get("cost_limit_per_day", 50.0)
        if self.stats["daily_cost"] >= daily_limit * 0.8:
            # 接近预算限制，优先使用便宜模型
            if selected_pool != "speed":
                print(f"⚠️ 接近日预算限制，降级到高速池")
                selected_pool = "speed"
        
        return selected_pool, pool_scores
    
    def get_model_for_pool(self, pool):
        """获取池中的可用模型"""
        models = self.model_pools[pool]["models"]
        # TODO: 实现健康检查和负载均衡
        # 暂时返回第一个可用模型
        return models[0] if models else None
    
    def route_request(self, user_input, context=None):
        """路由请求到最优模型"""
        start_time = time.time()
        
        # 选择模型池
        selected_pool, pool_scores = self.select_best_pool(user_input, context)
        model = self.get_model_for_pool(selected_pool)
        
        if not model:
            # fallback到默认模型
            model = "default/glm-4.6"
            selected_pool = "intelligence"
        
        routing_info = {
            "selected_pool": selected_pool,
            "model": model,
            "pool_scores": pool_scores,
            "pool_config": self.model_pools[selected_pool],
            "timestamp": datetime.now().isoformat()
        }
        
        # 模拟执行（实际应该调用相应的模型API）
        response_time = time.time() - start_time
        tokens_used = len(user_input.split()) * 2  # 估算token使用
        
        # 更新统计
        self.update_stats(selected_pool, response_time, tokens_used)
        
        return routing_info
    
    def get_performance_report(self):
        """获取性能报告"""
        report = f"""
📊 AI Agent 模型池性能报告
{'=' * 40}

🔢 总请求量: {self.stats['total_requests']}
💰 今日成本: ${self.stats['daily_cost']:.4f}
⚡ 平均响应时间: {self.stats['avg_response_time']:.3f}s
❌ 错误率: {self.stats['error_rate']*100:.2f}%

🏊 池使用情况:
  🚀 高速池: {self.stats['pool_usage']['speed']} 次
  🧠 智能池: {self.stats['pool_usage']['intelligence']} 次  
  📝 文本池: {self.stats['pool_usage']['text']} 次

💡 优化建议:
"""
        
        # 分析使用模式并提供建议
        total = self.stats['total_requests']
        if total > 0:
            speed_ratio = self.stats['pool_usage']['speed'] / total
            if speed_ratio < 0.3:
                report += "  - 建议增加简单任务识别，提高高速池使用率\n"
            elif speed_ratio > 0.7:
                report += "  - 简单任务较多，系统运行高效\n"
            
            if self.stats['daily_cost'] > 30:
                report += "  - 成本较高，考虑优化模型选择策略\n"
        
        return report

if __name__ == "__main__":
    router = ModelRouter()
    
    # 测试用例
    test_inputs = [
        "你好",
        "帮我写一个Python函数来计算斐波那契数列",
        "今天天气怎么样？",
        "请帮我分析一下这个商业模式的可行性",
        "写一篇关于AI的文章",
        "检查系统状态"
    ]
    
    print("🧠 智能模型路由器测试")
    print("=" * 50)
    
    for test_input in test_inputs:
        result = router.route_request(test_input)
        pool_name = router.model_pools[result["selected_pool"]]["name"]
        print(f"\n📝 输入: {test_input}")
        print(f"🎯 路由到: {pool_name} ({result['model']})")
        print(f"📊 评分: {result['pool_scores']}")
    
    print("\n" + router.get_performance_report())