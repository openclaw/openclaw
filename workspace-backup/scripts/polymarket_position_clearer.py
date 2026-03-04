#!/usr/bin/env python3
"""
Polymarket 持仓自动清理器
功能：自动清理低质量持仓，腾出资金用于新机会
依赖：无需第三方库，使用 urllib + 手动签名
"""

import json
import urllib.request
import urllib.error
import os
import time
import base64
import hmac
import hashlib
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from enum import Enum

# 代理配置
PROXY = "http://host.docker.internal:7890"

class HoldingQuality(Enum):
    """持仓质量等级"""
    HIGH = "high"       # 高确定性，盈利中
    MEDIUM = "medium"   # 中等确定性
    LOW = "low"         # 低确定性，亏损中
    UNKNOWN = "unknown" # 无法评估

@dataclass
class Position:
    """持仓信息"""
    condition_id: str
    outcome: str
    size: int
    asset_id: str
    investment: float
    current_price: float
    value: float
    pnl: float
    pnl_percent: float
    quality: HoldingQuality

class PolymarketClearer:
    """Polymarket 持仓清理器"""
    
    def __init__(self, config_file: str = "config/polymarket.env"):
        """初始化"""
        self.proxy = PROXY
        self._load_credentials(config_file)
        self._setup_proxy()
    
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
        self.api_secret_raw = env_vars.get('POLYMARKET_SECRET')
        self.api_passphrase = env_vars.get('POLYMARKET_PASSPHRASE')
        self.address = env_vars.get('POLYMARKET_ADDRESS')
        
        # URL-safe Base64 解码
        if self.api_secret_raw:
            self.api_secret = self._urlsafe_b64decode(self.api_secret_raw)
    
    def _urlsafe_b64decode(self, s: str) -> bytes:
        """URL-safe Base64 解码"""
        s = s.replace('-', '+').replace('_', '/')
        padding = 4 - len(s) % 4
        if padding != 4:
            s += '=' * padding
        return base64.b64decode(s)
    
    def _setup_proxy(self):
        """设置代理"""
        os.environ['http_proxy'] = self.proxy
        os.environ['https_proxy'] = self.proxy
    
    def _request(self, url: str, method: str = "GET", data: Optional[Dict] = None, 
                 authenticated: bool = False, timeout: int = 10) -> Dict:
        """发送 HTTP 请求（使用代理）"""
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
            proxy_handler = urllib.request.ProxyHandler({
                'http': self.proxy,
                'https': self.proxy
            })
            opener = urllib.request.build_opener(proxy_handler)
            
            if method == "GET":
                req = urllib.request.Request(url, headers=headers)
            else:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(data).encode('utf-8') if data else None,
                    headers=headers,
                    method=method
                )
            
            with opener.open(req, timeout=timeout) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            return {"error": True, "status": e.code, "message": error_body}
        except Exception as e:
            return {"error": True, "message": str(e)}
    
    def _generate_signature(self, timestamp: str, method: str, path: str) -> str:
        """生成签名"""
        message = f"{timestamp}{method}{path}"
        signature = base64.b64encode(
            hmac.new(
                self.api_secret,
                message.encode('utf-8'),
                hashlib.sha256
            ).digest()
        ).decode('utf-8')
        return signature
    
    def fetch_positions(self) -> List[Dict]:
        """查询用户持仓"""
        DATA_API = "https://data-api.polymarket.com"
        url = f"{DATA_API}/positions?user={self.address}"
        
        result = self._request(url)
        if isinstance(result, list):
            return result
        else:
            print(f"❌ 查询持仓失败: {result.get('message', 'Unknown')}")
            return []
    
    def fetch_market_price(self, condition_id: str, outcome: str) -> float:
        """获取市场价格"""
        GAMMA_API = "https://gamma-api.polymarket.com"
        url = f"{GAMMA_API}/markets?conditionId={condition_id}"
        
        try:
            result = self._request(url, timeout=5)
            if isinstance(result, list) and len(result) > 0:
                market = result[0]
                outcomes = market.get('outcomes', [])
                for o in outcomes:
                    if isinstance(o, dict) and o.get('outcome') == outcome:
                        return float(o.get('price', 0.5))
        except Exception as e:
            print(f"⚠️ 获取价格失败: {e}")
        
        return 0.5  # 默认返回 0.5
    
    def evaluate_positions(self, positions_data: List[Dict]) -> List[Position]:
        """评估持仓质量"""
        positions = []
        
        for pos_data in positions_data:
            condition_id = pos_data.get('conditionId', '')
            outcome = pos_data.get('outcome', 'Unknown')
            size = int(pos_data.get('size', 0))
            asset_id = pos_data.get('asset', '')
            
            # 获取当前价格
            current_price = self.fetch_market_price(condition_id, outcome)
            
            # 计算价值和盈亏
            investment = 5.0  # USDC（已知每笔 5 USDC）
            value = size * current_price
            pnl = value - investment
            pnl_percent = (pnl / investment * 100) if investment > 0 else 0
            
            # 评估质量
            if pnl_percent > 10:
                quality = HoldingQuality.HIGH
            elif pnl_percent > -10:
                quality = HoldingQuality.MEDIUM
            else:
                quality = HoldingQuality.LOW
            
            positions.append(Position(
                condition_id=condition_id,
                outcome=outcome,
                size=size,
                asset_id=asset_id,
                investment=investment,
                current_price=current_price,
                value=value,
                pnl=pnl,
                pnl_percent=pnl_percent,
                quality=quality
            ))
        
        return positions
    
    def get_clearable_positions(self, positions: List[Position], 
                               strategy: str = "aggressive") -> List[Position]:
        """获取可清理的持仓"""
        if strategy == "aggressive":
            # 清理中等和低质量
            return [p for p in positions if p.quality in [HoldingQuality.LOW, HoldingQuality.MEDIUM]]
        elif strategy == "conservative":
            # 只清理低质量
            return [p for p in positions if p.quality == HoldingQuality.LOW]
        else:
            # 默认：清理亏损超过 20% 的
            return [p for p in positions if p.pnl_percent < -20]
    
    def create_sell_order(self, position: Position) -> Dict:
        """创建卖出订单（简化版，实际需要 Polygon 交易）"""
        print(f"\n📝 创建卖出订单:")
        print(f"  市场: {position.condition_id[:30]}")
        print(f"  结果: {position.outcome}")
        print(f"  数量: {position.size} 份额")
        print(f"  价格: {position.current_price:.4f}")
        print(f"  预期回收: {position.value:.2f} USDC")
        
        # 实际交易需要：
        # 1. 构造 Polygon 交易
        # 2. 使用私钥签名
        # 3. 发送到 CLOB API
        # 这里简化为模拟
        
        return {
            "status": "simulated",
            "market": position.condition_id,
            "outcome": position.outcome,
            "size": position.size,
            "price": position.current_price,
            "expected_value": position.value,
            "note": "实际交易需要 Polygon 链上操作，请访问 https://polymarket.com/portfolio"
        }
    
    def clear_positions(self, strategy: str = "aggressive", 
                       dry_run: bool = True) -> Dict:
        """清理持仓"""
        print(f"🤖 Polymarket 持仓清理器\n")
        print(f"策略: {strategy}")
        print(f"模式: {'模拟' if dry_run else '实际执行'}\n")
        
        # 1. 查询持仓
        print(f"📊 查询持仓...")
        positions_data = self.fetch_positions()
        if not positions_data:
            return {"error": "未找到持仓"}
        
        print(f"✅ 找到 {len(positions_data)} 个持仓\n")
        
        # 2. 评估持仓
        print(f"📈 评估持仓质量...")
        positions = self.evaluate_positions(positions_data)
        
        print(f"\n{'='*70}")
        print(f"持仓详情:")
        print(f"{'='*70}\n")
        
        for i, pos in enumerate(positions, 1):
            print(f"#{i}: {pos.outcome} - {pos.size} 份额")
            print(f"   投入: {pos.investment:.2f} USDC")
            print(f"   价值: {pos.value:.2f} USDC")
            print(f"   盈亏: {pos.pnl:+.2f} USDC ({pos.pnl_percent:+.1f}%)")
            print(f"   质量: {pos.quality.value}")
            print(f"   ---")
        
        # 3. 统计
        total_investment = sum(p.investment for p in positions)
        total_value = sum(p.value for p in positions)
        total_pnl = sum(p.value - p.investment for p in positions)
        
        print(f"\n总计:")
        print(f"  投入: {total_investment:.2f} USDC")
        print(f"  价值: {total_value:.2f} USDC")
        print(f"  盈亏: {total_pnl:+.2f} USDC ({total_pnl/total_investment*100:+.1f}%)\n")
        
        # 4. 识别可清理持仓
        print(f"{'='*70}")
        print(f"清理建议:")
        print(f"{'='*70}\n")
        
        clearable = self.get_clearable_positions(positions, strategy)
        
        if not clearable:
            print(f"✅ 没有需要清理的持仓")
            return {
                "status": "no_action",
                "total_positions": len(positions),
                "clearable": 0
            }
        
        print(f"⚠️ 需要清理 {len(clearable)} 个持仓:\n")
        
        orders = []
        total_recovery = 0
        
        for pos in clearable:
            order = self.create_sell_order(pos)
            orders.append(order)
            total_recovery += pos.value
        
        print(f"\n可回收资金: {total_recovery:.2f} USDC")
        
        # 5. 执行或模拟
        if dry_run:
            print(f"\n⚠️ 模拟模式：未实际执行交易")
            print(f"   要实际清理，请设置 dry_run=False")
            print(f"   或手动访问: https://polymarket.com/portfolio")
        else:
            print(f"\n⚠️ 实际执行模式：需要 Polygon 链上交易")
            print(f"   当前实现仅为模拟，实际交易需要：")
            print(f"   1. web3.py 库")
            print(f"   2. Polygon 节点 RPC")
            print(f"   3. 智能合约交互")
        
        return {
            "status": "dry_run" if dry_run else "simulated",
            "total_positions": len(positions),
            "clearable": len(clearable),
            "total_recovery": total_recovery,
            "orders": orders
        }

def main():
    """主函数"""
    clearer = PolymarketClearer()
    
    # 激进策略清理（清理中等和低质量）
    result = clearer.clear_positions(strategy="aggressive", dry_run=False)
    
    # 保存结果
    with open('temp/position_clear_result.json', 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f"\n✅ 结果已保存到 temp/position_clear_result.json")

if __name__ == "__main__":
    main()
