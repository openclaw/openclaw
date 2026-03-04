#!/usr/bin/env python3
"""
Polymarket 市场数据调试脚本
查看市场数据的实际结构
"""

import os
import sys
import json

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

print("=" * 60)
print("📊 获取市场数据")
print("=" * 60)

# 获取市场
markets_data = client.get_markets()

# 转换为字典
if hasattr(markets_data, '__dict__'):
    markets_dict = markets_data.__dict__
else:
    markets_dict = markets_data

# 提取市场列表
if 'data' in markets_dict:
    markets = markets_dict['data']
else:
    markets = markets_dict

print(f"总市场数: {len(markets)}")
print("")

# 查看前 3 个市场的详细数据
print("前 3 个市场详细数据:")
print("")

for i, market in enumerate(markets[:3]):
    print(f"市场 #{i+1}:")
    print(f"  类型: {type(market)}")
    
    if isinstance(market, dict):
        print(f"  Keys: {market.keys()}")
        print(f"  问题: {market.get('question', 'N/A')[:60]}")
        print(f"  volume: {market.get('volume', 'N/A')}")
        
        tokens = market.get('tokens', [])
        print(f"  tokens 类型: {type(tokens)}")
        if tokens:
            print(f"  tokens[0]: {tokens[0]}")
    else:
        print(f"  属性: {dir(market)[:10]}")
    
    print("")

# 查找包含价格信息的字段
print("=" * 60)
print("查找价格字段")
print("=" * 60)

first_market = markets[0]
if isinstance(first_market, dict):
    for key, value in first_market.items():
        if 'price' in key.lower() or 'prob' in key.lower() or 'token' in key.lower():
            print(f"  {key}: {value}")
