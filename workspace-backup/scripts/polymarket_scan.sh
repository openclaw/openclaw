#!/bin/bash
# Polymarket 市场扫描脚本
# 使用 curl 直接调用 API，避免 SSL 问题

echo "========================================"
echo "🤖 Polymarket 市场扫描"
echo "========================================"
echo ""

# 测试 API 连接
echo "🔌 测试 API 连接..."
STATUS=$(curl -s https://clob.polymarket.com/)
if [ "$STATUS" = '"OK"' ]; then
    echo "✅ API 连接成功"
else
    echo "❌ API 连接失败"
    exit 1
fi

echo ""
echo "📊 获取服务器时间..."
TIME=$(curl -s https://clob.polymarket.com/time)
echo "   服务器时间: $TIME"

echo ""
echo "📈 获取市场数据..."
MARKETS=$(curl -s https://clob.polymarket.com/simplified-markets)

# 保存市场数据
echo "$MARKETS" > /tmp/polymarket_markets.json

# 统计市场数量
COUNT=$(echo "$MARKETS" | python3 -c "import sys, json; data = json.load(sys.stdin); print(len(data.get('data', [])))" 2>/dev/null || echo "0")

echo "   获取到 $COUNT 个市场"
echo "   数据已保存到: /tmp/polymarket_markets.json"

echo ""
echo "🔍 分析高确定性市场（价格 > 90%）..."
python3 << 'PYTHON_SCRIPT'
import json

with open('/tmp/polymarket_markets.json', 'r') as f:
    data = json.load(f)

markets = data.get('data', [])
opportunities = []

for market in markets[:100]:
    tokens = market.get('tokens', [])
    if len(tokens) < 2:
        continue
    
    yes_token = tokens[0]
    no_token = tokens[1]
    
    try:
        yes_price = float(yes_token.get('price', 0.5))
        no_price = float(no_token.get('price', 0.5))
        
        volume_str = market.get('volume', '0')
        volume = float(volume_str.replace('$', '').replace(',', ''))
        
        # 只关注交易量 > $100K 的市场
        if volume < 100000:
            continue
        
        # 寻找高确定性机会
        if yes_price > 0.90:
            opportunities.append({
                'question': market.get('question', 'Unknown'),
                'outcome': 'YES',
                'price': yes_price,
                'volume': volume,
                'edge': yes_price - 0.5
            })
        elif no_price > 0.90:
            opportunities.append({
                'question': market.get('question', 'Unknown'),
                'outcome': 'NO',
                'price': no_price,
                'volume': volume,
                'edge': no_price - 0.5
            })
    except:
        continue

# 按 edge 排序
opportunities.sort(key=lambda x: x['edge'], reverse=True)

print(f"🎯 发现 {len(opportunities)} 个高确定性机会")
print("")

for i, opp in enumerate(opportunities[:5]):
    print(f"机会 #{i+1}")
    print(f"  市场: {opp['question'][:80]}...")
    print(f"  方向: {opp['outcome']} @ {opp['price']:.2%}")
    print(f"  交易量: ${opp['volume']:,.0f}")
    print(f"  优势: {opp['edge']:.2%}")
    print("")

PYTHON_SCRIPT

echo "========================================"
echo "✅ 扫描完成"
echo "========================================"
echo ""
echo "⚠️  注意："
echo "   要启用自动交易，需要安装 py-clob-client 库"
echo "   命令: pip3 install py-clob-client"
echo ""
echo "   你的钱包地址: 0x3a022c81d06c9c907d6fcc7ddd846083bfc3bd33"
echo "   请确保在 Polygon 链上有 USDC 余额"
