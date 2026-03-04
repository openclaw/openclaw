#!/usr/bin/env python3
"""分析 Polymarket 高概率机会的实际可交易性"""

import json
import subprocess

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

def curl_get(url, params=None):
    cmd = ['curl', '-s', '-m', '60']
    if params:
        param_str = '&'.join([f"{k}={v}" for k, v in params.items()])
        url = f"{url}?{param_str}"
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=65)
    if result.returncode == 0:
        return json.loads(result.stdout)
    return None

# 获取市场
markets = curl_get(f"{GAMMA_API}/markets", {
    'active': 'true',
    'closed': 'false',
    'limit': '100'
})

if not markets:
    print("❌ 无法获取市场数据")
    exit(1)

print(f"✅ 获取 {len(markets)} 个市场\n")

# 分析高概率机会
all_opps = []

for market in markets:
    if not market.get('acceptingOrders', False):
        continue
    
    # 解析 tokens
    tokens_raw = market.get('clobTokenIds', [])
    try:
        tokens = json.loads(tokens_raw) if isinstance(tokens_raw, str) else tokens_raw
    except:
        continue
    
    if len(tokens) != 2:
        continue
    
    question = market.get('question', 'Unknown')
    volume = float(market.get('volume', 0))
    
    # 解析 outcomePrices
    outcome_prices_raw = market.get('outcomePrices', ['0', '0'])
    try:
        outcome_prices = json.loads(outcome_prices_raw) if isinstance(outcome_prices_raw, str) else outcome_prices_raw
    except:
        continue
    
    try:
        yes_price = float(outcome_prices[0])
        no_price = float(outcome_prices[1])
    except:
        continue
    
    # 计算套利空间
    spread = (yes_price + no_price) - 1.0
    
    # 分析两个方向
    if yes_price >= 0.90:
        all_opps.append({
            'question': question,
            'outcome': 'YES',
            'probability': yes_price,
            'price': yes_price,
            'volume': volume,
            'spread': spread,
            'potential_profit': (1.0 - yes_price) / yes_price if yes_price < 1.0 else 0,
            'token_id': tokens[0]
        })
    
    if no_price >= 0.90:
        all_opps.append({
            'question': question,
            'outcome': 'NO',
            'probability': no_price,
            'price': no_price,
            'volume': volume,
            'spread': spread,
            'potential_profit': (1.0 - no_price) / no_price if no_price < 1.0 else 0,
            'token_id': tokens[1]
        })

# 按潜在利润排序（而不是概率）
all_opps.sort(key=lambda x: x['potential_profit'], reverse=True)

print("=" * 100)
print("💰 高概率机会分析（按潜在利润排序，Top 20）")
print("=" * 100)

for i, opp in enumerate(all_opps[:20], 1):
    print(f"{i:2d}. 潜在利润: {opp['potential_profit']*100:5.1f}% | 概率: {opp['probability']*100:5.1f}% | "
          f"价差: {opp['spread']*100:+5.2f}% | ${opp['volume']:>10,.0f}")
    print(f"    {opp['outcome']:3s} | {opp['question'][:80]}")
    print()

# 统计分析
print("\n" + "=" * 100)
print("📊 统计分析")
print("=" * 100)

profits = [x['potential_profit'] for x in all_opps]
spreads = [x['spread'] for x in all_opps]

print(f"\n潜在利润分布:")
print(f"  最高: {max(profits)*100:.1f}%")
print(f"  平均: {sum(profits)/len(profits)*100:.1f}%")
print(f"  >0% 利润: {len([p for p in profits if p > 0])}")
print(f"  >5% 利润: {len([p for p in profits if p > 0.05])}")
print(f"  >10% 利润: {len([p for p in profits if p > 0.10])}")

print(f"\n价差分布:")
print(f"  最高: {max(spreads)*100:.2f}%")
print(f"  最低: {min(spreads)*100:.2f}%")
print(f"  平均: {sum(spreads)/len(spreads)*100:.2f}%")
print(f"  正价差（套利机会）: {len([s for s in spreads if s > 0])}")

print("\n💡 策略建议:")
print("  1. 高概率（>=90%）不等于高利润")
print("  2. 100% 概率 = 0% 利润（价格已经是 $1.00）")
print("  3. 应该寻找 90-95% 概率的机会（5-10% 潜在利润）")
print("  4. 注意价差：正价差意味着套利机会（YES+NO > $1.00）")
