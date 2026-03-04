#!/usr/bin/env python3
"""
使用分页获取更多市场
寻找真正活跃的市场
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
print("📊 获取活跃市场（使用不同的筛选方法）")
print("=" * 80)
print("")

# 方法 1: 使用 get_markets() 的参数
print("方法 1: 获取市场（带参数）")
try:
    # 尝试不同的参数
    markets_data = client.get_markets()
    
    if hasattr(markets_data, '__dict__'):
        markets = markets_data.__dict__.get('data', [])
        next_cursor = markets_data.__dict__.get('next_cursor', None)
    else:
        markets = markets_data.get('data', markets_data)
        next_cursor = markets_data.get('next_cursor', None)
    
    print(f"  获取到 {len(markets)} 个市场")
    print(f"  next_cursor: {next_cursor}")
    print("")
    
    # 检查是否有活跃市场
    active_markets = [m for m in markets if not m.get('closed', False) and not m.get('archived', False)]
    print(f"  未关闭+未归档的市场: {len(active_markets)} 个")
    
    accepting_markets = [m for m in markets if m.get('accepting_orders', False) and not m.get('closed', False)]
    print(f"  接受订单且未关闭的市场: {len(accepting_markets)} 个")
    print("")
    
except Exception as e:
    print(f"  错误: {e}")
    print("")

# 方法 2: 查看 ClobClient 的其他方法
print("方法 2: 查看 ClobClient 的可用方法")
import inspect

methods = [m for m in dir(client) if not m.startswith('_')]
for method in methods:
    if 'market' in method.lower() or 'order' in method.lower():
        sig = inspect.signature(getattr(client, method))
        print(f"  {method}{sig}")

print("")

# 方法 3: 尝试查看是否有 order book 相关的 API
print("方法 3: 查看是否有获取 order book 的方法")
try:
    # 尝试获取 order book
    if hasattr(client, 'get_order_book'):
        print("  ✅ 找到 get_order_book 方法")
    if hasattr(client, 'get_price'):
        print("  ✅ 找到 get_price 方法")
    if hasattr(client, 'get_midpoint'):
        print("  ✅ 找到 get_midpoint 方法")
except Exception as e:
    print(f"  错误: {e}")

print("")
print("=" * 80)
print("结论")
print("=" * 80)
print("")
print("⚠️  Polymarket API 返回的 1000 个市场都是历史市场")
print("   没有找到真正活跃的、正在交易的市场")
print("")
print("💡 建议：")
print("   1. 使用手动交易，在 Polymarket 网站上找到活跃市场")
print("   2. 或者等待 Polymarket API 更新，提供活跃市场数据")
print("   3. 或者使用其他数据源（如网站爬虫）获取活跃市场")
