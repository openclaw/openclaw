#!/usr/bin/env python3
"""
Polymarket 消息面狙击系统（轻量版）
完全基于 curl，不依赖任何 Python 包
"""

import os
import sys
import json
import subprocess
from datetime import datetime

# 配置
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

# 交易参数
MIN_PROBABILITY = 0.90  # 恢复 90%（80% 会捕捉到大量噪音）
TRADE_AMOUNT = 5.0
MAX_POSITIONS = 3

def curl_get(url, params=None):
    """使用 curl 发送 GET 请求"""
    cmd = ['curl', '-s', '-m', '60', '--noproxy', '*']  # 绕过代理直接访问
    
    if params:
        param_str = '&'.join([f"{k}={v}" for k, v in params.items()])
        url = f"{url}?{param_str}"
    
    cmd.append(url)
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=65)
        if result.returncode == 0:
            try:
                data = json.loads(result.stdout)
                return data
            except json.JSONDecodeError as e:
                print(f"❌ JSON 解析失败: {e}")
                print(f"   响应内容（前200字符）: {result.stdout[:200]}")
                return None
        else:
            print(f"❌ curl 失败 (返回码 {result.returncode}): {result.stderr}")
            return None
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return None

def get_active_markets(limit=100):
    """获取活跃市场"""
    print(f"🔍 获取活跃市场（limit={limit}）...")
    
    markets = curl_get(f"{GAMMA_API}/markets", {
        'active': 'true',
        'closed': 'false',
        'limit': str(limit)
    })
    
    if not markets:
        print("❌ 无法获取市场数据")
        return []
    
    print(f"✅ 获取 {len(markets)} 个市场")
    return markets

def find_opportunities(markets):
    """寻找高概率机会"""
    print(f"\n🎯 寻找高概率机会（>={int(MIN_PROBABILITY*100)}%）...")
    
    opportunities = []
    for market in markets:
        if not market.get('acceptingOrders', False):
            continue
        
        # 解析 clobTokenIds（可能是字符串或数组）
        tokens = market.get('clobTokenIds', [])
        if isinstance(tokens, str):
            try:
                tokens = json.loads(tokens)
            except:
                continue
        
        if len(tokens) != 2:
            continue
        
        # 解析 outcomePrices（可能是字符串或数组）
        prices = market.get('outcomePrices', [])
        if isinstance(prices, str):
            try:
                prices = json.loads(prices)
            except:
                continue
        
        if len(prices) != 2:
            continue
        
        # 检查 Yes 概率
        try:
            yes_price = float(prices[0])
            if yes_price >= MIN_PROBABILITY:
                opportunities.append({
                    'question': market.get('question'),
                    'token_id': tokens[0],
                    'probability': yes_price,
                    'volume': market.get('volume', 0)
                })
        except:
            pass
        
        # 检查 No 概率
        try:
            no_price = float(prices[1])
            if no_price >= MIN_PROBABILITY:
                opportunities.append({
                    'question': market.get('question'),
                    'token_id': tokens[1],
                    'probability': no_price,
                    'volume': market.get('volume', 0)
                })
        except:
            pass
    
    # 按概率排序
    opportunities.sort(key=lambda x: x['probability'], reverse=True)
    
    print(f"✅ 找到 {len(opportunities)} 个机会")
    return opportunities

def check_balance():
    """检查余额（简化版，只检查 API 连接）"""
    print("\n💰 检查账户状态...")
    # 由于无法查询链上余额，只能提示用户
    print("⚠️  无法查询链上余额")
    print("   请确保钱包有足够的 USDC（> 6 USDC）")
    return 0.0

def main():
    print("=" * 60)
    print(f"🎯 Polymarket 消息面狙击 - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)
    
    # 1. 检查余额
    balance = check_balance()
    
    # 2. 获取活跃市场
    markets = get_active_markets(limit=100)
    if not markets:
        print("\n❌ 无可用市场，退出")
        return
    
    # 3. 寻找机会
    opportunities = find_opportunities(markets)
    
    if not opportunities:
        print("\n⚠️  未找到符合条件的交易机会")
        return
    
    # 4. 显示前 5 个机会
    print("\n🏆 Top 5 机会：")
    for i, opp in enumerate(opportunities[:5], 1):
        print(f"   {i}. {opp['probability']*100:.1f}% - {opp['question'][:60]}...")
        try:
            volume = float(opp['volume'])
            print(f"      Volume: ${volume:,.0f}")
        except:
            print(f"      Volume: {opp['volume']}")
    
    # 5. 提醒充值
    if balance < 6:
        print("\n⚠️  USDC 余额不足，需要充值")
        print("   充值地址: 0x50286FB018bf51F3ceb10aA2a187372B910041b7")
        print("   推荐金额: 20-50 USDC")
    
    print("\n✅ 任务完成")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  用户中断")
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
