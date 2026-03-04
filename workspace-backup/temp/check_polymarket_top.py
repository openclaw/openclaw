#!/usr/bin/env python3
"""临时脚本：查看当前市场最高概率机会"""

import json
import subprocess

GAMMA_API = "https://gamma-api.polymarket.com"

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

print(f"✅ 获取 {len(markets)} 个市场")

# 调试：打印第一个市场的完整结构
if markets:
    print(f"\n🔍 第一个市场示例:")
    sample = markets[0]
    print(f"  question: {sample.get('question', 'N/A')}")
    print(f"  acceptingOrders: {sample.get('acceptingOrders', 'N/A')}")
    print(f"  clobTokenIds: {sample.get('clobTokenIds', 'N/A')}")
    print(f"  outcomePrices: {sample.get('outcomePrices', 'N/A')}")
    print(f"  volume: {sample.get('volume', 'N/A')}")

# 分析所有概率
all_probs = []
skipped_no_orders = 0
skipped_no_tokens = 0
parse_errors = 0

for market in markets:
    if not market.get('acceptingOrders', False):
        skipped_no_orders += 1
        continue
    
    # clobTokenIds 可能是 JSON 字符串，需要解析
    tokens_raw = market.get('clobTokenIds', [])
    try:
        if isinstance(tokens_raw, str):
            tokens = json.loads(tokens_raw)
        else:
            tokens = tokens_raw
    except (json.JSONDecodeError, TypeError):
        skipped_no_tokens += 1
        continue
    
    if len(tokens) != 2:
        skipped_no_tokens += 1
        continue
    
    question = market.get('question', 'Unknown')
    volume = float(market.get('volume', 0))
    
    # outcomePrices 也可能是 JSON 字符串
    outcome_prices_raw = market.get('outcomePrices', ['0', '0'])
    try:
        if isinstance(outcome_prices_raw, str):
            outcome_prices = json.loads(outcome_prices_raw)
        else:
            outcome_prices = outcome_prices_raw
    except (json.JSONDecodeError, TypeError):
        parse_errors += 1
        continue
    
    try:
        # Yes 概率
        yes_price = float(outcome_prices[0])
        if yes_price > 0:
            all_probs.append({
                'question': question,
                'outcome': 'YES',
                'probability': yes_price,
                'volume': volume
            })
        
        # No 概率
        no_price = float(outcome_prices[1])
        if no_price > 0:
            all_probs.append({
                'question': question,
                'outcome': 'NO',
                'probability': no_price,
                'volume': volume
            })
    except (ValueError, TypeError) as e:
        parse_errors += 1
        continue

print(f"\n📊 处理统计:")
print(f"  总市场数: {len(markets)}")
print(f"  跳过（不接受订单）: {skipped_no_orders}")
print(f"  跳过（无两个 token）: {skipped_no_tokens}")
print(f"  解析错误: {parse_errors}")
print(f"  有效机会: {len(all_probs)}")


# 排序
all_probs.sort(key=lambda x: x['probability'], reverse=True)

print(f"\n📊 当前市场概率分布（Top 20）:")
print("=" * 80)
for i, opp in enumerate(all_probs[:20], 1):
    print(f"{i:2d}. [{opp['probability']*100:5.1f}%] {opp['outcome']:3s} | ${opp['volume']:>10,.0f} | {opp['question'][:60]}")

# 统计信息
probs = [x['probability'] for x in all_probs]
print(f"\n📈 统计:")
print(f"  最高概率: {max(probs)*100:.1f}%")
print(f"  平均概率: {sum(probs)/len(probs)*100:.1f}%")
print(f"  >=90%: {len([p for p in probs if p >= 0.90])}")
print(f"  >=85%: {len([p for p in probs if p >= 0.85])}")
print(f"  >=80%: {len([p for p in probs if p >= 0.80])}")
print(f"  >=75%: {len([p for p in probs if p >= 0.75])}")
