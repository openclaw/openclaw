"""
RSS Feed 讀取模組
從多個來源讀取 RSS feeds
"""

import feedparser
import logging
from datetime import datetime
from typing import List, Dict
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)

# RSS 來源配置
RSS_SOURCES = {
    'hackernews': 'https://feeds.feedburner.com/TheHackersNews',
    'techcrunch': 'https://techcrunch.com/feed/',
    'arstechnica': 'http://feeds.arstechnica.com/arstechnica/index/',
    'openai': 'https://openai.com/news/rss.xml',
    'bair': 'https://bair.berkeley.edu/blog/feed.xml',
    'technews': 'https://technews.tw/feed/',
    'ithome': 'https://www.ithome.com.tw/rss',
}


def fetch_single_feed(source_name: str, url: str) -> List[Dict]:
    """
    讀取單一 RSS feed
    
    Args:
        source_name: 來源名稱
        url: RSS feed URL
        
    Returns:
        新聞列表
    """
    try:
        logger.info(f"  📡 讀取 {source_name}...")
        feed = feedparser.parse(url)
        
        if feed.bozo:
            logger.warning(f"  ⚠️  {source_name} RSS 格式有問題")
        
        news_items = []
        for entry in feed.entries:
            try:
                # 提取新聞資訊
                item = {
                    'title': entry.get('title', ''),
                    'link': entry.get('link', ''),
                    'content': entry.get('summary', entry.get('description', '')),
                    'pubDate': entry.get('published', entry.get('updated', '')),
                    'isoDate': entry.get('published_parsed', entry.get('updated_parsed', None)),
                    'source': source_name
                }
                
                # 轉換日期格式
                if item['isoDate']:
                    try:
                        dt = datetime(*item['isoDate'][:6])
                        item['isoDate'] = dt.isoformat()
                    except:
                        item['isoDate'] = ''
                
                news_items.append(item)
                
            except Exception as e:
                logger.warning(f"  ⚠️  處理 {source_name} 的某則新聞時出錯: {str(e)}")
                continue
        
        logger.info(f"  ✅ {source_name}: 讀取 {len(news_items)} 則")
        return news_items
        
    except Exception as e:
        logger.error(f"  ❌ 讀取 {source_name} 失敗: {str(e)}")
        return []


def fetch_all_rss_feeds(today_date: str) -> List[Dict]:
    """
    並行讀取所有 RSS feeds
    
    Args:
        today_date: 今日日期（用於日誌）
        
    Returns:
        所有新聞的列表
    """
    all_news = []
    
    # 使用 ThreadPoolExecutor 並行讀取
    with ThreadPoolExecutor(max_workers=7) as executor:
        # 提交所有任務
        future_to_source = {
            executor.submit(fetch_single_feed, name, url): name
            for name, url in RSS_SOURCES.items()
        }
        
        # 收集結果
        for future in as_completed(future_to_source):
            source_name = future_to_source[future]
            try:
                news_items = future.result()
                all_news.extend(news_items)
            except Exception as e:
                logger.error(f"❌ {source_name} 讀取任務失敗: {str(e)}")
    
    logger.info(f"📊 總共讀取 {len(all_news)} 則新聞")
    return all_news
