#!/usr/bin/env python3
"""
Polymarket 自动交易机器人（最终版）
确保代理配置正确，使用活跃市场 API
"""

import os
import sys

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# ⚠️ 必须在导入任何库之前设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'
os.environ['no_proxy'] = 'localhost,127.0.0.1'
os.environ['NO_PROXY'] = 'localhost,127.0.0.1'

import json
import time
import logging
from datetime import datetime
from typing import List, Dict

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, OrderArgs
from dotenv import load_dotenv

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [Bot] %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_final.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketBot')

def main():
    """主函数"""
    logger.info("=" * 60)
    logger.info("🤖 Polymarket 自动交易机器人（最终版）")
    logger.info("=" * 60)
    logger.info("")
    
    # 加载凭证
    load_dotenv('/home/node/.openclaw/workspace/config/polymarket.env')
    
    api_key = os.getenv('POLYMARKET_API_KEY')
    api_secret = os.getenv('POLYMARKET_SECRET')
    passphrase = os.getenv('POLYMARKET_PASSPHRASE')
    
    if not all([api_key, api_secret, passphrase]):
        logger.error("❌ 缺少 API 凭证")
        return 1
    
    logger.info(f"✅ API 凭证已加载")
    logger.info("")
    
    # 初始化客户端
    creds = ApiCreds(
        api_key=api_key,
        api_secret=api_secret,
        api_passphrase=passphrase
    )
    
    client = ClobClient(
        host="https://clob.polymarket.com",
        creds=creds,
        chain_id=137
    )
    
    logger.info("✅ 客户端初始化成功")
    logger.info("")
    
    # 获取活跃市场
    logger.info("=" * 60)
    logger.info("📊 获取活跃市场")
    logger.info("=" * 60)
    
    try:
        markets_data = client.get_sampling_markets()
        markets = markets_data.get('data', [])
        
        logger.info(f"✅ 获取到 {len(markets)} 个活跃市场")
        logger.info("")
        
        # 筛选交易机会
        logger.info("🔍 筛选交易机会（确定性 >60%）...")
        logger.info("")
        
        opportunities = []
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
            
            # 寻找确定性 >60% 的机会
            if yes_price >= 0.60:
                opportunities.append({
                    'question': question,
                    'side': 'YES',
                    'price': yes_price,
                    'token_id': tokens[0].get('token_id'),
                    'condition_id': condition_id
                })
            elif no_price >= 0.60:
                opportunities.append({
                    'question': question,
                    'side': 'NO',
                    'price': no_price,
                    'token_id': tokens[1].get('token_id'),
                    'condition_id': condition_id
                })
        
        logger.info(f"🎯 发现 {len(opportunities)} 个交易机会")
        logger.info("")
        
        if not opportunities:
            logger.warning("⚠️  未发现符合条件的交易机会")
            logger.info("")
            logger.info("💡 建议：")
            logger.info("   1. 降低确定性阈值")
            logger.info("   2. 或者使用手动交易")
            logger.info("   3. 访问 Polymarket 网站查看所有市场")
            return 0
        
        # 显示前 5 个机会
        logger.info("前 5 个最佳机会:")
        logger.info("")
        for i, opp in enumerate(opportunities[:5]):
            logger.info(f"#{i+1}")
            logger.info(f"  市场: {opp['question'][:60]}...")
            logger.info(f"  方向: {opp['side']} @ {opp['price']:.2%}")
            logger.info(f"  ID: {opp['condition_id'][:20]}...")
            logger.info("")
        
        logger.info("=" * 60)
        logger.info("✅ 扫描完成")
        logger.info("=" * 60)
        logger.info("")
        logger.info("⚠️  注意：自动下单功能需要进一步调试")
        logger.info("   建议使用手动交易：")
        logger.info("   1. 访问 https://polymarket.com")
        logger.info("   2. 搜索上述市场")
        logger.info("   3. 手动下单")
        logger.info("")
        logger.info("📖 详细指南：")
        logger.info("   docs/POLYMARKET_MANUAL_TRADING.md")
        
    except Exception as e:
        logger.error(f"❌ 错误: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return 1
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
