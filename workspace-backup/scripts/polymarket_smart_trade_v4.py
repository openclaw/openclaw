#!/usr/bin/env python3
"""
Polymarket 智能订单管理 + 自动交易系统 v4
支持资金不足时的订单优先级管理
"""

import os
import sys
import json
import time
import subprocess
from datetime import datetime
from web3 import Web3
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import MarketOrderArgs, OrderType, OpenOrderParams, ApiCreds
from py_clob_client.order_builder.constants import BUY

# 配置
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"
POLYGON_RPC = "https://polygon-rpc.com"
USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
CHAIN_ID = 137

# 交易参数
MIN_LIQUIDITY = 100
MIN_PROBABILITY = 0.90
TRADE_AMOUNT = 5.0
MAX_POSITIONS = 3
MIN_BALANCE = 1.0  # 最小保留余额

class PolymarketSmartTrader:
    def __init__(self):
        self.client = None
        self.w3 = None
        self.address = None
        
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
        """初始化客户端"""
        try:
            # Web3 初始化（查询链上余额）
            self.w3 = Web3(Web3.HTTPProvider(POLYGON_RPC))
            
            # 从私钥获取地址
            account = self.w3.eth.account.from_key(self.private_key)
            self.address = account.address
            
            # CLOB 客户端
            creds = ApiCreds(
                api_key=self.api_key,
                api_secret=self.secret,
                api_passphrase=self.passphrase
            )
            
            self.client = ClobClient(
                host=CLOB_API,
                key=self.private_key,
                chain_id=CHAIN_ID,
                creds=creds
            )
            
            print(f"✅ 客户端初始化成功")
            print(f"   地址: {self.address}")
        except Exception as e:
            print(f"❌ 客户端初始化失败: {e}")
            sys.exit(1)
    
    def get_usdc_balance(self):
        """获取 USDC 链上余额"""
        try:
            # 使用公开的 Polygon RPC（多个备选）
            rpc_urls = [
                "https://polygon-mainnet.public.blastapi.io",
                "https://polygon-bor.publicnode.com",
                "https://1rpc.io/matic",
            ]
            
            for rpc_url in rpc_urls:
                try:
                    w3 = Web3(Web3.HTTPProvider(rpc_url))
                    
                    # ERC20 ABI（只包含 balanceOf）
                    abi = [{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]
                    
                    contract = w3.eth.contract(
                        address=Web3.to_checksum_address(USDC_ADDRESS),
                        abi=abi
                    )
                    
                    balance_wei = contract.functions.balanceOf(self.address).call()
                    balance = balance_wei / 1e6  # USDC 有 6 位小数
                    
                    return balance
                except:
                    continue
            
            # 所有 RPC 都失败
            print(f"⚠️ 所有 RPC 查询失败")
            return 0.0
        except Exception as e:
            print(f"⚠️ 查询余额失败: {e}")
            return 0.0
    
    def get_open_orders(self):
        """获取未成交订单（冻结资金的订单）"""
        try:
            orders = self.client.get_orders(OpenOrderParams())
            return orders if orders else []
        except Exception as e:
            print(f"⚠️ 获取订单失败: {e}")
            return []
    
    def get_positions(self):
        """获取已成交交易（持仓）"""
        try:
            trades = self.client.get_trades()
            return trades if trades else []
        except Exception as e:
            print(f"⚠️ 获取持仓失败: {e}")
            return []
    
    def calculate_order_priority(self, order, market_info):
        """计算订单优先级分数（0-100）"""
        try:
            score = 0
            
            # 1. 盈利概率（40%）
            prob = float(market_info.get('outcomePrices', '[0.5, 0.5]').split(',')[0].strip('[]"'))
            if prob >= 0.98:
                score += 40
            elif prob >= 0.95:
                score += 30
            elif prob >= 0.90:
                score += 20
            
            # 2. 流动性（20%）
            liquidity = float(market_info.get('liquidity', 0))
            if liquidity >= 500:
                score += 20
            elif liquidity >= 100:
                score += 10
            else:
                score += 5
            
            # 3. 剩余时间（20%）
            end_date = datetime.fromisoformat(market_info['endDate'].replace('Z', '+00:00'))
            days_left = (end_date - datetime.now(end_date.tzinfo)).days
            
            if days_left <= 7:
                score += 20
            elif days_left <= 30:
                score += 10
            else:
                score += 5
            
            # 4. 价格优势（20%）
            order_price = float(order.get('price', 0.5))
            mid_price = prob  # 简化处理
            
            price_diff = abs(order_price - mid_price)
            if price_diff <= 0.02:
                score += 20
            elif price_diff <= 0.05:
                score += 10
            else:
                score += 5
            
            return score
        except Exception as e:
            print(f"⚠️ 计算优先级失败: {e}")
            return 50  # 默认中等等级
    
    def cancel_order(self, order_id):
        """取消订单"""
        try:
            print(f"   🗑️ 取消订单: {order_id[:20]}...")
            result = self.client.cancel(order_id)
            print(f"   ✅ 取消成功")
            return True
        except Exception as e:
            print(f"   ❌ 取消失败: {e}")
            return False
    
    def manage_orders_for_funds(self, required_amount):
        """管理订单以释放资金"""
        print(f"\n💼 资金管理:")
        
        # 1. 检查当前余额
        balance = self.get_usdc_balance()
        print(f"   当前余额: ${balance:.2f} USDC")
        
        # 2. 获取持仓（已成交交易）
        positions = self.get_positions()
        print(f"   持仓数量: {len(positions)} 个")
        
        if positions:
            total_invested = sum(float(p['size']) * float(p['price']) for p in positions)
            print(f"   持仓投入: ${total_invested:.2f} USDC")
        
        # 3. 获取未成交订单（冻结资金）
        orders = self.get_open_orders()
        print(f"   未成交订单: {len(orders)} 个")
        
        if balance >= required_amount:
            print(f"   ✅ 余额充足，无需取消订单")
            return True
        
        if not orders:
            print(f"   ⚠️ 没有未成交订单可取消")
            print(f"   💡 需要充值 ${required_amount - balance:.2f} USDC")
            return False
        
        # 4. 计算订单优先级
        print(f"\n   📊 订单优先级分析:")
        order_scores = []
        
        for order in orders:
            # 获取市场信息（简化处理）
            score = 50  # 默认分数
            frozen_amount = float(order.get('original_size', 0)) * float(order.get('price', 0))
            
            order_scores.append({
                'order': order,
                'score': score,
                'frozen': frozen_amount
            })
            
            print(f"   - 订单 {order.get('id', 'N/A')[:15]}...")
            print(f"     分数: {score}, 冻结: ${frozen_amount:.2f}")
        
        # 5. 取消低优先级订单
        # 按分数排序（从低到高）
        order_scores.sort(key=lambda x: x['score'])
        
        released = 0.0
        for item in order_scores:
            if balance + released >= required_amount:
                break
            
            if item['score'] < 70:  # 低优先级
                if self.cancel_order(item['order']['id']):
                    released += item['frozen']
                    time.sleep(1)  # 避免频率限制
        
        print(f"\n   💰 释放资金: ${released:.2f} USDC")
        print(f"   📊 可用资金: ${balance + released:.2f} USDC")
        
        return (balance + released) >= required_amount
    
    def get_active_markets(self, limit=100):
        """获取活跃市场（使用 curl 绕过 SSL）"""
        try:
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
            return None
    
    def execute_trade(self, opportunity):
        """执行交易"""
        try:
            print(f"\n💰 执行交易:")
            print(f"   市场: {opportunity['market']}")
            print(f"   概率: {opportunity['probability']:.2%}")
            print(f"   金额: ${TRADE_AMOUNT}")
            
            # 创建市场订单
            order_args = MarketOrderArgs(
                token_id=opportunity['token_id'],
                amount=TRADE_AMOUNT,
                side=opportunity['side'],
                order_type=OrderType.GTC
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
        print(f"Polymarket 智能交易系统 v4")
        print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"{'='*60}")
        
        # 初始化
        self.init_client()
        
        # 检查余额并管理订单
        has_funds = self.manage_orders_for_funds(TRADE_AMOUNT + MIN_BALANCE)
        
        if not has_funds:
            print(f"\n⚠️ 资金不足，无法开新订单")
            print(f"💡 请充值至少 ${TRADE_AMOUNT + MIN_BALANCE:.2f} USDC")
            return
        
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
            time.sleep(2)
        
        print(f"\n{'='*60}")
        print(f"✅ 交易完成")
        print(f"{'='*60}\n")

if __name__ == "__main__":
    trader = PolymarketSmartTrader()
    trader.run()
