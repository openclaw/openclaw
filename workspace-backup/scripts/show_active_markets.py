#!/usr/bin/env python3
"""
查看接受订单的市场详情
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

print("=" * 80)
print("📊 接受订单的市场详情")
print("=" * 80)
print("")

count = 0
for market in markets:
    if not market.get('accepting_orders', False):
        continue
    
    count += 1
    tokens = market.get('tokens', [])
    
    print(f"市场 #{count}:")
    print(f"  问题: {market.get('question', 'N/A')}")
    
    if len(tokens) >= 2:
        yes_price = float(tokens[0].get('price', 0.5))
        no_price = float(tokens[1].get('price', 0.5))
        print(f"  YES: {yes_price:.2%} | NO: {no_price:.2%}")
        print(f"  确定性: {max(yes_price, no_price):.2%}")
    
    print(f"  接受订单: {market.get('accepting_orders', False)}")
    print(f"  已关闭: {market.get('closed', False)}")
    print(f"  已归档: {market.get('archived', False)}")
    print("")

print(f"总计: {count} 个接受订单的市场")
