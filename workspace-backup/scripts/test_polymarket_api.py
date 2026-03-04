#!/usr/bin/env python3
"""
Polymarket API 测试脚本
测试不同的代理配置方法
"""

import os
import sys

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 设置代理环境变量（必须在导入 py_clob_client 之前）
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds

print("=" * 60)
print("🧪 测试 Polymarket API 连接")
print("=" * 60)
print("代理: http://host.docker.internal:7890")
print("")

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

print("✅ 客户端初始化成功")
print("")

# 测试获取市场
print("🔍 测试获取市场...")
try:
    markets = client.get_markets()
    print(f"✅ 获取市场成功")
    print(f"   类型: {type(markets)}")
    print(f"   长度: {len(markets) if hasattr(markets, '__len__') else 'N/A'}")
    
    if markets:
        print("\n市场数据结构:")
        print(f"  Keys: {markets.keys() if isinstance(markets, dict) else 'N/A'}")
        print(f"  第一个元素: {list(markets.values())[0] if isinstance(markets, dict) else markets}")
    
except Exception as e:
    print(f"❌ 获取市场失败: {e}")
    print(f"   错误类型: {type(e).__name__}")
    
    # 尝试打印更详细的错误信息
    import traceback
    print("\n详细错误:")
    traceback.print_exc()

print("\n" + "=" * 60)
print("测试完成")
print("=" * 60)
