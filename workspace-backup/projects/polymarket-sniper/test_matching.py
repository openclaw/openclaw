#!/usr/bin/env python3
"""
测试 TF-IDF 匹配效果
"""

from news_aggregator import NewsAggregator
from tfidf_matcher import TFIDFMatcher

# 初始化
aggregator = NewsAggregator()
matcher = TFIDFMatcher()

# 模拟市场
markets = [
    {'id': 'm1', 'title': 'Will oil prices exceed $100/barrel by March 2026?'},
    {'id': 'm2', 'title': 'Will US-Iran conflict escalate to full war by Q1 2026?'},
    {'id': 'm3', 'title': 'Will Bitcoin fall below $60,000 in March 2026?'},
    {'id': 'm4', 'title': 'Will GPT-5 be released by March 2026?'},
    {'id': 'm7', 'title': 'Will Bitcoin exceed $100,000 by 2026?'},
    {'id': 'm8', 'title': 'Will AI regulations be passed in US by 2026?'}
]

# 初始化匹配器
matcher.add_documents([m['title'] for m in markets])

print("=" * 60)
print("🔍 TF-IDF 匹配测试")
print("=" * 60)

# 测试用例（模拟新闻）
test_news = [
    "Oil prices surge as tensions in Middle East escalate",
    "Bitcoin crashes below $60k amid market uncertainty",
    "OpenAI announces GPT-5 will be released next year",
    "US and Iran on brink of war after recent attacks",
    "Bitcoin rebounds to $70k as institutional buying increases"
]

print(f"\n测试新闻数: {len(test_news)}\n")

for i, news in enumerate(test_news, 1):
    print(f"[{i}] {news}")
    print("-" * 60)

    results = matcher.match(news, top_k=3, min_confidence=0.4)

    if results:
        for r in results:
            print(f"  ✅ 市场ID: {r.market_id}")
            print(f"     市场: {r.market_title}")
            print(f"     相似度: {r.similarity_score:.4f}")
            print(f"     置信度: {r.confidence:.1f}%")
    else:
        print(f"  ❌ 无匹配")

    print()

print("=" * 60)
print("✅ 测试完成")
print("=" * 60)
