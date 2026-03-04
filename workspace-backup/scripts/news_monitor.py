#!/usr/bin/env python3
"""
新闻监控模块
支持 RSS + Brave Search
"""

import os
import sys
import json
import time
import logging
import feedparser
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Optional

# 设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [NewsMonitor] %(levelname)s - %(message)s'
)
logger = logging.getLogger('NewsMonitor')


class NewsMonitor:
    """新闻监控器"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("📰 初始化新闻监控器")
        logger.info("=" * 60)
        
        # RSS 源
        self.rss_feeds = [
            {
                "name": "Reuters World",
                "url": "https://feeds.reuters.com/Reuters/worldNews",
                "priority": "HIGH"
            },
            {
                "name": "BBC World",
                "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
                "priority": "HIGH"
            },
            {
                "name": "Al Jazeera",
                "url": "https://www.aljazeera.com/xml/rss/all.xml",
                "priority": "MEDIUM"
            }
        ]
        
        # Brave Search API
        self.brave_api_key = os.getenv('BRAVE_API_KEY')
        if self.brave_api_key:
            logger.info("✅ Brave API Key 已配置")
        else:
            logger.warning("⚠️  Brave API Key 未配置")
        
        # 关键词列表（Polymarket 相关）
        self.keywords = [
            "Iran", "Israel", "Ukraine", "Russia", "Trump", "Biden",
            "China", "Taiwan", "North Korea", "election", "military",
            "strike", "nuclear", "missile", "sanctions", "war"
        ]
        
        # 已处理的新闻（避免重复）
        self.processed = set()
        
        logger.info(f"   RSS 源: {len(self.rss_feeds)} 个")
        logger.info(f"   关键词: {len(self.keywords)} 个")
        logger.info("✅ 初始化完成")
    
    def fetch_rss(self) -> List[Dict]:
        """获取 RSS 新闻"""
        logger.info("📡 获取 RSS 新闻...")
        
        news_items = []
        
        for feed in self.rss_feeds:
            try:
                logger.info(f"   获取: {feed['name']}")
                
                # 解析 RSS
                parsed = feedparser.parse(feed['url'])
                
                if parsed.bozo:
                    logger.warning(f"      ⚠️  RSS 解析错误: {parsed.bozo_exception}")
                    continue
                
                # 提取新闻
                for entry in parsed.entries[:10]:  # 只取前 10 条
                    title = entry.get('title', '')
                    summary = entry.get('summary', '')
                    link = entry.get('link', '')
                    published = entry.get('published', '')
                    
                    # 检查关键词匹配
                    matched_keywords = []
                    for keyword in self.keywords:
                        if keyword.lower() in (title + summary).lower():
                            matched_keywords.append(keyword)
                    
                    if matched_keywords:
                        news_id = f"{feed['name']}:{title}"
                        
                        if news_id not in self.processed:
                            news_items.append({
                                "source": feed['name'],
                                "title": title,
                                "summary": summary,
                                "link": link,
                                "published": published,
                                "keywords": matched_keywords,
                                "priority": feed['priority'],
                                "timestamp": datetime.now().isoformat()
                            })
                            
                            self.processed.add(news_id)
                
                logger.info(f"      ✅ 找到 {len([n for n in news_items if n['source'] == feed['name']])} 条相关新闻")
                
            except Exception as e:
                logger.error(f"      ❌ 获取失败: {e}")
        
        logger.info(f"✅ 总共找到 {len(news_items)} 条相关新闻")
        return news_items
    
    def fetch_brave_search(self, query: str = "geopolitics breaking news") -> List[Dict]:
        """获取 Brave Search 新闻"""
        logger.info(f"🔍 Brave Search: {query}")
        
        if not self.brave_api_key:
            logger.warning("⚠️  Brave API Key 未配置，跳过")
            return []
        
        try:
            headers = {
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": self.brave_api_key
            }
            
            params = {
                "q": query,
                "count": 10,
                "search_lang": "en",
                "country": "us",
                "freshness": "pd"  # Past day
            }
            
            response = requests.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers=headers,
                params=params,
                timeout=10
            )
            
            if response.status_code != 200:
                logger.error(f"❌ Brave Search 失败: {response.status_code}")
                return []
            
            data = response.json()
            results = data.get('web', {}).get('results', [])
            
            news_items = []
            
            for result in results:
                title = result.get('title', '')
                description = result.get('description', '')
                url = result.get('url', '')
                
                # 检查关键词匹配
                matched_keywords = []
                for keyword in self.keywords:
                    if keyword.lower() in (title + description).lower():
                        matched_keywords.append(keyword)
                
                if matched_keywords:
                    news_items.append({
                        "source": "Brave Search",
                        "title": title,
                        "summary": description,
                        "link": url,
                        "keywords": matched_keywords,
                        "priority": "MEDIUM",
                        "timestamp": datetime.now().isoformat()
                    })
            
            logger.info(f"✅ 找到 {len(news_items)} 条相关新闻")
            return news_items
            
        except Exception as e:
            logger.error(f"❌ Brave Search 失败: {e}")
            return []
    
    def monitor(self) -> List[Dict]:
        """监控所有源"""
        logger.info("=" * 60)
        logger.info("🔍 开始监控新闻源")
        logger.info("=" * 60)
        
        all_news = []
        
        # 1. RSS 监控
        rss_news = self.fetch_rss()
        all_news.extend(rss_news)
        
        # 2. Brave Search 监控
        brave_news = self.fetch_brave_search("geopolitics breaking news")
        all_news.extend(brave_news)
        
        # 3. 按优先级排序
        all_news.sort(key=lambda x: (
            x['priority'] == 'HIGH',
            len(x['keywords'])
        ), reverse=True)
        
        logger.info("=" * 60)
        logger.info(f"✅ 总共找到 {len(all_news)} 条高价值新闻")
        logger.info("=" * 60)
        
        return all_news


def main():
    """测试主函数"""
    monitor = NewsMonitor()
    
    # 监控一次
    news = monitor.monitor()
    
    print("\n" + "=" * 60)
    print("📰 监控结果")
    print("=" * 60)
    
    for i, item in enumerate(news[:10], 1):
        print(f"\n#{i} {item['source']}")
        print(f"   标题: {item['title'][:60]}...")
        print(f"   关键词: {', '.join(item['keywords'])}")
        print(f"   优先级: {item['priority']}")


if __name__ == '__main__':
    main()
