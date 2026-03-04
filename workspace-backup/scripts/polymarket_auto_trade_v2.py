#!/usr/bin/env python3
"""
Polymarket 完全自动交易系统 - 完整版
流程：查询余额 → 清理持仓 → 扫描机会 → 执行交易
"""

import os
import sys
import json
import time
import logging
from datetime import datetime
from typing import List, Dict, Optional

# 设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, OrderArgs

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [AutoTrade] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_auto_trade.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('AutoTrade')

class PolymarketAutoTrader:
    """Polymarket 完全自动交易机器人"""
    
    def __init__(self, config_file: str = "config/polymarket.env"):
        """初始化"""
        self._load_credentials(config_file)
        self._init_client()
        
        # 风险管理参数
        self.max_single_position = 5.0  # 单个市场最大持仓（USDC），最小 5 USDC
        self.min_probability = 0.90     # 最小确定性（90%）
        self.max_positions = 3          # 最多持仓数量
        
        logger.info("✅ Polymarket 自动交易机器人已初始化")
    
    def _load_credentials(self, config_file: str):
        """加载凭证"""
        env_vars = {}
        if os.path.exists(config_file):
            with open(config_file, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        key, value = line.split('=', 1)
                        env_vars[key] = value
        
        self.api_key = env_vars.get('POLYMARKET_API_KEY')
        self.api_secret = env_vars.get('POLYMARKET_SECRET')
        self.api_passphrase = env_vars.get('POLYMARKET_PASSPHRASE')
        self.private_key = env_vars.get('POLYMARKET_PRIVATE_KEY')
        self.address = env_vars.get('POLYMARKET_ADDRESS')
        
        logger.info(f"钱包地址: {self.address[:20]}...")
    
    def _init_client(self):
        """初始化 CLOB 客户端"""
        try:
            # 创建客户端（使用 EOA 钱包）
            self.client = ClobClient(
                "https://clob.polymarket.com",
                key=self.private_key,
                chain_id=137,  # Polygon
                signature_type=0  # EOA 签名
            )
            
            # 设置 API 凭证
            creds = ApiCreds(
                api_key=self.api_key,
                api_secret=self.api_secret,
                api_passphrase=self.api_passphrase
            )
            self.client.set_api_creds(creds)
            
            logger.info("✅ CLOB 客户端已初始化")
            
        except Exception as e:
            logger.error(f"❌ 初始化客户端失败: {e}")
            raise
    
    def get_balances(self) -> Dict:
        """查询余额"""
        try:
            balances = self.client.get_balances()
            logger.info(f"💰 账户余额: {balances}")
            return balances
        except Exception as e:
            logger.error(f"❌ 查询余额失败: {e}")
            return {}
    
    def get_current_positions(self) -> List[Dict]:
        """获取当前持仓"""
        logger.info("📊 查询当前持仓...")
        
        positions = []
        
        try:
            # 获取订单
            orders = self.client.get_orders()
            
            for order in orders:
                if order.get('status') == 'LIVE':
                    positions.append({
                        'order_id': order.get('id'),
                        'market': order.get('asset', {}).get('question', 'Unknown'),
                        'side': order.get('side'),
                        'price': float(order.get('original_price', 0)),
                        'size': float(order.get('original_size', 0)),
                        'status': order.get('status')
                    })
            
            logger.info(f"当前持仓: {len(positions)} 个")
            
        except Exception as e:
            logger.error(f"❌ 查询持仓失败: {e}")
        
        return positions
    
    def scan_opportunities(self) -> List[Dict]:
        """扫描交易机会"""
        logger.info("📊 扫描市场机会...")
        
        opportunities = []
        
        try:
            # 获取活跃市场
            markets = self.client.get_sampling_markets()
            
            if isinstance(markets, dict):
                markets = markets.get('data', [])
            
            logger.info(f"找到 {len(markets)} 个市场")
            
            for market in markets:
                # 跳过已关闭或归档的市场
                if market.get('closed', False) or market.get('archived', False):
                    continue
                
                # 跳过不接受订单的市场
                if not market.get('accepting_orders', False):
                    continue
                
                tokens = market.get('tokens', [])
                if len(tokens) < 2:
                    continue
                
                # 获取价格
                yes_price = float(tokens[0].get('price', 0.5))
                no_price = float(tokens[1].get('price', 0.5))
                
                # 跳过已确定的市场
                if yes_price in [0.0, 1.0] or no_price in [0.0, 1.0]:
                    continue
                
                question = market.get('question', 'Unknown')
                condition_id = market.get('condition_id')
                
                # 寻找高确定性机会
                if yes_price >= self.min_probability:
                    reward_ratio = (1.0 / yes_price) - 1.0
                    opportunities.append({
                        'question': question,
                        'side': 'YES',
                        'price': yes_price,
                        'token_id': tokens[0].get('token_id'),
                        'condition_id': condition_id,
                        'reward_ratio': reward_ratio
                    })
                elif no_price >= self.min_probability:
                    reward_ratio = (1.0 / no_price) - 1.0
                    opportunities.append({
                        'question': question,
                        'side': 'NO',
                        'price': no_price,
                        'token_id': tokens[1].get('token_id'),
                        'condition_id': condition_id,
                        'reward_ratio': reward_ratio
                    })
            
            # 按收益率排序
            opportunities.sort(key=lambda x: x['reward_ratio'], reverse=True)
            
            logger.info(f"🎯 发现 {len(opportunities)} 个交易机会")
            
        except Exception as e:
            logger.error(f"❌ 扫描市场失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
        
        return opportunities
    
    def execute_trade(self, opportunity: Dict, amount: float) -> bool:
        """执行交易"""
        logger.info("=" * 60)
        logger.info(f"💱 执行交易")
        logger.info("=" * 60)
        logger.info(f"市场: {opportunity['question'][:60]}")
        logger.info(f"方向: {opportunity['side']} @ {opportunity['price']:.2%}")
        logger.info(f"金额: {amount:.2f} USDC")
        logger.info(f"预期收益: {opportunity['reward_ratio']:.2%}")
        
        try:
            # 创建订单
            order_args = OrderArgs(
                token_id=opportunity['token_id'],
                side="BUY",
                price=opportunity['price'],
                size=amount
            )
            
            # 发送订单
            logger.info("📤 发送订单...")
            order = self.client.create_and_post_order(order_args)
            
            logger.info("✅ 交易成功")
            logger.info(f"订单ID: {order.get('orderID', 'N/A')}")
            
            return True
            
        except Exception as e:
            error_msg = str(e)
            if 'not enough balance' in error_msg:
                logger.error(f"❌ 余额不足")
            elif 'min size' in error_msg:
                logger.error(f"❌ 订单金额太小，最小 5 USDC")
            else:
                logger.error(f"❌ 交易失败: {e}")
            return False
    
    def send_notification(self, message: str):
        """发送通知"""
        notification = {
            'timestamp': datetime.now().isoformat(),
            'message': message
        }
        
        with open('/tmp/polymarket_notification.json', 'w') as f:
            json.dump(notification, f, indent=2)
        
        logger.info("📢 通知已保存")
    
    def run(self):
        """运行自动交易机器人"""
        logger.info("=" * 60)
        logger.info("🚀 启动自动交易机器人")
        logger.info("=" * 60)
        
        # 1. 查询余额
        balances = self.get_balances()
        if not balances:
            logger.warning("⚠️ 无法获取余额信息")
        
        # 2. 获取当前持仓
        current_positions = self.get_current_positions()
        
        if len(current_positions) >= self.max_positions:
            logger.info("💰 已达到最大持仓数，跳过新开仓")
            logger.info(f"当前持仓: {len(current_positions)} / {self.max_positions}")
            return
        
        # 3. 扫描市场
        opportunities = self.scan_opportunities()
        
        if not opportunities:
            logger.warning("⚠️  未发现符合条件的交易机会")
            self.send_notification("⚠️ 未发现符合条件的交易机会")
            return
        
        # 显示前 3 个机会
        logger.info("")
        logger.info("前 3 个最佳机会:")
        for i, opp in enumerate(opportunities[:3]):
            logger.info(f"#{i+1}: {opp['side']} @ {opp['price']:.2%} | {opp['question'][:50]}")
        
        # 4. 执行交易
        logger.info("")
        logger.info("=" * 60)
        logger.info("💰 开始执行交易")
        logger.info("=" * 60)
        
        executed_count = 0
        
        for opp in opportunities:
            # 检查是否已达到最大持仓数
            if len(current_positions) + executed_count >= self.max_positions:
                logger.info("已达到最大持仓数，停止交易")
                break
            
            # 执行交易
            if self.execute_trade(opp, amount=self.max_single_position):
                executed_count += 1
                time.sleep(2)  # 避免频率限制
                
                # 成功后立即退出（因为余额会减少）
                logger.info("✅ 成功执行 1 笔交易，等待下次运行")
                break
        
        # 5. 发送通知
        if executed_count > 0:
            message = f"✅ 成功执行 {executed_count} 笔交易\n"
            message += f"总投资: {executed_count * self.max_single_position:.2f} USDC"
            self.send_notification(message)
        
        logger.info("")
        logger.info("=" * 60)
        logger.info(f"✅ 自动交易完成，执行 {executed_count} 笔")
        logger.info("=" * 60)

def main():
    """主函数"""
    try:
        trader = PolymarketAutoTrader()
        trader.run()
    except Exception as e:
        logger.error(f"❌ 自动交易失败: {e}")
        import traceback
        logger.error(traceback.format_exc())

if __name__ == "__main__":
    main()
