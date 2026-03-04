#!/usr/bin/env python3
"""
Polymarket 自动交易系统 v3
使用 Gamma API 获取活跃市场
"""

import os
import sys
import json
import time
import requests
from datetime import datetime
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import MarketOrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

# 配置
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
CHAIN_ID = 137

# 代理设置（Gamma API 可能不需要代理）
PROXIES = {}  # 先不使用代理试试

# 交易参数
MIN_LIQUIDITY = 100  # 最小流动性（USDC）
MIN_PROBABILITY = 0.90  # 最小概率（90%）
TRADE_AMOUNT = 5.0  # 每笔交易金额（USDC）
MAX_POSITIONS = 3  # 最大持仓数

class PolymarketAutoTrader:
    def __init__(self):
        self.client = None
        self.gamma_session = requests.Session()
        self.gamma_session.proxies.update(PROXIES)
        
        # 加载凭证
        self.load_credentials()
        
    def load_credentials(self):
        """加载 API 凭证"""
        env_path = os.path.expanduser("~/.openclaw/workspace/config/polymarket.env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.strip() and not line.startswith('#'):
                        key, value = line.strip().split('=', 1)
                        os.environ[key] = value
        
        self.api_key = os.getenv('POLYMARKET_API_KEY')
        self.secret = os.getenv('POLYMARKET_SECRET')
        self.passphrase = os.getenv('POLYMARKET_PASSPHRASE')
        self.private_key = os.getenv('POLYMARKET_PRIVATE_KEY')
        
        if not all([self.api_key, self.secret, self.passphrase, self.private_key]):
            print("❌ 缺少 API 凭证")
            sys.exit(1)
    
    def init_client(self):
        """初始化 CLOB 客户端"""
        try:
            self.client = ClobClient(
                CLOB_API,
                key=self.private_key,
                chain_id=CHAIN_ID,
                signature_type=0,  # EOA
            )
            self.client.set_api_creds({
                'api_key': self.api_key,
                'secret': self.secret,
                'passphrase': self.passphrase
            })
            print("✅ CLOB 客户端初始化成功")
        except Exception as e:
            print(f"❌ CLOB 客户端初始化失败: {e}")
            sys.exit(1)
    
    def get_active_markets(self, limit=100):
        """获取活跃市场（Gamma API）"""
        try:
            # 使用 curl 绕过 SSL 问题
            import subprocess
            cmd = [
                'curl', '-s',
                f"{GAMMA_API}/markets",
                '-H', 'Accept: application/json',
                '-G',
                '-d', 'active=true',
                '-d', 'closed=false',
                '-d', f'limit={limit}'
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            
            if result.returncode != 0:
                print(f"❌ curl 失败: {result.stderr}")
                return []
            
            markets = json.loads(result.stdout)
            
            # 过滤可交易市场
            tradeable = [
                m for m in markets
                if m.get('acceptingOrders', False)
                and m.get('enableOrderBook', False)
                and float(m.get('liquidity', 0)) >= MIN_LIQUIDITY
            ]
            
            print(f"📊 获取活跃市场: {len(markets)} 个")
            print(f"✅ 可交易市场: {len(tradeable)} 个")
            
            return tradeable
        except Exception as e:
            print(f"❌ 获取市场失败: {e}")
            return []
    
    def analyze_market(self, market):
        """分析市场，寻找交易机会"""
        try:
            token_ids = json.loads(market['clobTokenIds'])
            outcome_prices = json.loads(market['outcomePrices'])
            
            # YES token
            yes_token_id = token_ids[0]
            yes_price = float(outcome_prices[0])
            
            # 获取实时价格
            try:
                mid_price = self.client.get_midpoint(yes_token_id)
                if mid_price and 0 < mid_price < 1:
                    yes_price = mid_price
            except:
                pass
            
            # 交易机会判断
            if yes_price >= MIN_PROBABILITY:
                return {
                    'token_id': yes_token_id,
                    'side': BUY,
                    'probability': yes_price,
                    'market': market['question'],
                    'end_date': market['endDate'],
                    'volume': float(market['volume']),
                    'liquidity': float(market['liquidity'])
                }
            
            # NO token
            no_token_id = token_ids[1]
            no_price = float(outcome_prices[1])
            
            try:
                mid_price = self.client.get_midpoint(no_token_id)
                if mid_price and 0 < mid_price < 1:
                    no_price = mid_price
            except:
                pass
            
            if no_price >= MIN_PROBABILITY:
                return {
                    'token_id': no_token_id,
                    'side': BUY,
                    'probability': no_price,
                    'market': market['question'],
                    'end_date': market['endDate'],
                    'volume': float(market['volume']),
                    'liquidity': float(market['liquidity'])
                }
            
            return None
        except Exception as e:
            print(f"⚠️ 分析市场失败 {market['question']}: {e}")
            return None
    
    def execute_trade(self, opportunity):
        """执行交易"""
        try:
            print(f"\n💰 执行交易:")
            print(f"   市场: {opportunity['market']}")
            print(f"   概率: {opportunity['probability']:.2%}")
            print(f"   金额: ${TRADE_AMOUNT}")
            
            # 创建市场订单（使用 GTC 而不是 FOK）
            order_args = MarketOrderArgs(
                token_id=opportunity['token_id'],
                amount=TRADE_AMOUNT,
                side=opportunity['side'],
                order_type=OrderType.GTC  # Good Till Cancelled
            )
            
            signed_order = self.client.create_market_order(order_args)
            response = self.client.post_order(signed_order, OrderType.GTC)
            
            print(f"✅ 交易成功!")
            print(f"   订单 ID: {response.get('orderID', 'N/A')}")
            
            return response
        except Exception as e:
            print(f"❌ 交易失败: {e}")
            return None
    
    def run(self):
        """主流程"""
        print(f"\n{'='*60}")
        print(f"Polymarket 自动交易系统 v3")
        print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*60}")
        
        # 初始化
        self.init_client()
        
        # 获取活跃市场
        markets = self.get_active_markets(limit=100)
        
        if not markets:
            print("⚠️ 没有找到可交易市场")
            return
        
        # 分析市场
        print(f"\n🔍 分析市场...")
        opportunities = []
        for market in markets:
            opp = self.analyze_market(market)
            if opp:
                opportunities.append(opp)
                print(f"✅ 发现机会: {opp['market']} (概率: {opp['probability']:.2%})")
        
        if not opportunities:
            print("⚠️ 没有找到符合条件的交易机会")
            return
        
        # 按概率排序
        opportunities.sort(key=lambda x: x['probability'], reverse=True)
        
        # 执行交易
        print(f"\n💰 执行交易（最多 {MAX_POSITIONS} 笔）...")
        for i, opp in enumerate(opportunities[:MAX_POSITIONS]):
            print(f"\n[{i+1}/{min(len(opportunities), MAX_POSITIONS)}]")
            self.execute_trade(opp)
            time.sleep(2)  # 避免频率限制
        
        print(f"\n{'='*60}")
        print(f"✅ 交易完成")
        print(f"{'='*60}\n")

if __name__ == "__main__":
    trader = PolymarketAutoTrader()
    trader.run()
