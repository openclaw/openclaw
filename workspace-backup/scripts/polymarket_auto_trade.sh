#!/bin/bash
# Polymarket 自动交易机器人（Bash 版本）
# 使用 curl 通过代理连接 Polymarket API

set -e

# 配置代理
export http_proxy="http://host.docker.internal:7890"
export https_proxy="http://host.docker.internal:7890"

# API 配置
API_BASE="https://clob.polymarket.com"
WALLET_ADDRESS="0x3a022c81d06c9c907d6fcc7ddd846083bfc3bd33"

# 日志函数
log_info() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $1"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $1"
}

# 主函数
main() {
    log_info "============================================================"
    log_info "🤖 启动 Polymarket 自动交易机器人（Bash 版）"
    log_info "============================================================"
    log_info "   钱包地址: $WALLET_ADDRESS"
    log_info "   API: $API_BASE"
    log_info "   代理: host.docker.internal:7890"
    log_info ""

    # 测试 API 连接
    log_info "🔌 测试 API 连接..."
    if curl -s --max-time 10 "$API_BASE/markets?limit=1" > /dev/null 2>&1; then
        log_info "✅ API 连接成功"
    else
        log_error "❌ API 连接失败"
        exit 1
    fi

    # 获取市场数据
    log_info ""
    log_info "📊 获取市场数据..."
    MARKETS=$(curl -s "$API_BASE/markets?limit=100")
    MARKET_COUNT=$(echo "$MARKETS" | python3 -c "import sys, json; data=json.load(sys.stdin); print(len(data.get('data', [])))")
    log_info "   获取到 $MARKET_COUNT 个市场"

    # 分析市场（寻找高确定性机会）
    log_info ""
    log_info "🔍 分析市场机会..."
    
    # 保存市场数据到文件供后续分析
    echo "$MARKETS" > /tmp/polymarket_markets.json
    
    # 使用 Python 分析
    python3 << 'PYTHON_SCRIPT'
import json
import sys

with open('/tmp/polymarket_markets.json', 'r') as f:
    data = json.load(f)

markets = data.get('data', [])
opportunities = []

for market in markets:
    try:
        tokens = market.get('tokens', [])
        if len(tokens) < 2:
            continue
        
        yes_token = tokens[0]
        no_token = tokens[1]
        
        yes_price = float(yes_token.get('price', 0.5))
        no_price = float(no_token.get('price', 0.5))
        
        volume_str = market.get('volume', '0')
        volume = float(volume_str.replace('$', '').replace(',', ''))
        
        question = market.get('question', 'Unknown')
        
        # 筛选条件：高确定性（>85%）+ 高交易量（>$100K）
        if volume >= 100000:
            if no_price >= 0.85:
                opportunities.append({
                    'question': question,
                    'side': 'NO',
                    'price': no_price,
                    'volume': volume,
                    'confidence': no_price
                })
            elif yes_price >= 0.85:
                opportunities.append({
                    'question': question,
                    'side': 'YES',
                    'price': yes_price,
                    'volume': volume,
                    'confidence': yes_price
                })
    except:
        continue

# 按确定性排序
opportunities.sort(key=lambda x: x['confidence'], reverse=True)

print(f"发现 {len(opportunities)} 个高确定性交易机会")
print("")

if opportunities:
    print("前 5 个最佳机会:")
    for i, opp in enumerate(opportunities[:5]):
        print(f"#{i+1}")
        print(f"  市场: {opp['question'][:60]}...")
        print(f"  方向: {opp['side']} @ {opp['price']:.2%}")
        print(f"  交易量: ${opp['volume']:,.0f}")
        print(f"  确定性: {opp['confidence']:.2%}")
        print("")

PYTHON_SCRIPT

    log_info ""
    log_info "============================================================"
    log_info "✅ 市场扫描完成"
    log_info "============================================================"
    log_info ""
    log_info "⚠️  注意："
    log_info "   Bash 版本目前只支持市场扫描"
    log_info "   要执行自动交易，需要使用 py-clob-client 库"
    log_info "   或者手动在 Polymarket 网站上操作"
    log_info ""
    log_info "📖 详细交易建议见："
    log_info "   docs/POLYMARKET_MANUAL_TRADING.md"
}

main "$@"
