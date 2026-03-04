#!/usr/bin/env python3
"""
Polymarket 账户管理工具
功能：查看余额、订单状态、交易历史、撤销订单
"""

import os
import sys
import json
import logging
from datetime import datetime
from typing import Dict, List

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 必须在导入任何库之前设置代理
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
    format='%(asctime)s - [Manager] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_manager.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketManager')


class PolymarketAccountManager:
    """Polymarket 账户管理器"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🏦 初始化 Polymarket 账户管理器")
        logger.info("=" * 60)
        
        # 加载凭证
        load_dotenv('/home/node/.openclaw/workspace/config/polymarket.env')
        
        self.api_key = os.getenv('POLYMARKET_API_KEY')
        self.api_secret = os.getenv('POLYMARKET_SECRET')
        self.passphrase = os.getenv('POLYMARKET_PASSPHRASE')
        self.address = os.getenv('POLYMARKET_ADDRESS')
        self.private_key = os.getenv('POLYMARKET_PRIVATE_KEY')
        
        if not all([self.api_key, self.api_secret, self.passphrase, self.private_key]):
            raise ValueError("❌ 缺少 API 凭证或私钥")
        
        logger.info(f"   地址: {self.address}")
        
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
            signature_type=1,  # POLY_PROXY
            funder=self.address
        )
        
        logger.info("✅ 初始化完成")
    
    def get_balances(self):
        """查看余额（需要通过区块链查询）"""
        logger.info("")
        logger.info("=" * 60)
        logger.info("💰 查看账户余额")
        logger.info("=" * 60)
        
        logger.info("")
        logger.info(f"地址: {self.address}")
        logger.info("")
        logger.info("⚠️  注意：余额查询需要通过区块链浏览器")
        logger.info("   Polygon 链上 USDC 余额：")
        logger.info(f"   https://polygonscan.com/address/{self.address}")
        logger.info("")
        logger.info("   或者使用 MetaMask 查看余额")
        
        return None
    
    def get_orders(self):
        """查看订单状态"""
        logger.info("")
        logger.info("=" * 60)
        logger.info(f"📋 查看活跃订单")
        logger.info("=" * 60)
        
        try:
            # 获取订单（不传参数）
            orders = self.client.get_orders()
            
            logger.info("")
            
            if orders:
                logger.info(f"找到 {len(orders)} 个订单:")
                logger.info("")
                
                for i, order in enumerate(orders, 1):
                    order_id = order.get('id', 'Unknown')
                    market = order.get('market', 'Unknown')
                    side = order.get('side', 'Unknown')
                    price = float(order.get('original_price', 0))
                    size = float(order.get('original_size', 0))
                    created_at = order.get('created_at', '')
                    
                    logger.info(f"订单 #{i}")
                    logger.info(f"   ID: {order_id[:20]}...")
                    logger.info(f"   市场: {market[:50]}...")
                    logger.info(f"   方向: {side} @ {price:.2%}")
                    logger.info(f"   数量: {size:.2f} USDC")
                    logger.info(f"   创建时间: {created_at}")
                    logger.info("")
            else:
                logger.warning("⚠️  未找到订单")
            
            return orders
            
        except Exception as e:
            logger.error(f"❌ 查看订单失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    def get_trades(self):
        """获取交易历史"""
        logger.info("")
        logger.info("=" * 60)
        logger.info("📜 获取交易历史")
        logger.info("=" * 60)
        
        try:
            # 获取交易历史
            trades = self.client.get_trades()
            
            logger.info("")
            
            if trades:
                logger.info(f"找到 {len(trades)} 笔交易:")
                logger.info("")
                
                for i, trade in enumerate(trades, 1):
                    trade_id = trade.get('id', 'Unknown')
                    market = trade.get('market', 'Unknown')
                    side = trade.get('side', 'Unknown')
                    price = float(trade.get('price', 0))
                    size = float(trade.get('size', 0))
                    timestamp = trade.get('timestamp', '')
                    
                    logger.info(f"交易 #{i}")
                    logger.info(f"   ID: {trade_id[:20]}...")
                    logger.info(f"   市场: {market[:50]}...")
                    logger.info(f"   方向: {side} @ {price:.2%}")
                    logger.info(f"   数量: {size:.2f} USDC")
                    logger.info(f"   时间: {timestamp}")
                    logger.info("")
            else:
                logger.warning("⚠️  未找到交易记录")
            
            return trades
            
        except Exception as e:
            logger.error(f"❌ 获取交易历史失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    def cancel_order(self, order_id: str):
        """撤销订单"""
        logger.info("")
        logger.info("=" * 60)
        logger.info("❌ 撤销订单")
        logger.info("=" * 60)
        logger.info(f"   订单ID: {order_id}")
        
        try:
            # 撤销订单
            result = self.client.cancel(order_id)
            
            logger.info("✅ 订单已撤销")
            logger.info(f"   结果: {result}")
            
            return result
            
        except Exception as e:
            logger.error(f"❌ 撤销订单失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    def cancel_all_orders(self):
        """撤销所有订单"""
        logger.info("")
        logger.info("=" * 60)
        logger.info("❌ 撤销所有订单")
        logger.info("=" * 60)
        
        try:
            # 撤销所有订单
            result = self.client.cancel_all()
            
            logger.info("✅ 所有订单已撤销")
            logger.info(f"   结果: {result}")
            
            return result
            
        except Exception as e:
            logger.error(f"❌ 撤销所有订单失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return None
    
    def run(self, action: str = 'all'):
        """运行管理器"""
        logger.info("=" * 60)
        logger.info(f"🚀 启动账户管理器（{action}）")
        logger.info("=" * 60)
        
        if action == 'all':
            # 执行所有功能
            self.get_balances()
            self.get_orders()
            self.get_trades()
        elif action == 'balance':
            self.get_balances()
        elif action == 'orders':
            self.get_orders()
        elif action == 'trades':
            self.get_trades()
        else:
            logger.error(f"❌ 未知操作: {action}")


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Polymarket 账户管理工具')
    parser.add_argument('--action', '-a', default='all',
                        choices=['all', 'balance', 'orders', 'trades'],
                        help='执行的操作（默认: all）')
    
    args = parser.parse_args()
    
    try:
        manager = PolymarketAccountManager()
        manager.run(args.action)
    except Exception as e:
        logger.error(f"❌ 管理器运行失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
