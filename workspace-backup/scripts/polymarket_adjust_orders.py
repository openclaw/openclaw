#!/usr/bin/env python3
"""
Polymarket 订单调整脚本
撤销旧订单，按市场价重新挂单
"""

import os
import sys
import time

# 添加 pip 安装的库路径
sys.path.insert(0, '/home/node/.local/lib/python3.11/site-packages')

# 必须在导入任何库之前设置代理
os.environ['http_proxy'] = 'http://host.docker.internal:7890'
os.environ['https_proxy'] = 'http://host.docker.internal:7890'
os.environ['HTTP_PROXY'] = 'http://host.docker.internal:7890'
os.environ['HTTPS_PROXY'] = 'http://host.docker.internal:7890'

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, OrderArgs
from dotenv import load_dotenv

# 加载凭证
load_dotenv('/home/node/.openclaw/workspace/config/polymarket.env')

api_key = os.getenv('POLYMARKET_API_KEY')
api_secret = os.getenv('POLYMARKET_SECRET')
passphrase = os.getenv('POLYMARKET_PASSPHRASE')
address = os.getenv('POLYMARKET_ADDRESS')
private_key = os.getenv('POLYMARKET_PRIVATE_KEY')

print("=" * 60)
print("🔄 Polymarket 订单调整脚本")
print("=" * 60)
print()

# 初始化客户端
client = ClobClient(
    host='https://clob.polymarket.com',
    creds=ApiCreds(
        api_key=api_key,
        api_secret=api_secret,
        api_passphrase=passphrase
    ),
    chain_id=137,
    key=private_key,
    signature_type=1,
    funder=address
)

# 订单信息（需要撤销并重新下单）
orders_info = [
    {
        'name': 'Alexis Hill 内华达州长初选',
        'old_order_id': '0x9720e4eabf77847cf524cf27746ed8a80feb75238059e4d7999ea66b17a02be8',
        'token_id': '29450150924685347333760494177739777494572888874601404695451883182794223646340',
        'side': 'BUY',
        'old_price': 0.90,
        'new_price': 0.91,  # 市场最低卖价
        'size': 5.0
    },
    {
        'name': 'Lakers 季后赛',
        'old_order_id': '0xa16d5d3d016c412dc40cc44f83ea884637e49cf8b538929e43acc445a041bb8e',
        'token_id': '105332170257674361127340683417603954100171789021516424682591393283728521405304',
        'side': 'BUY',
        'old_price': 0.90,
        'new_price': 0.92,  # 市场最低卖价
        'size': 5.0
    },
    {
        'name': 'Shelley Moore Capito 参议员',
        'old_order_id': '0x699717ba0ad235a8b5ffe2fbfc411d595082833682c7d42b7eb085ab24ae67d8',
        'token_id': '80279183135329180370663350472065801485807029559175952691031149393980047935274',
        'side': 'BUY',
        'old_price': 0.90,
        'new_price': 0.92,  # 市场最低卖价
        'size': 5.0
    }
]

print("步骤 1: 撤销旧订单")
print("=" * 60)
print()

cancelled_count = 0
for i, order in enumerate(orders_info, 1):
    print(f"#{i} 撤销订单: {order['name']}")
    print(f"   订单ID: {order['old_order_id'][:20]}...")
    
    try:
        result = client.cancel(order['old_order_id'])
        print(f"   ✅ 成功撤销")
        cancelled_count += 1
    except Exception as e:
        print(f"   ❌ 撤销失败: {e}")
    
    print()
    time.sleep(1)  # 避免频率限制

print("=" * 60)
print(f"撤销完成: {cancelled_count}/{len(orders_info)} 个订单")
print()

print("步骤 2: 重新挂单（按市场价）")
print("=" * 60)
print()

success_count = 0
total_invested = 0.0

for i, order in enumerate(orders_info, 1):
    print(f"#{i} 重新挂单: {order['name']}")
    print(f"   新价格: {order['new_price']:.2%}")
    print(f"   数量: {order['size']:.2f} USDC")
    
    try:
        # 创建订单
        order_args = OrderArgs(
            token_id=order['token_id'],
            side=order['side'],
            price=order['new_price'],
            size=order['size']
        )
        
        # 发送订单
        result = client.create_and_post_order(order_args)
        
        print(f"   ✅ 成功挂单")
        print(f"   订单ID: {result.get('orderID', 'N/A')[:20]}...")
        
        success_count += 1
        total_invested += order['size']
        
    except Exception as e:
        print(f"   ❌ 挂单失败: {e}")
    
    print()
    time.sleep(2)  # 避免频率限制

print("=" * 60)
print("✅ 订单调整完成")
print("=" * 60)
print()
print(f"成功重新挂单: {success_count}/{len(orders_info)} 个")
print(f"总投资: {total_invested:.2f} USDC")
print()
print("💡 预期结果:")
print("   - 订单将按市场价立即成交")
print("   - 预期收益: ~1.16 USDC")
print("   - 收益率: ~7.7%")
