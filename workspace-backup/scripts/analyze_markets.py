#!/usr/bin/env python3
"""
Polymarket 市场统计脚本
统计不同类型的市场数量
"""

import os
import sys

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 设置代理环境变量
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

# 初始化客户端
creds = ApiCreds(
    api_key="019ca868-faf6-7262-af1b-1002b75662ec",
    api_secret="4qRAvb-eaklXmsYTkZiVmh81F6k8RIU5c_XX29i_6F4=",
    api_passphrase="eda754c9cf94e382f13844919ce80193522fd383c2d1746cc219c91129a7aad9"
)

client = ClobClient(
    host="https://clob.polymarket.com",
    creds=creds,
    chain_id=137
)

# 获取市场
markets_data = client.get_markets()
if hasattr(markets_data, '__dict__'):
    markets = markets_data.__dict__.get('data', [])
else:
    markets = markets_data.get('data', markets_data)

print(f"总市场数: {len(markets)}")
print("")

# 统计不同类型的市场
closed_count = 0
archived_count = 0
accepting_orders_count = 0
active_count = 0

price_distribution = {
    '0.0-0.2': 0,
    '0.2-0.4': 0,
    '0.4-0.6': 0,
    '0.6-0.8': 0,
    '0.8-0.9': 0,
    '0.9-0.95': 0,
    '0.95-0.99': 0,
    '0.99-1.0': 0,
    'determined (0 or 1)': 0
}

for market in markets:
    if market.get('closed', False):
        closed_count += 1
    if market.get('archived', False):
        archived_count += 1
    if market.get('accepting_orders', False):
        accepting_orders_count += 1
    if market.get('active', False):
        active_count += 1
    
    # 统计价格分布
    tokens = market.get('tokens', [])
    if len(tokens) >= 2:
        yes_price = float(tokens[0].get('price', 0.5))
        
        if yes_price in [0.0, 1.0]:
            price_distribution['determined (0 or 1)'] += 1
        elif yes_price >= 0.99:
            price_distribution['0.99-1.0'] += 1
        elif yes_price >= 0.95:
            price_distribution['0.95-0.99'] += 1
        elif yes_price >= 0.9:
            price_distribution['0.9-0.95'] += 1
        elif yes_price >= 0.8:
            price_distribution['0.8-0.9'] += 1
        elif yes_price >= 0.6:
            price_distribution['0.6-0.8'] += 1
        elif yes_price >= 0.4:
            price_distribution['0.4-0.6'] += 1
        elif yes_price >= 0.2:
            price_distribution['0.2-0.4'] += 1
        else:
            price_distribution['0.0-0.2'] += 1

print("市场状态统计:")
print(f"  已关闭: {closed_count}")
print(f"  已归档: {archived_count}")
print(f"  接受订单: {accepting_orders_count}")
print(f"  活跃: {active_count}")
print("")

print("价格分布（YES 价格）:")
for range_name, count in price_distribution.items():
    print(f"  {range_name}: {count}")
print("")

# 查找活跃且有高确定性的市场
print("查找符合条件的活跃市场:")
print("  条件：accepting_orders=True + 价格在 0.8-0.99 之间")
print("")

found_markets = []
for market in markets:
    if not market.get('accepting_orders', False):
        continue
    
    tokens = market.get('tokens', [])
    if len(tokens) < 2:
        continue
    
    yes_price = float(tokens[0].get('price', 0.5))
    no_price = float(tokens[1].get('price', 0.5))
    
    # 检查是否有高确定性
    if (0.8 <= yes_price <= 0.99) or (0.8 <= no_price <= 0.99):
        found_markets.append({
            'question': market.get('question', 'N/A'),
            'yes_price': yes_price,
            'no_price': no_price
        })

print(f"找到 {len(found_markets)} 个符合条件的活跃市场")
print("")

if found_markets:
    print("前 10 个:")
    for i, m in enumerate(found_markets[:10]):
        print(f"  #{i+1}: {m['question'][:50]}...")
        print(f"       YES: {m['yes_price']:.2%} | NO: {m['no_price']:.2%}")
