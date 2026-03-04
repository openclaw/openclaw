#!/usr/bin/env python3
"""
多源新闻聚合器 - 纯 Python 实现
不依赖外部库（feedparser, sentence-transformers）
"""

import xml.etree.ElementTree as ET
import json
import urllib.request
import urllib.error
import time
from datetime import datetime, timezone
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict
import hashlib


@dataclass
class NewsItem:
    """新闻项数据结构"""
    title: str
    description: str
    link: str
    pub_date: Optional[str] = None
    source: str = ""
    category: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)

    def get_hash(self) -> str:
        """生成唯一哈希（去重用）"""
        content = f"{self.title}{self.link}"
        return hashlib.md5(content.encode()).hexdigest()


class RSSFeedParser:
    """RSS Feed 解析器（纯 Python 实现）"""

    def __init__(self, feed_config: Dict):
        self.url = feed_config["url"]
        self.name = feed_config.get("name", "")
        self.category = feed_config.get("category", "general")
        self.update_interval = feed_config.get("update_interval", 300)
        self.format = feed_config.get("format", "rss")  # rss 或 json

    def fetch(self) -> Optional[ET.Element]:
        """获取 RSS Feed"""
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            req = urllib.request.Request(self.url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                content = response.read().decode('utf-8')
                return ET.fromstring(content)
        except Exception as e:
            print(f"❌ 获取 RSS 失败 ({self.name}): {e}")
            return None

    def fetch_json(self) -> Optional[Dict]:
        """获取 JSON Feed（Hacker News）"""
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            req = urllib.request.Request(self.url, headers=headers)
            with urllib.request.urlopen(req, timeout=10) as response:
                content = response.read().decode('utf-8')
                return json.loads(content)
        except Exception as e:
            print(f"❌ 获取 JSON 失败 ({self.name}): {e}")
            return None

    def parse(self) -> List[NewsItem]:
        """解析 RSS Feed"""
        # 检查是否为 JSON 格式
        if self.format == "json":
            return self._parse_json()

        root = self.fetch()
        if root is None:
            return []

        items = []

        # 尝试不同的 RSS 命名空间
        namespaces = {
            'atom': 'http://www.w3.org/2005/Atom',
            'rss': None,
        }

        # 尝试查找 item 条目
        if root.tag.endswith('rss'):
            channel = root.find('channel')
            if channel is not None:
                xml_items = channel.findall('item')
            else:
                xml_items = []
        elif root.tag.endswith('feed'):
            # Atom 格式
            xml_items = root.findall('atom:entry', namespaces)
        else:
            xml_items = root.findall('.//item') + root.findall('.//atom:entry', namespaces)

        for item in xml_items:
            try:
                title = self._get_text(item, ['title', 'atom:title'], namespaces)
                link = self._get_text(item, ['link', 'atom:link/@href'], namespaces)
                description = self._get_text(item, ['description', 'summary', 'atom:summary'], namespaces)
                pub_date = self._get_text(item, ['pubDate', 'published', 'atom:published'], namespaces)

                if not title or not link:
                    continue

                items.append(NewsItem(
                    title=title.strip(),
                    description=description.strip() if description else "",
                    link=link.strip(),
                    pub_date=pub_date,
                    source=self.name,
                    category=self.category
                ))
            except Exception as e:
                print(f"⚠️  解析新闻项失败: {e}")
                continue

        print(f"✅ {self.name}: 解析 {len(items)} 条新闻")
        return items

    def _get_text(self, element, tags, namespaces) -> str:
        """获取元素的文本内容"""
        for tag in tags:
            # 处理属性路径（如 atom:link/@href）
            if '/' in tag:
                elem_name, attr = tag.split('/')
                elem = element.find(elem_name, namespaces)
                if elem is not None:
                    return elem.get(attr, "")
            else:
                elem = element.find(tag, namespaces)
                if elem is not None:
                    return elem.text or ""
        return ""

    def _parse_json(self) -> List[NewsItem]:
        """解析 JSON Feed（Hacker News）"""
        data = self.fetch_json()
        if data is None:
            return []

        items = []

        # Hacker News 格式：[id1, id2, id3, ...]
        if isinstance(data, list):
            # 获取前 10 个故事
            story_ids = data[:10]

            for story_id in story_ids:
                try:
                    # 获取故事详情
                    story_url = f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json"
                    story_data = self.fetch_json_url(story_url)

                    if story_data:
                        title = story_data.get("title", "")
                        link = story_data.get("url", f"https://news.ycombinator.com/item?id={story_id}")
                        description = story_data.get("text", "")
                        pub_date = datetime.fromtimestamp(story_data.get("time", 0)).isoformat()

                        if title:
                            items.append(NewsItem(
                                title=title.strip(),
                                description=description.strip() if description else "",
                                link=link.strip(),
                                pub_date=pub_date,
                                source=self.name,
                                category=self.category
                            ))
                except Exception as e:
                    print(f"⚠️  解析 Hacker News 故事失败: {e}")
                    continue

        print(f"✅ {self.name}: 解析 {len(items)} 条新闻")
        return items

    def fetch_json_url(self, url: str) -> Optional[Dict]:
        """获取 JSON URL"""
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as response:
                content = response.read().decode('utf-8')
                return json.loads(content)
        except Exception as e:
            print(f"⚠️  获取 JSON URL 失败: {e}")
            return None


class NewsAggregator:
    """多源新闻聚合器"""

    def __init__(self):
        self.sources = self._load_sources()
        self.items: List[NewsItem] = []
        self.cache: Dict[str, datetime] = {}  # item_hash -> last_seen

    def _load_sources(self) -> List[Dict]:
        """加载 RSS 源配置"""
        return [
            {
                "name": "Google News Tech",
                "url": "https://news.google.com/rss/search?q=tech&hl=en-US&gl=US&ceid=US:en",
                "category": "tech",
                "update_interval": 300
            },
            {
                "name": "BBC World News",
                "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
                "category": "world",
                "update_interval": 300
            },
            {
                "name": "CNN World News",
                "url": "http://rss.cnn.com/rss/edition_world.rss",
                "category": "world",
                "update_interval": 300
            },
            {
                "name": "CoinDesk",
                "url": "https://www.coindesk.com/arc/outboundfeeds/rss/",
                "category": "crypto",
                "update_interval": 600
            },
            {
                "name": "CryptoSlate",
                "url": "https://cryptoslate.com/feed/",
                "category": "crypto",
                "update_interval": 300
            },
            {
                "name": "Hacker News (JSON)",
                "url": "https://hacker-news.firebaseio.com/v0/topstories.json",
                "category": "tech",
                "update_interval": 180,
                "format": "json"
            }
        ]

    def fetch_all(self) -> List[NewsItem]:
        """从所有源获取新闻"""
        all_items = []

        for source_config in self.sources:
            parser = RSSFeedParser(source_config)
            items = parser.parse()
            all_items.extend(items)

            # 简单的速率限制
            time.sleep(1)

        return all_items

    def deduplicate(self, items: List[NewsItem]) -> List[NewsItem]:
        """去重（基于标题和链接）"""
        seen = set()
        unique_items = []

        for item in items:
            item_hash = item.get_hash()
            if item_hash not in seen:
                seen.add(item_hash)
                unique_items.append(item)

        print(f"✅ 去重: {len(items)} → {len(unique_items)}")
        return unique_items

    def sort_by_date(self, items: List[NewsItem]) -> List[NewsItem]:
        """按发布日期排序"""
        def get_timestamp(item):
            if item.pub_date:
                try:
                    # 尝试解析多种日期格式
                    for fmt in [
                        '%a, %d %b %Y %H:%M:%S %Z',
                        '%Y-%m-%dT%H:%M:%S%z',
                        '%Y-%m-%dT%H:%M:%SZ',
                        '%Y-%m-%d %H:%M:%S'
                    ]:
                        try:
                            return datetime.strptime(item.pub_date, fmt).replace(tzinfo=timezone.utc).timestamp()
                        except:
                            continue
                except:
                    pass
            # 如果无法解析日期，使用当前时间
            return datetime.now(timezone.utc).timestamp()

        return sorted(items, key=get_timestamp, reverse=True)

    def aggregate(self) -> List[Dict]:
        """聚合所有源的新闻"""
        print(f"\n📰 开始聚合新闻...")

        # 获取所有新闻
        items = self.fetch_all()

        # 去重
        items = self.deduplicate(items)

        # 按日期排序
        items = self.sort_by_date(items)

        # 转换为字典
        result = [item.to_dict() for item in items]

        print(f"✅ 聚合完成: {len(result)} 条新闻\n")
        return result

    def save_to_file(self, items: List[Dict], filename: str):
        """保存到 JSON 文件"""
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        print(f"💾 已保存到: {filename}")


def main():
    """主函数：测试多源新闻聚合"""
    print("=" * 60)
    print("多源新闻聚合器 - 测试运行")
    print("=" * 60)

    aggregator = NewsAggregator()

    # 聚合新闻
    items = aggregator.aggregate()

    # 保存结果
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"news_aggregated_{timestamp}.json"
    aggregator.save_to_file(items, filename)

    # 打印前 5 条
    print(f"\n📊 前 5 条新闻:")
    for i, item in enumerate(items[:5], 1):
        print(f"\n{i}. {item['title']}")
        print(f"   来源: {item['source']}")
        print(f"   分类: {item['category']}")
        print(f"   链接: {item['link']}")


if __name__ == "__main__":
    main()
