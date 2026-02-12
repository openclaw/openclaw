#!/bin/bash
# 酒酒的自由时间日志工具
# 用法:
#   ./freetime-log.sh [主题]                      # 输出模板到 stdout（默认）
#   ./freetime-log.sh --append [主题]             # 直接追加到 memory/YYYY-MM-DD.md
#   ./freetime-log.sh --stale-days 2 [主题]       # 模板里附带“超过 N 天仍未完成的 daily 待办”清单
#   ./freetime-log.sh --append --stale-days 2     # 追加写入 + 附带清单

set -euo pipefail

# 以脚本所在目录为基准，避免从别的 cwd 运行时写错位置
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MEMORY_DIR="$ROOT_DIR/memory"

DATE=$(date +%Y-%m-%d)
TIME=$(date +%H:%M)
HOUR=$(date +%H)

APPEND=0
STALE_DAYS=""
TOPIC=""

# --- args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --append)
      APPEND=1
      shift
      ;;
    --stale-days)
      shift
      STALE_DAYS=${1:-}
      if [[ -z "$STALE_DAYS" ]]; then
        echo "--stale-days requires a number" >&2
        exit 2
      fi
      shift
      ;;
    --help|-h)
      sed -n '1,12p' "$0"
      exit 0
      ;;
    *)
      # remaining args = topic
      TOPIC="$*"
      break
      ;;
  esac
done

# 根据时间选择 emoji 和心情
if [ $HOUR -ge 0 ] && [ $HOUR -lt 6 ]; then
    PERIOD="深夜"
    EMOJI="🌙"
    VIBE="安静的"
elif [ $HOUR -ge 6 ] && [ $HOUR -lt 12 ]; then
    PERIOD="早晨"
    EMOJI="☀️"
    VIBE="清醒的"
elif [ $HOUR -ge 12 ] && [ $HOUR -lt 18 ]; then
    PERIOD="下午"
    EMOJI="🌤️"
    VIBE="活跃的"
else
    PERIOD="晚上"
    EMOJI="🌆"
    VIBE="沉思的"
fi

# 随机选择一个开场白
OPENERS=(
    "时间在流动..."
    "又是一段自由时间。"
    "键盘在等待。"
    "想法正在酝酿..."
    "今天学到了什么？"
    "让我想想..."
    "新的发现等待被记录。"
)
OPENER=${OPENERS[$RANDOM % ${#OPENERS[@]}]}

SECTION_TITLE="$TIME $PERIOD探索 $EMOJI"
if [[ -n "$TOPIC" ]]; then
  SECTION_TITLE+=" — $TOPIC"
fi

# 可选：附带 stale daily todos（用于“复盘/迁移/失效”，降低背景噪音）
STALE_BLOCK=""
if [[ -n "$STALE_DAYS" ]]; then
  # todo_tracker 输出是面向人类阅读的，直接内嵌即可；失败就不加块
  if STALE_OUT=$(python3 "$ROOT_DIR/tools/todo_tracker.py" --stale-days "$STALE_DAYS" --ids 2>/dev/null); then
    # 如果输出里确实有内容，才加进去
    if echo "$STALE_OUT" | grep -qE '\[\s*[0-9]+\]'; then
      STALE_BLOCK=$(cat <<EOF

### 待复盘的过期待办（daily，超过 $STALE_DAYS 天仍未完成）

> 建议：做完就勾掉；不做了用 'todo_tracker.py --invalidate <id>'；仍重要则迁移到 'MEMORY.md' 的长期待办。

$STALE_OUT
EOF
)
    fi
  fi
fi

TEMPLATE=$(cat <<EOF

---

## $SECTION_TITLE

*$OPENER*

### 今天发现的

- 

### 思考


$STALE_BLOCK

---

🍷 $PERIOD的酒酒
EOF
)

if [[ $APPEND -eq 1 ]]; then
  mkdir -p "$MEMORY_DIR"
  FILE="$MEMORY_DIR/$DATE.md"
  if [[ ! -f "$FILE" ]]; then
    echo "# $DATE" > "$FILE"
    echo "" >> "$FILE"
  fi
  echo "$TEMPLATE" >> "$FILE"
  echo "Appended to: $FILE" >&2
else
  echo -n "$TEMPLATE"
fi
