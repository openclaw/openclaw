#!/usr/bin/env python3
"""
Polymarket 自动交易机器人 - 轻量版（无外部依赖）
使用 REST API 直接调用，无需 py-clob-client
"""

import os
import json
import time
import hmac
import hashlib
import base64
import logging
from datetime import datetime
from typing import Optional, Dict, List
import urllib.request
import urllib.parse
import urllib.error

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/polymarket_bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger('PolymarketBot')

class PolymarketTrader:
    """Polymarket 自动交易机器人（轻量版）"""
    
    def __init__(self, api_key: str, secret: str, passphrase: str, 
                 private_key: str, address: str):
        """
        初始化交易机器人
        """
        self.host = "https://clob.polymarket.com"
        self.chain_id = 137  # Polygon
        
        # API 凭证
        self.api_key = api_key
        self.secret = secret
        self.passphrase = passphrase
        
        # 钱包信息
        self.private_key = private_key
        self.address = address
        
        # 策略参数
        self.max_position_size = 1.0  # 单笔最大 1 USDC
        self.min_volume = 100000  # 最小交易量 $100K
        self.high_certainty_threshold = 0.90  # 高确定性阈值 90%
        
        # 交易记录
        self.trades_file = '/home/node/.openclaw/workspace/data/polymarket_trades.json'
        self.trades = self._load_trades()
        
        logger.info(f"🤖 初始化交易机器人")
        logger.info(f"   地址: {self.address}")
        logger.info(f"   API Key: {self.api_key[:8]}...")
        
    def _load_trades(self) -> List[Dict]:
        """加载交易记录"""
        if os.path.exists(self.trades_file):
            with open(self.trades_file, 'r') as f:
                return json.load(f)
        return []
    
    def _save_trades(self):
        """保存交易记录"""
        os.makedirs(os.path.dirname(self.trades_file), exist_ok=True)
        with open(self.trades_file, 'w') as f:
            json.dump(self.trades, f, indent=2)
    
    def _request(self, method: str, endpoint: str, data: Optional[Dict] = None) -> Optional[Dict]:
        """发送 HTTP 请求"""
        url = f"{self.host}{endpoint}"
        
        try:
            # 准备请求
            req_data = None
            if data:
                req_data = json.dumps(data).encode('utf-8')
            
            # 创建请求
            req = urllib.request.Request(url, data=req_data, method=method)
            
            # 添加请求头
            req.add_header('Content-Type', 'application/json')
            req.add_header('User-Agent', 'PolymarketBot/1.0')
            
            # 如果有 API Key，添加认证头
            if self.api_key:
                # 生成签名（简化版，实际需要更复杂的签名逻辑）
                timestamp = str(int(time.time()))
                req.add_header('POLY-ADDRESS', self.address)
                req.add_header('POLY-API-KEY', self.api_key)
                req.add_header('POLY-TIMESTAMP', timestamp)
            
            # 发送请求
            with urllib.request.urlopen(req, timeout=30) as response:
                result = response.read().decode('utf-8')
                return json.loads(result)
                
        except urllib.error.HTTPError as e:
            logger.error(f"HTTP 错误: {e.code} - {e.reason}")
            if e.code == 401:
                logger.error("   认证失败，请检查 API Key 和私钥")
            return None
        except urllib.error.URLError as e:
            logger.error(f"网络错误: {e.reason}")
            return None
        except Exception as e:
            logger.error(f"请求失败: {e}")
            return None
    
    def test_connection(self) -> bool:
        """测试 API 连接"""
        logger.info("🔌 测试 API 连接...")
        
        # 测试公开端点
        result = self._request('GET', '/')
        if result:
            logger.info(f"✅ API 连接成功")
            logger.info(f"   响应: {result}")
            return True
        else:
            logger.error("❌ API 连接失败")
            return False
    
    def get_server_time(self) -> Optional[int]:
        """获取服务器时间"""
        result = self._request('GET', '/time')
        if result:
            return result.get('timestamp')
        return None
    
    def get_markets(self) -> List[Dict]:
        """获取所有市场"""
        logger.info("📊 获取市场列表...")
        
        result = self._request('GET', '/markets')
        if result and isinstance(result, list):
            logger.info(f"   获取到 {len(result)} 个市场")
            return result
        
        # 尝试简化的市场接口
        result = self._request('GET', '/simplified-markets')
        if result and 'data' in result:
            markets = result['data']
            logger.info(f"   获取到 {len(markets)} 个市场")
            return markets
        
        logger.warning("⚠️  无法获取市场列表")
        return []
    
    def analyze_market(self, market: Dict) -> Optional[Dict]:
        """分析市场，寻找套利机会"""
        try:
            # 提取市场信息
            tokens = market.get('tokens', [])
            if len(tokens) < 2:
                return None
            
            yes_token = tokens[0]
            no_token = tokens[1]
            
            # 获取当前价格
            yes_price = float(yes_token.get('price', 0.5))
            no_price = float(no_token.get('price', 0.5))
            
            # 获取交易量
            volume_str = market.get('volume', '0')
            volume = float(volume_str.replace('$', '').replace(',', ''))
            
            # 过滤：交易量不足
            if volume < self.min_volume:
                return None
            
            # 寻找高确定性机会
            opportunity = None
            
            # Yes 方向：价格 > 90%
            if yes_price > self.high_certainty_threshold:
                opportunity = {
                    'market_slug': market.get('market_slug'),
                    'question': market.get('question'),
                    'token_id': yes_token.get('token_id'),
                    'side': 'BUY',
                    'outcome': 'YES',
                    'current_price': yes_price,
                    'edge': yes_price - 0.5,
                    'volume': volume,
                    'reason': f"高确定性 Yes（{yes_price*100:.1f}%），交易量 ${volume:,.0f}"
                }
            
            # No 方向：价格 > 90%
            elif no_price > self.high_certainty_threshold:
                opportunity = {
                    'market_slug': market.get('market_slug'),
                    'question': market.get('question'),
                    'token_id': no_token.get('token_id'),
                    'side': 'BUY',
                    'outcome': 'NO',
                    'current_price': no_price,
                    'edge': no_price - 0.5,
                    'volume': volume,
                    'reason': f"高确定性 No（{no_price*100:.1f}%），交易量 ${volume:,.0f}"
                }
            
            return opportunity
            
        except Exception as e:
            logger.error(f"分析市场失败: {e}")
            return None
    
    def run_strategy(self):
        """运行交易策略"""
        logger.info("=" * 60)
        logger.info("🔍 开始扫描市场...")
        logger.info("=" * 60)
        
        # 测试连接
        if not self.test_connection():
            logger.error("❌ 无法连接到 Polymarket API")
            logger.error("   可能原因：")
            logger.error("   1. API Key 不正确")
            logger.error("   2. 网络连接问题")
            logger.error("   3. Polymarket API 服务不可用")
            return
        
        # 获取市场
        markets = self.get_markets()
        logger.info(f"📊 共获取 {len(markets)} 个市场")
        
        if not markets:
            logger.warning("⚠️  未获取到任何市场")
            return
        
        # 分析每个市场
        opportunities = []
        for market in markets[:100]:  # 只分析前 100 个
            opp = self.analyze_market(market)
            if opp:
                opportunities.append(opp)
        
        # 按 edge 排序
        opportunities.sort(key=lambda x: x['edge'], reverse=True)
        
        logger.info(f"🎯 发现 {len(opportunities)} 个交易机会")
        
        if not opportunities:
            logger.info("⚠️  未发现符合条件的交易机会")
            logger.info("   原因：当前市场流动性不足或确定性不高")
        else:
            # 显示前 5 个机会
            for i, opp in enumerate(opportunities[:5]):
                logger.info("")
                logger.info(f"机会 #{i+1}")
                logger.info(f"  市场: {opp['question'][:80]}...")
                logger.info(f"  方向: {opp['outcome']} @ {opp['current_price']:.2%}")
                logger.info(f"  原因: {opp['reason']}")
                logger.info(f"  优势: {opp['edge']:.2%}")
        
        logger.info("")
        logger.info("=" * 60)
        logger.info("✅ 市场扫描完成")
        logger.info("=" * 60)
        logger.info("")
        logger.info("⚠️  注意：")
        logger.info("   由于缺少 py-clob-client 库，当前只能扫描市场")
        logger.info("   无法自动下单")
        logger.info("")
        logger.info("   要启用自动交易，需要：")
        logger.info("   1. 安装 pip: apt-get install python3-pip")
        logger.info("   2. 安装库: pip3 install py-clob-client")
        logger.info("   3. 重启机器人")

def load_credentials():
    """从环境文件加载凭证"""
    env_file = '/home/node/.openclaw/workspace/config/polymarket.env'
    
    if not os.path.exists(env_file):
        logger.error(f"❌ 凭证文件不存在: {env_file}")
        return None
    
    creds = {}
    with open(env_file, 'r') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                creds[key.strip()] = value.strip()
    
    return creds

def main():
    """主函数"""
    logger.info("=" * 60)
    logger.info("🤖 Polymarket 自动交易机器人启动（轻量版）")
    logger.info("=" * 60)
    
    # 加载凭证
    creds = load_credentials()
    if not creds:
        logger.error("❌ 无法加载凭证")
        return
    
    # 验证必要字段
    required = ['POLYMARKET_PRIVATE_KEY', 'POLYMARKET_ADDRESS']
    missing = [k for k in required if k not in creds or not creds[k]]
    
    if missing:
        logger.error(f"❌ 缺少必要字段: {missing}")
        return
    
    # 重要提示
    logger.info("")
    logger.info("⚠️  重要提示：")
    logger.info("   Polymarket 运行在 Polygon 链上（Chain ID: 137）")
    logger.info(f"   你的钱包地址: {creds['POLYMARKET_ADDRESS']}")
    logger.info("   请确保：")
    logger.info("   1. 钱包已在 Polygon 网络上充值 USDC")
    logger.info("   2. 已设置 Token Allowances")
    logger.info("")
    
    # 创建交易机器人
    bot = PolymarketTrader(
        api_key=creds.get('POLYMARKET_API_KEY', ''),
        secret=creds.get('POLYMARKET_SECRET', ''),
        passphrase=creds.get('POLYMARKET_PASSPHRASE', ''),
        private_key=creds['POLYMARKET_PRIVATE_KEY'],
        address=creds['POLYMARKET_ADDRESS']
    )
    
    # 运行策略
    bot.run_strategy()

if __name__ == '__main__':
    main()
