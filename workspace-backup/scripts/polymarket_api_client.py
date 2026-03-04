#!/usr/bin/env python3
"""
Polymarket API 客户端 - 完整实现
文档：https://docs.polymarket.com/api-reference/introduction
支持：市场查询、持仓查询、交易历史、价格数据
"""

import json
import hmac
import hashlib
import base64
import time
import urllib.request
import urllib.error
import os
from typing import Dict, List, Optional, Any

# API 基础 URL
GAMMA_API = "https://gamma-api.polymarket.com"
DATA_API = "https://data-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

class PolymarketClient:
    """Polymarket API 客户端"""
    
    def __init__(self, config_file: str = "config/polymarket.env"):
        """初始化客户端，加载凭证"""
        self.api_key = None
        self.api_secret = None
        self.api_passphrase = None
        self.address = None
        
        # 加载凭证
        if os.path.exists(config_file):
            self._load_credentials(config_file)
    
    def _load_credentials(self, config_file: str):
        """从 .env 文件加载凭证"""
        env_vars = {}
        with open(config_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key] = value
        
        self.api_key = env_vars.get('POLYMARKET_API_KEY')
        self.api_secret_raw = env_vars.get('POLYMARKET_SECRET')
        self.api_passphrase = env_vars.get('POLYMARKET_PASSPHRASE')
        self.address = env_vars.get('POLYMARKET_ADDRESS')
        
        # URL-safe Base64 解码
        if self.api_secret_raw:
            self.api_secret = self._urlsafe_b64decode(self.api_secret_raw)
    
    def _urlsafe_b64decode(self, s: str) -> bytes:
        """将 URL-safe Base64 转换为标准格式并解码"""
        s = s.replace('-', '+').replace('_', '/')
        padding = 4 - len(s) % 4
        if padding != 4:
            s += '=' * padding
        return base64.b64decode(s)
    
    def _generate_signature(self, timestamp: str, method: str, path: str) -> str:
        """生成认证签名"""
        message = f"{timestamp}{method}{path}"
        signature = base64.b64encode(
            hmac.new(
                self.api_secret,
                message.encode('utf-8'),
                hashlib.sha256
            ).digest()
        ).decode('utf-8')
        return signature
    
    def _request(self, url: str, method: str = "GET", data: Optional[Dict] = None, 
                 authenticated: bool = False) -> Dict:
        """发送 HTTP 请求"""
        headers = {"User-Agent": "OpenClaw/1.0"}
        
        if authenticated and self.api_key:
            timestamp = str(int(time.time()))
            path = url.split('.com')[1] if '.com' in url else '/'
            signature = self._generate_signature(timestamp, method, path)
            
            headers.update({
                "POLY-ADDRESS": self.address,
                "POLY-API-KEY": self.api_key,
                "POLY-SIGNATURE": signature,
                "POLY-TIMESTAMP": timestamp,
                "POLY-PASSPHRASE": self.api_passphrase,
            })
        
        try:
            if method == "GET":
                req = urllib.request.Request(url, headers=headers)
            else:
                req = urllib.request.Request(
                    url, 
                    data=json.dumps(data).encode('utf-8') if data else None,
                    headers=headers,
                    method=method
                )
            
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            return {"error": True, "status": e.code, "message": error_body}
        except Exception as e:
            return {"error": True, "message": str(e)}
    
    # ===== 公开 API（无需认证）=====
    
    def get_markets(self, limit: int = 100, offset: int = 0) -> List[Dict]:
        """获取市场列表"""
        url = f"{GAMMA_API}/markets?limit={limit}&offset={offset}"
        return self._request(url)
    
    def get_market_by_id(self, market_id: str) -> Dict:
        """根据 ID 获取市场详情"""
        url = f"{GAMMA_API}/markets/{market_id}"
        return self._request(url)
    
    def get_events(self, limit: int = 100, offset: int = 0) -> List[Dict]:
        """获取事件列表"""
        url = f"{GAMMA_API}/events?limit={limit}&offset={offset}"
        return self._request(url)
    
    def get_order_book(self, condition_id: str, outcome: str = "Yes") -> Dict:
        """获取订单簿（使用 Gamma API）"""
        # Gamma API 查询市场数据
        url = f"{GAMMA_API}/markets?conditionId={condition_id}"
        return self._request(url)
    
    def get_midpoint_price(self, token_id: str) -> Dict:
        """获取中间价"""
        url = f"{CLOB_API}/midpoint?token_id={token_id}"
        return self._request(url)
    
    def get_market_price(self, token_id: str, side: str = "BUY") -> Dict:
        """获取市场价格"""
        url = f"{CLOB_API}/price?token_id={token_id}&side={side}"
        return self._request(url)
    
    def get_last_trade_price(self, token_id: str) -> Dict:
        """获取最后交易价格"""
        url = f"{CLOB_API}/last_trade_price?token_id={token_id}"
        return self._request(url)
    
    # ===== 用户数据 API =====
    
    def get_user_positions(self, user_address: Optional[str] = None) -> List[Dict]:
        """获取用户当前持仓"""
        address = user_address or self.address
        if not address:
            return {"error": True, "message": "未提供钱包地址"}
        
        url = f"{DATA_API}/positions?user={address}"
        return self._request(url)
    
    def get_user_closed_positions(self, user_address: Optional[str] = None) -> List[Dict]:
        """获取用户已关闭持仓"""
        address = user_address or self.address
        if not address:
            return {"error": True, "message": "未提供钱包地址"}
        
        url = f"{DATA_API}/positions/closed?user={address}"
        return self._request(url)
    
    def get_user_total_value(self, user_address: Optional[str] = None) -> Dict:
        """获取用户持仓总价值"""
        address = user_address or self.address
        if not address:
            return {"error": True, "message": "未提供钱包地址"}
        
        url = f"{DATA_API}/total_value?user={address}"
        return self._request(url)
    
    def get_user_trades(self, user_address: Optional[str] = None, 
                       market_id: Optional[str] = None) -> List[Dict]:
        """获取用户交易历史"""
        address = user_address or self.address
        if not address:
            return {"error": True, "message": "未提供钱包地址"}
        
        url = f"{DATA_API}/trades?user={address}"
        if market_id:
            url += f"&market={market_id}"
        return self._request(url)
    
    def get_user_activity(self, user_address: Optional[str] = None) -> Dict:
        """获取用户活动"""
        address = user_address or self.address
        if not address:
            return {"error": True, "message": "未提供钱包地址"}
        
        url = f"{DATA_API}/activity?user={address}"
        return self._request(url)
    
    # ===== 需要认证的 API =====
    
    def get_balances(self) -> Dict:
        """获取账户余额（需要认证）"""
        url = f"{CLOB_API}/balances"
        return self._request(url, authenticated=True)
    
    def get_orders(self) -> List[Dict]:
        """获取订单列表（需要认证）"""
        url = f"{CLOB_API}/orders"
        return self._request(url, authenticated=True)
    
    # ===== 辅助方法 =====
    
    def format_usdc(self, amount: int) -> str:
        """格式化 USDC 金额"""
        return f"{amount / 10**6:.2f} USDC"
    
    def print_summary(self, data: Any, title: str = "数据"):
        """格式化打印数据"""
        print(f"\n{'='*60}")
        print(f"{title}")
        print(f"{'='*60}")
        print(json.dumps(data, indent=2, ensure_ascii=False))


def main():
    """演示用法"""
    client = PolymarketClient()
    
    print("🚀 Polymarket API 客户端")
    print(f"钱包地址: {client.address or '未配置'}")
    print(f"API Key: {client.api_key[:20] if client.api_key else '未配置'}...")
    
    # 1. 获取市场列表
    print("\n📊 获取热门市场...")
    markets = client.get_markets(limit=5)
    if isinstance(markets, list) and len(markets) > 0:
        print(f"✅ 找到 {len(markets)} 个市场")
        for m in markets[:3]:
            print(f"  - {m.get('question', 'N/A')[:50]}...")
    
    # 2. 查询用户持仓
    if client.address:
        print(f"\n💼 查询用户持仓: {client.address[:20]}...")
        positions = client.get_user_positions()
        if isinstance(positions, list):
            print(f"✅ 找到 {len(positions)} 个持仓")
            for pos in positions[:3]:
                print(f"  - {pos.get('market', 'N/A')[:30]}: {pos.get('size', 'N/A')}")
        elif isinstance(positions, dict) and positions.get('error'):
            print(f"❌ 查询失败: {positions.get('message', 'Unknown')}")
        
        # 3. 查询持仓总价值
        print(f"\n💰 查询持仓总价值...")
        total_value = client.get_user_total_value()
        if isinstance(total_value, dict) and not total_value.get('error'):
            print(f"✅ 总价值: {total_value}")
        else:
            print(f"❌ 查询失败: {total_value.get('message', 'Unknown')}")
    
    # 4. 查询余额（需要认证）
    if client.api_key:
        print(f"\n🔑 查询账户余额（认证）...")
        balances = client.get_balances()
        if isinstance(balances, dict) and not balances.get('error'):
            print(f"✅ 余额: {balances}")
        else:
            print(f"❌ 查询失败: {balances.get('message', 'Unknown')}")


if __name__ == "__main__":
    main()
