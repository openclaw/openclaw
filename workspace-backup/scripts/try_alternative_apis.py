#!/usr/bin/env python3
"""
尝试使用不同的 API 方法获取活跃市场
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

print("=" * 80)
print("📊 尝试不同的 API 方法")
print("=" * 80)
print("")

# 方法 1: get_simplified_markets
print("方法 1: get_simplified_markets()")
try:
    simplified_markets = client.get_simplified_markets()
    print(f"  ✅ 成功获取: {type(simplified_markets)}")
    
    if hasattr(simplified_markets, '__dict__'):
        data = simplified_markets.__dict__
    else:
        data = simplified_markets
    
    print(f"  数据结构: {data.keys() if isinstance(data, dict) else type(data)}")
    
    if isinstance(data, dict) and 'data' in data:
        markets = data['data']
        print(f"  市场数量: {len(markets)}")
        
        if markets and len(markets) > 0:
            print(f"  第一个市场: {markets[0]}")
    
except Exception as e:
    print(f"  ❌ 错误: {e}")

print("")

# 方法 2: get_sampling_markets
print("方法 2: get_sampling_markets()")
try:
    sampling_markets = client.get_sampling_markets()
    print(f"  ✅ 成功获取: {type(sampling_markets)}")
    
    if hasattr(sampling_markets, '__dict__'):
        data = sampling_markets.__dict__
    else:
        data = sampling_markets
    
    print(f"  数据结构: {data.keys() if isinstance(data, dict) else type(data)}")
    
    if isinstance(data, dict) and 'data' in data:
        markets = data['data']
        print(f"  市场数量: {len(markets)}")
        
        if markets and len(markets) > 0:
            print(f"  第一个市场: {markets[0]}")
    
except Exception as e:
    print(f"  ❌ 错误: {e}")

print("")
print("=" * 80)
print("💡 下一步")
print("=" * 80)
print("")
print("如果以上方法仍然返回历史市场，建议：")
print("1. 使用手动交易（访问 Polymarket 网站）")
print("2. 或者研究 Polymarket 的 Gamma API（可能提供活跃市场）")
print("3. 或者使用网站爬虫获取活跃市场数据")
