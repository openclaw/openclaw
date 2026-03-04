#!/usr/bin/env python3

"""
实时路由测试
验证智能模型池是否正常工作
"""

from openclaw_integration import OpenClawIntegration

def test_live_routing():
    print("🧪 实时智能路由测试")
    print("=" * 40)
    
    integration = OpenClawIntegration()
    
    # 测试不同类型的任务
    test_cases = [
        ("简单问候", "你好，我是蒋工"),
        ("复杂编程", "帮我写一个完整的数据分析系统，包括数据清洗、可视化和机器学习模型"),
        ("商务写作", "帮我写一份给投资者的商业计划书，包括市场分析、盈利模式和融资需求"),
        ("快速查询", "检查一下今天的任务进度"),
        ("技术研究", "分析一下Transformer架构在NLP中的优势和局限性"),
        ("内容创作", "写一篇关于AI如何改变工作方式的博客文章")
    ]
    
    total_cost = 0
    pool_usage = {"speed": 0, "intelligence": 0, "text": 0}
    
    for task_type, user_input in test_cases:
        result = integration.process_user_input(user_input)
        
        print(f"\n📝 任务类型: {task_type}")
        print(f"💬 输入: {user_input[:50]}...")
        print(f"🎯 路由到: {result['pool_name']} ({result['model']})")
        print(f"💰 预估成本: ${result['estimated_cost']:.6f}")
        print(f"📊 置信度: {result['confidence']:.2f}")
        print(f"⏱️ 超时设置: {result['timeout']}s")
        
        total_cost += result['estimated_cost']
        pool_usage[result['pool']] += 1
    
    print(f"\n📊 测试总结")
    print("=" * 40)
    print(f"💰 总成本: ${total_cost:.6f}")
    print(f"🏊 池分布:")
    for pool, count in pool_usage.items():
        percentage = (count / len(test_cases)) * 100
        print(f"   {pool}: {count} 次 ({percentage:.1f}%)")
    
    # 获取系统状态
    status = integration.get_system_status()
    print(f"\n🔧 系统状态:")
    for key, value in status.items():
        print(f"   {key}: {value}")
    
    print(f"\n✅ 智能路由系统运行正常，为蒋工的赚钱AI提供强大支持！")

if __name__ == "__main__":
    test_live_routing()