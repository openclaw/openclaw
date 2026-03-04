#!/usr/bin/env python3
"""
Polymarket 消息面狙击系统
借鉴 Polyglobe 的 OSINT + 预测市场思路
"""

import os
import sys
import json
import time
import logging
from datetime import datetime
from typing import Dict, List, Optional

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds
from dotenv import load_dotenv

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [Sniper] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_sniper.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketSniper')


class PolymarketSniper:
    """Polymarket 消息面狙击器"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🎯 初始化 Polymarket 消息面狙击系统")
        logger.info("=" * 60)
        
        # 加载凭证
        load_dotenv('/home/node/.openclaw/workspace/config/polymarket.env')
        
        self.api_key = os.getenv('POLYMARKET_API_KEY')
        self.api_secret = os.getenv('POLYMARKET_SECRET')
        self.passphrase = os.getenv('POLYMARKET_PASSPHRASE')
        self.address = os.getenv('POLYMARKET_ADDRESS')
        self.private_key = os.getenv('POLYMARKET_PRIVATE_KEY')
        
        # 初始化客户端
        self.client = ClobClient(
            host="https://clob.polymarket.com",
            creds=ApiCreds(
                api_key=self.api_key,
                api_secret=self.api_secret,
                api_passphrase=self.passphrase
            ),
            chain_id=137,
            key=self.private_key,
            signature_type=1,
            funder=self.address
        )
        
        # 加载关键词映射
        self.keyword_mapping = self._load_keyword_mapping()
        
        logger.info(f"   地址: {self.address}")
        logger.info("✅ 初始化完成")
    
    def _load_keyword_mapping(self) -> Dict:
        """加载关键词到市场的映射"""
        return {
            # 中东相关
            "iran": ["Iran", "Hormuz", "nuclear", "Israel"],
            "israel": ["Israel", "Gaza", "Hamas", "Hezbollah"],
            "strait of hormuz": ["Hormuz", "Iran", "oil", "tanker"],
            
            # 乌克兰相关
            "ukraine": ["Ukraine", "Russia", "Kyiv", "Donbas"],
            "russia": ["Russia", "Ukraine", "Putin", "NATO"],
            
            # 美国政治
            "trump": ["Trump", "Republican", "election", "2028"],
            "biden": ["Biden", "Democrat", "election"],
            
            # 其他
            "china": ["China", "Taiwan", "Xi", "military"],
            "north korea": ["North Korea", "Kim", "nuclear", "missile"]
        }
    
    def monitor_osint_sources(self) -> List[Dict]:
        """监控 OSINT 源（Twitter/新闻）"""
        logger.info("🔍 监控 OSINT 源...")
        
        all_events = []
        
        # 1. 新闻监控
        try:
            from news_monitor import NewsMonitor
            
            news_monitor = NewsMonitor()
            news_items = news_monitor.monitor()
            
            for item in news_items:
                all_events.append({
                    "source": item['source'],
                    "account": item['source'],
                    "text": f"{item['title']}\n\n{item['summary']}",
                    "timestamp": item['timestamp'],
                    "keywords": item['keywords'],
                    "priority": item['priority'],
                    "link": item['link']
                })
            
            logger.info(f"   ✅ 新闻: {len(news_items)} 条")
            
        except Exception as e:
            logger.error(f"❌ 新闻监控失败: {e}")
        
        # 2. Twitter/X 监控（新增）
        try:
            from twitter_monitor import TwitterMonitor
            
            twitter_monitor = TwitterMonitor()
            tweets = twitter_monitor.monitor()
            filtered_tweets = twitter_monitor.filter_by_keywords(tweets)
            prioritized_tweets = twitter_monitor.prioritize(filtered_tweets)
            
            for tweet in prioritized_tweets:
                all_events.append({
                    "source": "twitter",
                    "account": tweet['account'],
                    "text": tweet['text'],
                    "timestamp": tweet['timestamp'],
                    "keywords": tweet.get('matched_keywords', tweet.get('keywords', [])),
                    "priority": tweet['priority'],
                    "link": tweet.get('link', '')
                })
            
            logger.info(f"   ✅ Twitter: {len(prioritized_tweets)} 条")
            
        except Exception as e:
            logger.error(f"❌ Twitter 监控失败: {e}")
        
        logger.info(f"✅ 总计: {len(all_events)} 个事件")
        return all_events
    
    def find_related_markets(self, keywords: List[str]) -> List[Dict]:
        """查找相关市场"""
        logger.info(f"🔍 查找相关市场: {keywords}")
        
        try:
            # 获取所有市场
            markets_response = self.client.get_sampling_markets()
            
            # 确保是列表格式
            if isinstance(markets_response, dict):
                markets = markets_response.get('data', [])
            elif isinstance(markets_response, list):
                markets = markets_response
            else:
                logger.error(f"❌ 未知的市场格式: {type(markets_response)}")
                return []
            
            related = []
            for market in markets:
                if not isinstance(market, dict):
                    continue
                
                question = market.get('question', '').lower()
                
                # 检查关键词匹配
                matches = sum(1 for kw in keywords if kw.lower() in question)
                
                if matches > 0:
                    related.append({
                        "market": market,
                        "matches": matches,
                        "relevance": matches / len(keywords)
                    })
            
            # 按相关性排序
            related.sort(key=lambda x: x['relevance'], reverse=True)
            
            logger.info(f"   找到 {len(related)} 个相关市场")
            return related[:5]  # 返回前 5 个最相关的
            
        except Exception as e:
            logger.error(f"❌ 查找市场失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return []
    
    def analyze_impact(self, event: Dict, markets: List[Dict]) -> Optional[Dict]:
        """分析事件对市场的影响（使用 LLM）"""
        logger.info("📊 分析事件影响...")
        
        if not markets:
            return None
        
        top_market = markets[0]['market']
        question = top_market.get('question', '')
        
        try:
            # 导入 LLM 分析器
            import sys
            sys.path.insert(0, '/home/node/.openclaw/workspace/scripts')
            from llm_analyzer import LLMAnalyzer
            
            # 初始化分析器
            analyzer = LLMAnalyzer()
            
            # 调用 LLM 分析
            result = analyzer.analyze_impact(event, top_market)
            
            if result and result.get('impact'):
                logger.info(f"   ✅ LLM 分析完成: {result['direction']} @ {result['confidence']:.2%}")
                return {
                    "market": top_market,
                    "direction": result['direction'],
                    "confidence": result['confidence'],
                    "reasoning": result.get('reasoning', 'LLM analysis')
                }
            else:
                logger.info("   ℹ️  LLM 分析：无明显影响")
                return None
                
        except Exception as e:
            logger.warning(f"⚠️  LLM 分析失败: {e}，使用简单规则")
            # 回退到简单规则
            if "Iran" in event.get('text', '') and "Hormuz" in question:
                return {
                    "market": top_market,
                    "direction": "YES",
                    "confidence": 0.75,
                    "reasoning": "Iran naval activity increases probability of Hormuz closure"
                }
            
            return None
    
    def calculate_dynamic_position(self, confidence: float) -> float:
        """根据置信度计算动态仓位"""
        logger.info(f"📊 计算动态仓位：置信度 {confidence:.2%}")
        
        # 基础金额：5 USDC（最小交易量）
        base_amount = 5.0
        
        # 置信度阈值
        if confidence < 0.70:
            logger.info("   置信度过低，跳过交易")
            return 0.0
        elif confidence < 0.80:
            # 70-80%：基础金额
            amount = base_amount
        elif confidence < 0.90:
            # 80-90%：1.5 倍
            amount = base_amount * 1.5
        elif confidence < 0.95:
            # 90-95%：2 倍
            amount = base_amount * 2.0
        else:
            # 95%+：3 倍（最大）
            amount = base_amount * 3.0
        
        # 限制在风险管理范围内
        max_single = self.risk_manager.max_single_position if hasattr(self, 'risk_manager') else 15.0
        amount = min(amount, max_single)
        
        logger.info(f"   动态仓位：{amount:.2f} USDC")
        return amount
    
    def execute_snipe(self, action: Dict) -> Dict:
        """执行狙击（快速下单）"""
        logger.info("=" * 60)
        logger.info("⚡ 执行狙击")
        logger.info("=" * 60)
        
        market = action['market']
        direction = action['direction']
        confidence = action.get('confidence', 0.75)
        
        # 动态仓位计算
        amount = self.calculate_dynamic_position(confidence)
        
        if amount == 0:
            logger.info("   跳过交易（置信度过低）")
            return {"success": False, "error": "Confidence too low"}
        
        logger.info(f"   市场: {market.get('question', 'Unknown')[:50]}...")
        logger.info(f"   方向: {direction}")
        logger.info(f"   金额: {amount:.2f} USDC（动态仓位）")
        logger.info(f"   置信度: {confidence:.2%}")
        
        try:
            # 获取 token ID
            tokens = market.get('tokens', [])
            if not tokens:
                logger.error("❌ 无法获取 token ID")
                return {"success": False, "error": "No token ID"}
            
            token = tokens[0] if direction == "YES" else tokens[1]
            token_id = token.get('token_id')
            
            # 获取当前价格
            price = float(market.get('outcome_prices', [0.5])[0] if direction == "YES" else market.get('outcome_prices', [0.5, 0.5])[1])
            
            logger.info(f"   当前价格: {price:.2%}")
            
            # 实际下单
            from py_clob_client.clob_types import OrderArgs
            
            order_args = OrderArgs(
                token_id=token_id,
                side="BUY",
                price=price,
                size=amount
            )
            
            result = self.client.create_and_post_order(order_args)
            
            logger.info("✅ 狙击执行成功")
            logger.info(f"   订单ID: {result.get('orderID', 'N/A')[:20]}...")
            
            # 发送飞书通知
            self.send_feishu_notification({
                "market": market.get('question', 'Unknown'),
                "direction": direction,
                "amount": amount,
                "price": price,
                "order_id": result.get('orderID', 'N/A'),
                "confidence": action.get('confidence', 0)
            })
            
            return {
                "success": True,
                "market": market.get('question', 'Unknown'),
                "direction": direction,
                "amount": amount,
                "price": price,
                "order_id": result.get('orderID', 'N/A')
            }
            
        except Exception as e:
            logger.error(f"❌ 狙击失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return {"success": False, "error": str(e)}
    
    def send_feishu_notification(self, trade_info: Dict):
        """发送飞书通知"""
        try:
            import requests
            
            # 飞书 Webhook URL（需要配置）
            webhook_url = os.getenv('FEISHU_WEBHOOK_URL')
            
            if not webhook_url:
                logger.warning("⚠️  飞书 Webhook 未配置，跳过通知")
                return
            
            message = {
                "msg_type": "interactive",
                "card": {
                    "header": {
                        "title": {
                            "tag": "plain_text",
                            "content": "🎯 Polymarket 消息面狙击"
                        },
                        "template": "green" if trade_info['direction'] == "YES" else "red"
                    },
                    "elements": [
                        {
                            "tag": "div",
                            "text": {
                                "tag": "lark_md",
                                "content": f"**市场**: {trade_info['market'][:50]}\n**方向**: {trade_info['direction']}\n**金额**: {trade_info['amount']:.2f} USDC\n**价格**: {trade_info['price']:.2%}\n**置信度**: {trade_info['confidence']:.2%}\n**订单ID**: {trade_info['order_id'][:20]}..."
                            }
                        }
                    ]
                }
            }
            
            response = requests.post(webhook_url, json=message, timeout=5)
            
            if response.status_code == 200:
                logger.info("✅ 飞书通知已发送")
            else:
                logger.warning(f"⚠️  飞书通知失败: {response.status_code}")
                
        except Exception as e:
            logger.warning(f"⚠️  飞书通知失败: {e}")
    
    def run(self, interval: int = 60):
        """运行狙击系统"""
        logger.info("=" * 60)
        logger.info(f"🚀 启动消息面狙击系统（每 {interval} 秒扫描）")
        logger.info("=" * 60)
        
        while True:
            try:
                # 1. 监控 OSINT 源
                events = self.monitor_osint_sources()
                
                # 2. 对每个事件进行分析
                for event in events:
                    # 提取关键词
                    keywords = event.get('keywords', [])
                    
                    # 查找相关市场
                    markets = self.find_related_markets(keywords)
                    
                    # 分析影响
                    impact = self.analyze_impact(event, markets)
                    
                    # 执行狙击
                    if impact and impact.get('confidence', 0) > 0.7:
                        result = self.execute_snipe(impact)
                        
                        if result['success']:
                            logger.info(f"✅ 狙击成功: {result['market'][:30]}...")
                        else:
                            logger.error(f"❌ 狙击失败: {result.get('error')}")
                
                # 3. 等待下次扫描
                logger.info(f"⏰ 等待 {interval} 秒...")
                time.sleep(interval)
                
            except KeyboardInterrupt:
                logger.info("⏹️  停止狙击系统")
                break
            except Exception as e:
                logger.error(f"❌ 运行错误: {e}")
                time.sleep(10)


def run_once():
    """单次执行（适合 cron）"""
    try:
        sniper = PolymarketSniper()
        
        # 单次扫描
        events = sniper.monitor_osint_sources()
        
        results = {
            "events_scanned": len(events),
            "snipes_executed": 0,
            "snipes_failed": 0,
            "errors": []
        }
        
        for event in events:
            keywords = event.get('keywords', [])
            markets = sniper.find_related_markets(keywords)
            impact = sniper.analyze_impact(event, markets)
            
            if impact and impact.get('confidence', 0) > 0.7:
                result = sniper.execute_snipe(impact)
                if result['success']:
                    results['snipes_executed'] += 1
                else:
                    results['snipes_failed'] += 1
                    results['errors'].append(result.get('error', 'Unknown'))
        
        logger.info("=" * 60)
        logger.info("📊 执行总结")
        logger.info("=" * 60)
        logger.info(f"   扫描事件: {results['events_scanned']}")
        logger.info(f"   执行狙击: {results['snipes_executed']}")
        logger.info(f"   失败狙击: {results['snipes_failed']}")
        if results['errors']:
            logger.info(f"   错误: {results['errors'][:3]}")
        logger.info("=" * 60)
        
        return results
        
    except Exception as e:
        logger.error(f"❌ 单次执行失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return {"error": str(e)}

def main():
    """主函数"""
    import sys
    
    # 检查是否单次执行模式
    if len(sys.argv) > 1 and sys.argv[1] == '--once':
        run_once()
        return 0
    
    # 默认：持续运行模式
    try:
        sniper = PolymarketSniper()
        sniper.run(interval=60)
    except Exception as e:
        logger.error(f"❌ 系统启动失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
