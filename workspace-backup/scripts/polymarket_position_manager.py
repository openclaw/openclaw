#!/usr/bin/env python3
"""
Polymarket 持仓管理器 - 自动清理低质量持仓
功能：
1. 查询当前持仓
2. 评估持仓质量（确定性、盈亏）
3. 清理低质量持仓（腾出资金）
4. 为新机会留出仓位
"""

import json
import urllib.request
import urllib.error
import os
from typing import List, Dict, Tuple
from dataclasses import dataclass
from enum import Enum

class HoldingQuality(Enum):
    """持仓质量等级"""
    HIGH = "high"       # 高确定性，盈利中
    MEDIUM = "medium"   # 中等确定性
    LOW = "low"         # 低确定性，亏损中
    UNKNOWN = "unknown" # 无法评估

@dataclass
class Position:
    """持仓信息"""
    id: str
    market: str
    outcome: str
    size: int
    entry_price: float
    current_price: float
    investment: float  # USDC
    value: float       # 当前价值
    pnl: float         # 盈亏
    pnl_percent: float # 盈亏百分比
    quality: HoldingQuality
    
def load_credentials(config_file: str = "config/polymarket.env") -> Dict:
    """加载 API 凭证"""
    env_vars = {}
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key] = value
    return env_vars

def fetch_positions(address: str) -> List[Dict]:
    """查询用户持仓"""
    DATA_API = "https://data-api.polymarket.com"
    url = f"{DATA_API}/positions?user={address}"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OpenClaw/1.0"})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f"❌ 查询持仓失败: {e}")
        return []

def fetch_market_price(condition_id: str, outcome: str) -> float:
    """获取市场价格"""
    # 使用 Gamma API 查询市场数据
    GAMMA_API = "https://gamma-api.polymarket.com"
    url = f"{GAMMA_API}/markets?conditionId={condition_id}"
    
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OpenClaw/1.0"})
        with urllib.request.urlopen(req, timeout=5) as response:
            markets = json.loads(response.read().decode('utf-8'))
            if markets:
                market = markets[0]
                # 根据结果返回价格
                outcomes = market.get('outcomes', [])
                for o in outcomes:
                    if o.get('outcome') == outcome:
                        return float(o.get('price', 0.5))
    except Exception as e:
        print(f"⚠️ 获取价格失败: {e}")
    
    return 0.5  # 默认返回 0.5

def evaluate_position(pos: Dict) -> Position:
    """评估持仓质量"""
    condition_id = pos.get('conditionId', '')
    outcome = pos.get('outcome', 'Unknown')
    size = int(pos.get('size', 0))
    
    # 假设入场价格为 0.5（实际需要从交易历史获取）
    entry_price = 0.5
    
    # 获取当前价格
    current_price = fetch_market_price(condition_id, outcome)
    
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
    
    return Position(
        id=condition_id[:20],
        market=condition_id,
        outcome=outcome,
        size=size,
        entry_price=entry_price,
        current_price=current_price,
        investment=investment,
        value=value,
        pnl=pnl,
        pnl_percent=pnl_percent,
        quality=quality
    )

def should_clear_position(pos: Position, strategy: str = "aggressive") -> bool:
    """判断是否应该清理持仓"""
    if strategy == "aggressive":
        # 激进策略：清理所有中等和低质量持仓
        return pos.quality in [HoldingQuality.LOW, HoldingQuality.MEDIUM]
    elif strategy == "conservative":
        # 保守策略：只清理低质量持仓
        return pos.quality == HoldingQuality.LOW
    else:
        # 默认策略：清理亏损超过 20% 的持仓
        return pos.pnl_percent < -20

def analyze_positions(address: str) -> Tuple[List[Position], Dict]:
    """分析所有持仓"""
    print(f"📊 分析持仓: {address[:20]}...\n")
    
    # 查询持仓
    raw_positions = fetch_positions(address)
    if not raw_positions:
        print("❌ 未找到持仓")
        return [], {}
    
    print(f"✅ 找到 {len(raw_positions)} 个持仓\n")
    
    # 评估每个持仓
    positions = []
    for pos_data in raw_positions:
        pos = evaluate_position(pos_data)
        positions.append(pos)
        
        print(f"持仓 {pos.id}:")
        print(f"  结果: {pos.outcome}")
        print(f"  数量: {pos.size} 份额")
        print(f"  投入: {pos.investment:.2f} USDC")
        print(f"  价值: {pos.value:.2f} USDC")
        print(f"  盈亏: {pos.pnl:+.2f} USDC ({pos.pnl_percent:+.1f}%)")
        print(f"  质量: {pos.quality.value}")
        print(f"  ---")
    
    # 统计
    total_investment = sum(p.investment for p in positions)
    total_value = sum(p.value for p in positions)
    total_pnl = sum(p.pnl for p in positions)
    
    quality_counts = {}
    for q in HoldingQuality:
        quality_counts[q.value] = len([p for p in positions if p.quality == q])
    
    summary = {
        "total_positions": len(positions),
        "total_investment": total_investment,
        "total_value": total_value,
        "total_pnl": total_pnl,
        "quality_distribution": quality_counts,
    }
    
    print(f"\n{'='*60}")
    print(f"总投入: {total_investment:.2f} USDC")
    print(f"总价值: {total_value:.2f} USDC")
    print(f"总盈亏: {total_pnl:+.2f} USDC ({total_pnl/total_investment*100:+.1f}%)")
    print(f"\n质量分布:")
    for q, count in quality_counts.items():
        if count > 0:
            print(f"  {q}: {count}")
    print(f"{'='*60}\n")
    
    return positions, summary

def get_positions_to_clear(positions: List[Position], strategy: str = "aggressive") -> List[Position]:
    """获取需要清理的持仓"""
    to_clear = [p for p in positions if should_clear_position(p, strategy)]
    
    if to_clear:
        print(f"⚠️ 需要清理的持仓（{strategy} 策略）:\n")
        for p in to_clear:
            print(f"  {p.id}: {p.outcome}, 盈亏 {p.pnl_percent:+.1f}%")
        
        potential_recovery = sum(p.value for p in to_clear)
        print(f"\n可回收资金: {potential_recovery:.2f} USDC")
    else:
        print(f"✅ 没有需要清理的持仓（{strategy} 策略）")
    
    return to_clear

def main():
    """主函数"""
    print("🤖 Polymarket 持仓管理器\n")
    
    # 加载配置
    config = load_credentials()
    address = config.get('POLYMARKET_ADDRESS')
    
    if not address:
        print("❌ 未配置钱包地址")
        return
    
    # 分析持仓
    positions, summary = analyze_positions(address)
    
    if not positions:
        return
    
    # 识别需要清理的持仓
    print(f"\n{'='*60}")
    print("持仓清理建议")
    print(f"{'='*60}\n")
    
    # 激进策略
    print("【激进策略】清理中等和低质量持仓")
    aggressive_clear = get_positions_to_clear(positions, "aggressive")
    
    print(f"\n{'='*60}\n")
    
    # 保守策略
    print("【保守策略】仅清理低质量持仓")
    conservative_clear = get_positions_to_clear(positions, "conservative")
    
    print(f"\n{'='*60}\n")
    
    # 建议
    print("💡 建议:")
    if aggressive_clear:
        print("  1. 如果发现高确定性新机会，使用激进策略")
        print(f"     - 清理 {len(aggressive_clear)} 个持仓")
        print(f"     - 回收 {sum(p.value for p in aggressive_clear):.2f} USDC")
    
    if conservative_clear:
        print("  2. 如果只是优化仓位，使用保守策略")
        print(f"     - 清理 {len(conservative_clear)} 个持仓")
        print(f"     - 回收 {sum(p.value for p in conservative_clear):.2f} USDC")
    
    print("\n⚠️ 注意：清理持仓需要通过网页或交易 API 操作")
    print("   网页: https://polymarket.com/portfolio")

if __name__ == "__main__":
    main()
