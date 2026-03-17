#!/bin/bash
# 幣塔記憶塔 — 全自動拉取 + 下載截圖
# 用法:
#   bash pull-all.sh          # 拉一輪（8群各一批）
#   bash pull-all.sh --full   # 拉到底（全部拉完）

set -uo pipefail
export LANG=en_US.UTF-8
CD="$(cd "$(dirname "$0")" && pwd)"
PY="python3 $CD/extract.py"
LOG="$CD/pull-all.log"

full_mode=false
[[ "${1:-}" == "--full" ]] && full_mode=true

total_pulled=0
total_downloaded=0

echo "$(date '+%Y-%m-%d %H:%M:%S') start" | tee -a "$LOG"

# Ensure scan is done
if [[ ! -f "$CD/state.json" ]]; then
    $PY scan 2>&1
fi

pull_group() {
    local g="$1"
    local output
    output=$($PY pull "$g" 50 2>&1) || true

    if echo "$output" | grep -q "fully consumed"; then
        return 1
    fi
    if echo "$output" | grep -q "no more messages"; then
        return 1
    fi

    if echo "$output" | grep -q "batch"; then
        total_pulled=$((total_pulled + 1))
        echo "$output" | head -3

        # Get batch number
        local bn
        bn=$(echo "$output" | sed -n 's/.*batch \([0-9][0-9]*\):.*/\1/p' | head -1)
        if [[ -n "$bn" ]]; then
            local dl
            dl=$($PY download "batch:$g:$bn" 2>&1) || true
            local dc
            dc=$(echo "$dl" | sed -n 's/.*Downloaded \([0-9][0-9]*\).*/\1/p' | head -1)
            dc=${dc:-0}
            total_downloaded=$((total_downloaded + dc))
            echo "  dl: $dc media"
        fi
        return 0
    fi
    return 1
}

run_one_round() {
    local any=false
    for g in QQ 周 子 俊 兔 葦 茂 管理群; do
        if pull_group "$g"; then
            any=true
        fi
    done
    $any
}

if $full_mode; then
    echo "full mode"
    round=0
    while run_one_round; do
        round=$((round + 1))
        echo "--- round $round done (pulled=$total_pulled dl=$total_downloaded) ---"
        sleep 1
    done
else
    run_one_round || true
fi

echo ""
echo "$(date '+%Y-%m-%d %H:%M:%S') done: pulled=$total_pulled downloaded=$total_downloaded" | tee -a "$LOG"
$PY status
