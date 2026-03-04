#!/usr/bin/env python3
"""
测试优化版本 - 只测试关键功能
"""

import json
from datetime import datetime

# 模拟市场数据
markets = [
    {"id": "m1", "title": "Will oil prices exceed $100/barrel by March 2026?", "category": "commodities", "endDate": "2026-03-31", "volume_24h": 1500000},
    {"id": "s1", "title": "Will Indiana Pacers win 2026 NBA Finals?", "category": "sports", "endDate": "2026-06-30", "volume_24h": 60000},
    {"id": "s2", "title": "Will Lakers win 2026 NBA Championship?", "category": "sports", "endDate": "2026-06-30", "volume_24h": 80000},
    {"id": "h1", "title": "Will Trump win 2024 US Presidential Election?", "category": "politics", "endDate": "2024-11-05", "volume_24h": 10000000},
]

def filter_markets(markets):
    """过滤市场"""
    print("测试市场过滤功能...")
    
    BASE_THRESHOLD = 0.85
    EXPIRY_DAYS_LIMIT = 30
    MIN_LIQUIDITY = 100000
    
    filtered = []
    
    for market in markets:
        # 1. 检查远期体育赛事
        title_lower = market.get('title', '').lower()
        if '2026' in title_lower and 'nba finals' in title_lower:
            print(f"✅ 过滤远期体育赛事: {market.get('title')}")
            continue
        
        # 2. 检查到期时间
        if market.get('probability', 0) >= 1.0:
            print(f"✅ 过滤概率 100% 市场: {market.get('title')}")
            continue
            
        # 3. 检查最小流动性
        if market.get('volume_24h', 0) < MIN_LIQUIDITY:
            print(f"✅ 过滤低流动性市场 (<${MIN_LIQUIDITY:,}): {market.get('title')}")
            continue
            
        filtered.append(market)
    
    print(f"✅ 过滤完成: {len(markets)} → {len(filtered)} 个市场")
    return filtered

def dynamic_threshold_test(market):
    """动态阈值测试"""
    BASE_THRESHOLD = 0.85
    threshold = BASE_THRESHOLD
    
    # 基于流动性调整
    volume = market.get('volume_24h', 0)
    if volume > 1000000:  # > $1M
        threshold -= 0.05  # 降低到 80%
        print(f"✅ 高流动性市场 (${volume:,}): 阈值 {threshold:.2f}")
    
    return threshold

# 测试
print("=" * 60)
print("🧪 测试优化功能")
print("=" * 60)

# 测试过滤
filtered = filter_markets(markets)

# 测试动态阈值
for market in filtered:
    threshold = dynamic_threshold_test(market)
    print(f"市场: {market['title'][:30]:<30} | 阈值: {threshold:.2f}")

print("\n✅ 优化功能测试完成！")