#!/usr/bin/env python3
"""
Polymarket 狙击优化 - 集成版本
集成新闻聚合器 + TF-IDF 匹配器
"""

import sys
import os
import json
import logging
from datetime import datetime

# 添加项目路径
sys.path.insert(0, '/home/node/.openclaw/workspace/projects/polymarket-sniper')

from news_aggregator import NewsAggregator, NewsItem
from tfidf_matcher import TFIDFMatcher, JaccardMatcher

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [OptimizedSniper] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_sniper_optimized.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketSniperOptimized')


class OptimizedPolymarketSniper:
    """优化的 Polymarket 狙击系统"""

    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🎯 初始化优化版 Polymarket 狙击系统")
        logger.info("=" * 60)

        # 初始化组件
        self.news_aggregator = NewsAggregator()
        self.tfidf_matcher = TFIDFMatcher()
        self.jaccard_matcher = JaccardMatcher()

        # 模拟 Polymarket 市场数据
        self.markets = [
            {"id": "m1", "title": "Will oil prices exceed $100/barrel by March 2026?", "category": "commodities"},
            {"id": "m2", "title": "Will US-Iran conflict escalate to full war by Q1 2026?", "category": "geopolitics"},
            {"id": "m3", "title": "Will Bitcoin fall below $60,000 in March 2026?", "category": "crypto"},
            {"id": "m4", "title": "Will GPT-5 be released by March 2026?", "category": "tech"},
            {"id": "m5", "title": "Will Elon Musk's net worth exceed $710B by 2026?", "category": "finance"},
            {"id": "m6", "title": "Will Nice mayoral election be won by Eric Ciotti?", "category": "politics"},
            {"id": "m7", "title": "Will Bitcoin exceed $100,000 by 2026?", "category": "crypto"},
            {"id": "m8", "title": "Will AI regulations be passed in US by 2026?", "category": "tech"}
        ]

        # 初始化匹配器
        self._initialize_matchers()

    def _initialize_matchers(self):
        """初始化匹配器"""
        market_titles = [m["title"] for m in self.markets]

        logger.info("📊 初始化 TF-IDF 匹配器...")
        self.tfidf_matcher.add_documents(market_titles)

        logger.info("📊 初始化 Jaccard 匹配器...")
        self.jaccard_matcher.add_documents(market_titles)

        logger.info(f"✅ 匹配器初始化完成（{len(market_titles)} 个市场）")

    def aggregate_news(self):
        """聚合新闻"""
        logger.info("\n📰 聚合新闻...")

        news_items = self.news_aggregator.aggregate()

        logger.info(f"✅ 聚合完成: {len(news_items)} 条新闻")
        return news_items

    def find_matches(self, news_item, min_confidence: float = 0.85) -> dict:
        """查找匹配的市场"""
        # 支持 NewsItem 对象或字典
        if isinstance(news_item, dict):
            title = news_item.get("title", "")
            description = news_item.get("description", "")
            source = news_item.get("source", "")
            link = news_item.get("link", "")
        else:
            title = news_item.title
            description = news_item.description
            source = news_item.source
            link = news_item.link

        # 合并标题和描述
        query = f"{title} {description}"

        # 使用 TF-IDF 匹配
        tfidf_results = self.tfidf_matcher.match(
            query,
            top_k=3,
            min_confidence=min_confidence
        )

        # 使用 Jaccard 匹配（备用）
        jaccard_results = self.jaccard_matcher.match(
            query,
            top_k=3,
            min_confidence=min_confidence * 0.8  # Jaccard 阈值略低
        )

        # 合并结果（去重）
        all_matches = {}

        # 添加 TF-IDF 结果
        for result in tfidf_results:
            if result.market_id not in all_matches:
                all_matches[result.market_id] = {
                    "market_id": result.market_id,
                    "market_title": result.market_title,
                    "similarity_score": result.similarity_score,
                    "confidence": result.confidence,
                    "method": "TF-IDF"
                }
            else:
                # 如果已存在，取更高的置信度
                if result.confidence > all_matches[result.market_id]["confidence"]:
                    all_matches[result.market_id]["confidence"] = result.confidence
                    all_matches[result.market_id]["method"] = "TF-IDF"

        # 添加 Jaccard 结果
        for result in jaccard_results:
            if result.market_id not in all_matches:
                all_matches[result.market_id] = {
                    "market_id": result.market_id,
                    "market_title": result.market_title,
                    "similarity_score": result.similarity_score,
                    "confidence": result.confidence,
                    "method": "Jaccard"
                }

        # 转换为列表并排序
        matches = sorted(all_matches.values(), key=lambda x: x["confidence"], reverse=True)

        return matches

    def analyze_news(self, news_items: list):
        """分析新闻并匹配市场"""
        logger.info("\n🔍 分析新闻并匹配市场...")

        all_matches = []
        high_confidence_matches = []

        for news_item in news_items[:10]:  # 只分析前 10 条
            matches = self.find_matches(news_item, min_confidence=0.85)

            if matches:
                best_match = matches[0]  # 最佳匹配
                all_matches.append({
                    "news_title": news_item.title,
                    "news_source": news_item.source,
                    "news_link": news_item.link,
                    "best_match": best_match,
                    "all_matches": matches
                })

                # 检查高置信度匹配（≥85%） - 降低阈值，提高机会捕捉率
                if best_match["confidence"] >= 60:
                    high_confidence_matches.append({
                        "news_title": news_item.title,
                        "news_source": news_item.source,
                        "market_title": best_match["market_title"],
                        "confidence": best_match["confidence"],
                        "method": best_match["method"]
                    })

        logger.info(f"✅ 分析完成: {len(high_confidence_matches)} 条高置信度匹配")

        return {
            "all_matches": all_matches,
            "high_confidence_matches": high_confidence_matches
        }

    def generate_report(self, analysis_result: dict) -> str:
        """生成报告"""
        report = []
        report.append("=" * 60)
        report.append("📊 Polymarket 狙击系统 - 优化版报告")
        report.append("=" * 60)
        report.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
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
                report.append(f"   来源: {match['news_source']}")
                report.append(f"   市场: {match['best_match']['market_title']}")
                report.append(f"   置信度: {match['best_match']['confidence']:.1f}%")
                report.append(f"   方法: {match['best_match']['method']}")
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
                    "timestamp": datetime.now().isoformat(),
                    "news_aggregated": len(news_items),
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
    sniper = OptimizedPolymarketSniper()
    sniper.run()


if __name__ == "__main__":
    main()
