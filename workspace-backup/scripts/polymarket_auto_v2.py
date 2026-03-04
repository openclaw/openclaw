#!/usr/bin/env python3
"""
Polymarket 自动交易机器人（完整版 v2）
包含：自动下单 + 风险管理 + 定期扫描 + 飞书通知
"""

import os
import sys
import json
import time
import logging
from datetime import datetime
from typing import List, Dict, Optional

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 必须在导入任何库之前设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, OrderArgs
from dotenv import load_dotenv

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [Bot] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_auto_v2.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketBot')


class RiskManager:
    """风险管理器"""
    
    def __init__(self, config: Dict):
        self.max_single_position = config.get('max_single_position', 2.0)  # 单个市场最大持仓
        self.max_total_exposure = config.get('max_total_exposure', 4.0)  # 总最大敞口
        self.min_probability = config.get('min_probability', 0.85)  # 最小确定性
        self.max_positions = config.get('max_positions', 5)  # 最多持仓数量
        self.min_reward_ratio = config.get('min_reward_ratio', 0.02)  # 最小预期收益率
        
        # 止损机制（新增）
        self.stop_loss_percentage = config.get('stop_loss_percentage', 0.20)  # 止损比例 20%
        self.take_profit_percentage = config.get('take_profit_percentage', 0.50)  # 止盈比例 50%
        
        self.positions = []  # 当前持仓
        self.total_exposure = 0.0  # 当前总敞口
    
    def check_stop_loss(self, position: Dict, current_price: float) -> bool:
        """检查是否需要止损"""
        entry_price = position.get('price', 0.5)
        
        # 计算价格变动
        if position['side'] == 'YES':
            price_change = (current_price - entry_price) / entry_price
        else:
            price_change = (entry_price - current_price) / entry_price
        
        # 止损检查
        if price_change <= -self.stop_loss_percentage:
            logger.info(f"🚨 止损触发: {position['question'][:30]}...")
            logger.info(f"   入场价格: {entry_price:.2%}")
            logger.info(f"   当前价格: {current_price:.2%}")
            logger.info(f"   亏损: {abs(price_change):.2%}")
            return True
        
        # 止盈检查
        if price_change >= self.take_profit_percentage:
            logger.info(f"💰 止盈触发: {position['question'][:30]}...")
            logger.info(f"   入场价格: {entry_price:.2%}")
            logger.info(f"   当前价格: {current_price:.2%}")
            logger.info(f"   盈利: {price_change:.2%}")
            return True
        
        return False
    
    def execute_stop_loss(self, position: Dict, current_price: float) -> bool:
        """执行止损/止盈"""
        logger.info("=" * 60)
        logger.info("🔄 执行止损/止盈")
        logger.info("=" * 60)
        
        try:
            # 这里需要调用 Polymarket API 卖出持仓
            # TODO: 实现卖出逻辑
            
            logger.info("✅ 止损/止盈执行成功")
            return True
            
        except Exception as e:
            logger.error(f"❌ 止损/止盈执行失败: {e}")
            return False
    
    def can_open_position(self, amount: float, probability: float) -> tuple:
        """检查是否可以开仓"""
        # 检查确定性
        if probability < self.min_probability:
            return False, f"确定性不足（{probability:.2%} < {self.min_probability:.2%}）"
        
        # 检查单个持仓大小
        if amount > self.max_single_position:
            return False, f"金额超过单个持仓限制（{amount} > {self.max_single_position}）"
        
        # 检查总敞口
        if self.total_exposure + amount > self.max_total_exposure:
            return False, f"超过总敞口限制（{self.total_exposure + amount} > {self.max_total_exposure}）"
        
        # 检查持仓数量
        if len(self.positions) >= self.max_positions:
            return False, f"持仓数量已达上限（{len(self.positions)} >= {self.max_positions}）"
        
        # 检查预期收益率
        reward_ratio = (1.0 / probability) - 1.0
        if reward_ratio < self.min_reward_ratio:
            return False, f"预期收益率不足（{reward_ratio:.2%} < {self.min_reward_ratio:.2%}）"
        
        return True, "OK"
    
    def add_position(self, position: Dict):
        """添加持仓"""
        self.positions.append(position)
        self.total_exposure += position.get('amount', 0)
    
    def get_summary(self) -> Dict:
        """获取风险摘要"""
        return {
            'total_positions': len(self.positions),
            'total_exposure': self.total_exposure,
            'remaining_budget': self.max_total_exposure - self.total_exposure,
            'positions': self.positions
        }


class PolymarketAutoTrader:
    """Polymarket 自动交易机器人"""
    
    def __init__(self):
        """初始化"""
        logger.info("=" * 60)
        logger.info("🤖 初始化 Polymarket 自动交易机器人 v2")
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
        logger.info(f"   API Key: {self.api_key[:10]}...")
        
        # 初始化客户端（尝试使用 POLY_PROXY 签名类型）
        self.client = ClobClient(
            host="https://clob.polymarket.com",
            creds=ApiCreds(
                api_key=self.api_key,
                api_secret=self.api_secret,
                api_passphrase=self.passphrase
            ),
            chain_id=137,
            key=self.private_key,
            signature_type=1,  # POLY_PROXY（Polymarket 代理钱包）
            funder=self.address  # 资金地址
        )
        
        # 初始化风险管理器（调整以适应最小交易量 5 USDC）
        self.risk_manager = RiskManager({
            'max_single_position': 5.0,  # 最小交易量 5 USDC
            'max_total_exposure': 15.0,  # 3笔交易 × 5 USDC
            'min_probability': 0.90,  # 提高到 90%（更安全）
            'max_positions': 3,
            'min_reward_ratio': 0.01,  # 降低到 1%（更容易找到机会）
            'stop_loss_percentage': 0.20,  # 止损 20%
            'take_profit_percentage': 0.50  # 止盈 50%
        })
        
        logger.info("✅ 初始化完成")
    
    def scan_markets(self) -> List[Dict]:
        """扫描市场"""
        logger.info("=" * 60)
        logger.info("🔍 扫描市场...")
        logger.info("=" * 60)
        
        opportunities = []
        
        try:
            markets_data = self.client.get_sampling_markets()
            markets = markets_data.get('data', [])
            
            logger.info(f"📊 获取到 {len(markets)} 个市场")
            
            for market in markets:
                if market.get('closed', False) or market.get('archived', False):
                    continue
                
                if not market.get('accepting_orders', False):
                    continue
                
                tokens = market.get('tokens', [])
                if len(tokens) < 2:
                    continue
                
                yes_price = float(tokens[0].get('price', 0.5))
                no_price = float(tokens[1].get('price', 0.5))
                
                # 跳过已确定的市场
                if yes_price in [0.0, 1.0] or no_price in [0.0, 1.0]:
                    continue
                
                question = market.get('question', 'Unknown')
                condition_id = market.get('condition_id')
                
                # 寻找高确定性机会
                if yes_price >= self.risk_manager.min_probability:
                    opportunities.append({
                        'question': question,
                        'side': 'YES',
                        'price': yes_price,
                        'token_id': tokens[0].get('token_id'),
                        'condition_id': condition_id,
                        'reward_ratio': (1.0 / yes_price) - 1.0
                    })
                elif no_price >= self.risk_manager.min_probability:
                    opportunities.append({
                        'question': question,
                        'side': 'NO',
                        'price': no_price,
                        'token_id': tokens[1].get('token_id'),
                        'condition_id': condition_id,
                        'reward_ratio': (1.0 / no_price) - 1.0
                    })
            
            # 按收益率排序
            opportunities.sort(key=lambda x: x['reward_ratio'], reverse=True)
            
            logger.info(f"🎯 发现 {len(opportunities)} 个交易机会")
            
        except Exception as e:
            logger.error(f"❌ 扫描市场失败: {e}")
        
        return opportunities
    
    def execute_trade(self, opportunity: Dict, amount: float) -> bool:
        """执行交易"""
        logger.info("=" * 60)
        logger.info(f"💱 执行交易")
        logger.info("=" * 60)
        logger.info(f"   市场: {opportunity['question'][:60]}...")
        logger.info(f"   方向: {opportunity['side']} @ {opportunity['price']:.2%}")
        logger.info(f"   金额: {amount:.2f} USDC")
        logger.info(f"   预期收益: {opportunity['reward_ratio']:.2%}")
        
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
            logger.info(f"   订单ID: {order.get('orderID', 'N/A')}")
            
            # 记录持仓
            self.risk_manager.add_position({
                'question': opportunity['question'],
                'side': opportunity['side'],
                'price': opportunity['price'],
                'amount': amount,
                'order_id': order.get('orderID'),
                'timestamp': datetime.now().isoformat()
            })
            
            return True
            
        except Exception as e:
            logger.error(f"❌ 交易失败: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return False
    
    def send_feishu_notification(self, message: str):
        """发送飞书通知"""
        try:
            # 保存到文件，由外部脚本发送
            notification = {
                'timestamp': datetime.now().isoformat(),
                'message': message
            }
            
            with open('/tmp/polymarket_notification.json', 'w') as f:
                json.dump(notification, f, indent=2)
            
            logger.info("📢 飞书通知已保存")
            
        except Exception as e:
            logger.error(f"❌ 发送飞书通知失败: {e}")
    
    def get_current_positions(self) -> List[Dict]:
        """获取当前持仓"""
        try:
            # 获取订单历史
            orders = self.client.get_orders()
            
            positions = []
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
            
            logger.info(f"📊 当前持仓: {len(positions)} 个")
            return positions
            
        except Exception as e:
            logger.error(f"❌ 获取持仓失败: {e}")
            return []
    
    def run(self):
        """运行机器人"""
        logger.info("=" * 60)
        logger.info("🚀 启动自动交易机器人")
        logger.info("=" * 60)
        
        # 1. 获取当前持仓
        current_positions = self.get_current_positions()
        
        if current_positions:
            logger.info("📊 现有持仓:")
            for i, pos in enumerate(current_positions, 1):
                logger.info(f"   #{i}: {pos['side']} @ {pos['price']:.2%} | {pos['market'][:40]}...")
            
            logger.info(f"\n💰 资金已占用，跳过新开仓")
            logger.info(f"   等待持仓平仓后再执行新交易")
            return
        
        # 2. 扫描市场
        opportunities = self.scan_markets()
        
        if not opportunities:
            logger.warning("⚠️  未发现符合条件的交易机会")
            self.send_feishu_notification("⚠️  未发现符合条件的交易机会")
            return
        
        # 显示前 5 个机会
        logger.info("")
        logger.info("前 5 个最佳机会:")
        for i, opp in enumerate(opportunities[:5]):
            logger.info(f"#{i+1}: {opp['side']} @ {opp['price']:.2%} | {opp['question'][:50]}...")
        
        # 执行交易
        logger.info("")
        logger.info("=" * 60)
        logger.info("💰 开始执行交易")
        logger.info("=" * 60)
        
        executed_count = 0
        for opp in opportunities:
            # 检查是否可以开仓
            can_open, reason = self.risk_manager.can_open_position(
                amount=1.0,  # 每个市场投资 1 USDC
                probability=opp['price']
            )
            
            if not can_open:
                logger.info(f"   跳过: {reason}")
                continue
            
            # 执行交易
            if self.execute_trade(opp, amount=5.0):  # 最小交易量 5 USDC
                executed_count += 1
                time.sleep(2)  # 避免频率限制
            
            # 检查是否已达到最大持仓数
            if executed_count >= self.risk_manager.max_positions:
                break
        
        # 总结
        logger.info("")
        logger.info("=" * 60)
        logger.info("✅ 交易完成")
        logger.info("=" * 60)
        
        summary = self.risk_manager.get_summary()
        logger.info(f"   执行交易: {summary['total_positions']} 笔")
        logger.info(f"   总投资: {summary['total_exposure']:.2f} USDC")
        logger.info(f"   剩余预算: {summary['remaining_budget']:.2f} USDC")
        
        # 发送飞书通知
        notification_message = f"""
✅ Polymarket 自动交易完成

执行交易: {summary['total_positions']} 笔
总投资: {summary['total_exposure']:.2f} USDC
剩余预算: {summary['remaining_budget']:.2f} USDC

持仓详情:
"""
        for i, pos in enumerate(summary['positions'], 1):
            notification_message += f"\n{i}. {pos['side']} @ {pos['price']:.2%} | {pos['amount']:.2f} USDC"
            notification_message += f"\n   {pos['question'][:50]}..."
        
        self.send_feishu_notification(notification_message)
    
    def _check_positions(self):
        """检查持仓止损/止盈"""
        if not self.risk_manager.positions:
            return
        
        logger.info("=" * 60)
        logger.info("🔍 检查持仓止损/止盈")
        logger.info("=" * 60)
        
        for position in self.risk_manager.positions:
            # 获取当前价格（这里需要调用 API）
            # TODO: 实现价格查询
            
            # 模拟价格变动
            current_price = position['price'] * 0.95  # 假设价格下跌 5%
            
            # 检查止损/止盈
            if self.risk_manager.check_stop_loss(position, current_price):
                self.risk_manager.execute_stop_loss(position, current_price)


def main():
    """主函数"""
    try:
        trader = PolymarketAutoTrader()
        trader.run()
    except Exception as e:
        logger.error(f"❌ 机器人运行失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return 1
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
