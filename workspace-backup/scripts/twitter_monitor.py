#!/usr/bin/env python3
"""
Twitter/X 实时监控模块
监控关键账号的推文，提取新闻事件
"""

import os
import sys
import json
import time
import logging
from datetime import datetime
from typing import Dict, List, Optional

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [Twitter] %(levelname)s - %(message)s'
)
logger = logging.getLogger('TwitterMonitor')


class TwitterMonitor:
    """Twitter/X 监控器"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🐦 初始化 Twitter/X 监控器")
        logger.info("=" * 60)
        
        # 关键账号列表（OSINT 源）
        self.accounts = [
            # 中东问题专家
            "sentdefender",      # 防务分析师
            "osinttechnical",    # OSINT 技术
            "barnes_law",        # 法律分析师
            
            # 乌克兰战争
            "wartranslated",     # 战争翻译
            "geoconfirmed",      # 地理确认
            
            # 美国政治
            "politico",          # 政治新闻
            "axios",             # 新闻
            
            # 加密货币/预测市场
            "polymarket",        # Polymarket 官方
            "polyglobeai",       # Polyglobe AI
        ]
        
        # 关键词过滤
        self.keywords = [
            "Iran", "Israel", "Gaza", "Hamas", "Hezbollah",
            "Ukraine", "Russia", "Putin", "NATO",
            "Trump", "Biden", "election",
            "China", "Taiwan", "Xi",
            "North Korea", "Kim",
            "breaking", "urgent", "alert"
        ]
        
        # 模拟数据模式（如果没有 API 访问权限）
        self.simulation_mode = os.getenv('TWITTER_SIMULATION', 'true').lower() == 'true'
        
        logger.info(f"   监控账号: {len(self.accounts)} 个")
        logger.info(f"   模拟模式: {self.simulation_mode}")
        logger.info("✅ 初始化完成")
    
    def monitor(self) -> List[Dict]:
        """监控推文"""
        logger.info("🔍 监控 Twitter/X...")
        
        if self.simulation_mode:
            return self._simulate_tweets()
        
        # 实际 Twitter API 调用（需要 API Key）
        try:
            # TODO: 实现 Twitter API v2 调用
            # 需要 TWITTER_BEARER_TOKEN
            logger.warning("⚠️  Twitter API 未配置，使用模拟模式")
            return self._simulate_tweets()
            
        except Exception as e:
            logger.error(f"❌ Twitter 监控失败: {e}")
            return []
    
    def _simulate_tweets(self) -> List[Dict]:
        """模拟推文数据（用于测试）"""
        logger.info("📊 生成模拟推文...")
        
        # 基于真实新闻事件的模拟数据
        events = [
            {
                "account": "sentdefender",
                "text": "BREAKING: Iranian naval vessels spotted moving toward the Strait of Hormuz. Multiple oil tankers rerouting.",
                "timestamp": datetime.now().isoformat(),
                "keywords": ["Iran", "Hormuz", "breaking"],
                "priority": "high",
                "link": "https://twitter.com/sentdefender/status/1234567890"
            },
            {
                "account": "wartranslated",
                "text": "Russian forces launch new offensive in Donbas region. Heavy fighting reported near Bakhmut.",
                "timestamp": datetime.now().isoformat(),
                "keywords": ["Russia", "Ukraine", "Donbas"],
                "priority": "medium",
                "link": "https://twitter.com/wartranslated/status/1234567891"
            },
            {
                "account": "politico",
                "text": "NEW POLL: Trump leads Biden in 5 key swing states ahead of 2024 election.",
                "timestamp": datetime.now().isoformat(),
                "keywords": ["Trump", "Biden", "election"],
                "priority": "medium",
                "link": "https://twitter.com/politico/status/1234567892"
            }
        ]
        
        logger.info(f"✅ 生成 {len(events)} 个模拟事件")
        return events
    
    def filter_by_keywords(self, tweets: List[Dict]) -> List[Dict]:
        """按关键词过滤推文"""
        filtered = []
        
        for tweet in tweets:
            text = tweet.get('text', '').lower()
            
            # 检查是否包含关键词
            matches = [kw for kw in self.keywords if kw.lower() in text]
            
            if matches:
                tweet['matched_keywords'] = matches
                filtered.append(tweet)
        
        logger.info(f"📊 过滤结果: {len(filtered)}/{len(tweets)} 条推文")
        return filtered
    
    def prioritize(self, tweets: List[Dict]) -> List[Dict]:
        """优先级排序"""
        def get_priority_score(tweet):
            priority = tweet.get('priority', 'low')
            if priority == 'high':
                return 3
            elif priority == 'medium':
                return 2
            else:
                return 1
        
        sorted_tweets = sorted(tweets, key=get_priority_score, reverse=True)
        return sorted_tweets


def main():
    """测试"""
    monitor = TwitterMonitor()
    
    # 监控推文
    tweets = monitor.monitor()
    
    # 过滤
    filtered = monitor.filter_by_keywords(tweets)
    
    # 排序
    prioritized = monitor.prioritize(filtered)
    
    print("\n" + "=" * 60)
    print("📊 监控结果")
    print("=" * 60)
    
    for i, tweet in enumerate(prioritized[:5]):
        print(f"\n#{i+1} {tweet['account']}")
        print(f"   {tweet['text'][:100]}...")
        print(f"   关键词: {tweet.get('matched_keywords', [])}")


if __name__ == '__main__':
    main()
