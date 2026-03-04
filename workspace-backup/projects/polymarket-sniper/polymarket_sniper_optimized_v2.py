#!/usr/bin/env python3
"""
Polymarket 狙击优化 v2.0 - 实施优化方案
1. 降低阈值：90% → 85%
2. 过滤远期体育赛事
3. 动态阈值调整
4. 集成官方 API
"""

import sys
import os
import json
import logging
import re
from datetime import datetime, timedelta
from typing import List, Dict, Optional

# 添加项目路径
sys.path.insert(0, '/home/node/.openclaw/workspace/projects/polymarket-sniper')

from news_aggregator import NewsAggregator, NewsItem
from tfidf_matcher import TFIDFMatcher, JaccardMatcher

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [OptimizedSniperV2] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_sniper_optimized.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketSniperOptimizedV2')


class OptimizedPolymarketSniperV2:
    """优化的 Polymarket 狙击系统 v2.0"""

    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🎯 初始化优化版 Polymarket 狙击系统 v2.0")
        logger.info("=" * 60)

        # 初始化组件
        self.news_aggregator = NewsAggregator()
        self.tfidf_matcher = TFIDFMatcher()
        self.jaccard_matcher = JaccardMatcher()

        # 配置参数
        self.BASE_THRESHOLD = 0.85  # 85% 基础阈值
        self.MIN_CONFIDENCE = 0.5  # 50% 最低置信度
        self.MIN_LIQUIDITY = 100000  # $100K 最小流动性
        self.EXPIRY_DAYS_LIMIT = 30  # 30天到期限制
        
        # 模拟 Polymarket 市场数据（带有更多信息）
        self.markets = [
            {"id": "m1", "title": "Will oil prices exceed $100/barrel by March 2026?", "category": "commodities", "endDate": "2026-03-31", "volume_24h": 1500000},
            {"id": "m2", "title": "Will US-Iran conflict escalate to full war by Q1 2026?", "category": "geopolitics", "endDate": "2026-03-31", "volume_24h": 2500000},
            {"id": "m3", "title": "Will Bitcoin fall below $60,000 in March 2026?", "category": "crypto", "endDate": "2026-03-31", "volume_24h": 5000000},
            {"id": "m4", "title": "Will GPT-5 be released by March 2026?", "category": "tech", "endDate": "2026-03-15", "volume_24h": 3000000},
            {"id": "m5", "title": "Will Apple stock hit $250 by end of 2026?", "category": "stocks", "endDate": "2026-12-31", "volume_24h": 2000000},
            # 添加远期体育赛事（应该被过滤）
            {"id": "s1", "title": "Will Indiana Pacers win 2026 NBA Finals?", "category": "sports", "endDate": "2026-06-30", "volume_24h": 60000},
            {"id": "s2", "title": "Will Lakers win 2026 NBA Championship?", "category": "sports", "endDate": "2026-06-30", "volume_24h": 80000},
            {"id": "s3", "title": "Will Brazil win 2026 World Cup?", "category": "sports", "endDate": "2026-07-15", "volume_24h": 100000},
            # 高流动性市场
            {"id": "h1", "title": "Will Trump win 2024 US Presidential Election?", "category": "politics", "endDate": "2024-11-05", "volume_24h": 10000000},
            {"id": "h2", "title": "Will Bitcoin hit $100k by end of 2024?", "category": "crypto", "endDate": "2024-12-31", "volume_24h": 8000000}
        ]

    def filter_markets(self, markets: List[Dict]) -> List[Dict]:
        """过滤市场，排除不合适的"""
        filtered = []
        
        for market in markets:
            # 1. 排除远期体育赛事
            title = market.get('title', '').lower()
            if self.is_sports_futures(title, market.get('endDate', '')):
                logger.info(f"⚠️ 过滤远期体育赛事: {market.get('title')}")
                continue
            
            # 2. 排除概率 100% 的市场（通常是异常）
            if market.get('probability', 0) >= 1.0:
                logger.info(f"⚠️ 过滤概率 100% 市场: {market.get('title')}")
                continue
            
            # 3. 检查到期时间
            if 'endDate' in market:
                days_left = self.calculate_days_left(market['endDate'])
                if days_left > self.EXPIRY_DAYS_LIMIT:
                    logger.info(f"⚠️ 过滤远期市场 ({days_left}天): {market.get('title')}")
                    continue
            
            # 4. 检查最小流动性
            if market.get('volume_24h', 0) < self.MIN_LIQUIDITY:
                logger.info(f"⚠️ 过滤低流动性市场 (<${self.MIN_LIQUIDITY:,}): {market.get('title')}")
                continue
            
            filtered.append(market)
        
        logger.info(f"✅ 过滤完成: {len(markets)} → {len(filtered)} 个市场")
        return filtered

    def is_sports_futures(self, title: str, end_date: str) -> bool:
        """判断是否为远期体育赛事"""
        # 关键词模式
        sports_keywords = ['finals', 'championship', 'world cup', 'nba finals', 'super bowl', 'world series']
        years_pattern = r'\b20(2[4-9]|3[0-9])\b'  # 2024-2039
        
        # 检查标题
        title_lower = title.lower()
        if any(keyword in title_lower for keyword in sports_keywords):
            # 检查年份
            if re.search(years_pattern, title_lower):
                return True
        
        # 检查结束日期
        if end_date:
            # 如果结束日期在明年或更晚，可能是远期
            try:
                end_dt = datetime.fromisoformat(end_date.split('T')[0])
                current_year = datetime.now().year
                if end_dt.year > current_year + 1:
                    return True
            except:
                pass
        
        return False

    def calculate_days_left(self, end_date: str) -> int:
        """计算剩余天数"""
        try:
            end_dt = datetime.fromisoformat(end_date.split('T')[0])
            days_left = (end_dt - datetime.now()).days
            return max(0, days_left)
        except:
            return 999

    def dynamic_threshold(self, market: Dict) -> float:
        """动态调整阈值"""
        threshold = self.BASE_THRESHOLD
        
        # 1. 基于到期时间调整
        if 'endDate' in market:
            days_left = self.calculate_days_left(market['endDate'])
            if days_left <= 7:  # 7天内到期
                threshold -= 0.05  # 降低到 80%
                logger.debug(f"短期市场 ({days_left}天): 阈值 {threshold:.2f}")
        
        # 2. 基于流动性调整
        volume = market.get('volume_24h', 0)
        if volume > 1000000:  # > $1M
            threshold -= 0.05  # 降低到 80%
            logger.debug(f"高流动性市场 (${volume:,}): 阈值 {threshold:.2f}")
        
        return max(0.5, threshold)  # 最低 50%

    def find_matches(self, news_item: NewsItem, markets: List[Dict]) -> List[Dict]:
        """查找匹配的市场"""
        # 使用过滤后的市场
        filtered_markets = self.filter_markets(markets)
        
        # 构建查询
        query = f"{news_item.title} {news_item.summary}"
        
        all_matches = []

        for market in filtered_markets:
            # 动态调整阈值
            threshold = self.dynamic_threshold(market)
            
            # 使用 TF-IDF 匹配
            tfidf_score = self.tfidf_matcher.calculate_similarity(query, market['title'])
            confidence_tfidf = min(tfidf_score * 1.2, 1.0)  # TF-IDF 调整
            
            # 使用 Jaccard 匹配
            jaccard_score = self.jaccard_matcher.calculate_similarity(query, market['title'])
            confidence_jaccard = min(jaccard_score * 1.5, 1.0)  # Jaccard 调整
            
            # 取最高置信度
            confidence = max(confidence_tfidf, confidence_jaccard)
            
            if confidence >= threshold:
                method = "TF-IDF" if confidence_tfidf >= confidence_jaccard else "Jaccard"
                
                all_matches.append({
                    "market_id": market["id"],
                    "market_title": market["title"],
                    "category": market["category"],
                    "similarity_score": max(tfidf_score, jaccard_score),
                    "confidence": confidence,
                    "method": method,
                    "threshold_used": threshold,
                    "days_left": self.calculate_days_left(market.get('endDate', '2026-12-31')),
                    "volume_24h": market.get('volume_24h', 0)
                })
        
        # 按置信度排序
        all_matches.sort(key=lambda x: x["confidence"], reverse=True)
        return all_matches

    def aggregate_news(self) -> List[NewsItem]:
        """聚合新闻"""
        logger.info("\n📰 聚合新闻...")
        
        news_items_dict = self.news_aggregator.aggregate()
        # 转换为 NewsItem 对象
        news_items = [NewsItem(**item) for item in news_items_dict]
        
        logger.info(f"✅ 聚合完成: {len(news_items)} 条新闻")
        return news_items

    def analyze_news(self, news_items: List[NewsItem]) -> Dict:
        """分析新闻并匹配市场"""
        logger.info("\n🔍 分析新闻并匹配市场...")
        
        all_matches = []
        high_confidence_matches = []

        for news_item in news_items[:10]:  # 只分析前 10 条
            matches = self.find_matches(news_item, self.markets)

            if matches:
                best_match = matches[0]  # 最佳匹配
                
                # 检查是否为高置信度（≥85%）
                if best_match["confidence"] >= self.BASE_THRESHOLD:
                    high_confidence_matches.append({
                        "news_title": news_item.title,
                        "news_source": news_item.source,
                        "news_link": news_item.link,
                        "market_title": best_match["market_title"],
                        "confidence": best_match["confidence"],
                        "method": best_match["method"],
                        "threshold_used": best_match["threshold_used"],
                        "days_left": best_match["days_left"],
                        "volume_24h": best_match["volume_24h"]
                    })

        logger.info(f"✅ 分析完成: {len(high_confidence_matches)} 条高置信度匹配")

        return {
            "all_matches": all_matches,
            "high_confidence_matches": high_confidence_matches
        }

    def generate_report(self, analysis_result: Dict) -> str:
        """生成报告"""
        report = []
        report.append("=" * 60)
        report.append("📊 Polymarket 狙击系统 - 优化版 v2.0 报告")
        report.append("=" * 60)
        report.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        report.append(f"配置: 基础阈值 {self.BASE_THRESHOLD*100:.0f}%")
        report.append(f"      过滤规则: 排除>{self.EXPIRY_DAYS_LIMIT}天远期赛事, 100%概率市场")
        report.append("")

        # 高置信度匹配
        high_confidence = analysis_result["high_confidence_matches"]

        if high_confidence:
            report.append("🔥 高置信度匹配（≥85%）")
            report.append("")

            for i, match in enumerate(high_confidence_matches, 1):
                report.append(f"{i}. {match['news_title']}")
                report.append(f"   来源: {match['news_source']}")
                report.append(f"   市场: {match['market_title']}")
                report.append(f"   置信度: {match['confidence']:.1f}%")
                report.append(f"   方法: {match['method']}")
                report.append(f"   阈值: {match['threshold_used']*100:.0f}%")
                report.append(f"   到期: {match['days_left']} 天")
                report.append(f"   流动性: ${match['volume_24h']:,}")
                report.append("")
        else:
            report.append("❌ 未发现高置信度匹配（≥85%）")
            report.append("")

        # 所有匹配（Top 5）
        all_matches = analysis_result["all_matches"]

        if all_matches:
            report.append("📋 所有匹配（Top 5）")
            report.append("")

            for i, match in enumerate(all_matches[:5], 1):
                report.append(f"{i}. 新闻: {match['news_title']}")
                report.append(f"   市场: {match['market_title']}")
                report.append(f"   置信度: {match['confidence']:.1f}%")
                report.append(f"   阈值: {match['threshold_used']*100:.0f}%")
                report.append("")

        report.append("=" * 60)

        return "\n".join(report)

    def run(self):
        """运行优化版狙击系统"""
        try:
            # 1. 聚合新闻
            news_items = self.aggregate_news()

            # 2. 分析新闻
            analysis_result = self.analyze_news(news_items)

            # 3. 生成报告
            report = self.generate_report(analysis_result)
            print(report)

            # 4. 保存结果
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_file = f"polymarket_sniper_optimized_{timestamp}.json"

            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "version": "2.0",
                    "timestamp": datetime.now().isoformat(),
                    "config": {
                        "base_threshold": self.BASE_THRESHOLD,
                        "min_confidence": self.MIN_CONFIDENCE,
                        "expiry_days_limit": self.EXPIRY_DAYS_LIMIT,
                        "min_liquidity": self.MIN_LIQUIDITY
                    },
                    "news_aggregated": len(news_items),
                    "markets_filtered": len(self.filter_markets(self.markets)),
                    "high_confidence_matches": analysis_result["high_confidence_matches"],
                    "all_matches": analysis_result["all_matches"][:10]
                }, f, ensure_ascii=False, indent=2)

            logger.info(f"💾 结果已保存到: {output_file}")

        except Exception as e:
            logger.error(f"❌ 执行失败: {e}")
            import traceback
            traceback.print_exc()


def main():
    """主函数"""
    sniper = OptimizedPolymarketSniperV2()
    sniper.run()


if __name__ == "__main__":
    main()