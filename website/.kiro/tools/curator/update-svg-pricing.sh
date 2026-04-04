#!/bin/bash
# 更新 SVG 定價圖
# 使用方式：./update-svg-pricing.sh <target_course_id> [reference_course_id]
#
# 範例：
#   ./update-svg-pricing.sh 4 5
#   將課程 4 的定價圖參照課程 5 的 SVG 模板更新

set -e  # 遇到錯誤立即停止

TARGET_COURSE_ID=$1
REFERENCE_COURSE_ID=${2:-5}  # 預設參考課程 5

if [ -z "$TARGET_COURSE_ID" ]; then
  echo "❌ 錯誤：缺少目標課程 ID"
  echo "使用方式：$0 <target_course_id> [reference_course_id]"
  exit 1
fi

echo "🎯 目標課程：$TARGET_COURSE_ID"
echo "📋 參考課程：$REFERENCE_COURSE_ID"
echo ""

# Step 1: 讀取目標課程資料（使用 jq）
echo "📖 步驟 1：讀取課程 $TARGET_COURSE_ID 的價格資料..."

COURSE_DATA=$(jq -c ".courses[] | select(.course_id == $TARGET_COURSE_ID)" .kiro/personas/curator/memory.json)

if [ -z "$COURSE_DATA" ]; then
  echo "❌ 找不到課程 $TARGET_COURSE_ID"
  exit 1
fi

COURSE_NAME=$(echo "$COURSE_DATA" | jq -r '.zh_name')
GROUP_EARLY=$(echo "$COURSE_DATA" | jq -r '.pricing.group_price_early')
SINGLE_EARLY=$(echo "$COURSE_DATA" | jq -r '.pricing.single_price_early')
GROUP_PRICE=$(echo "$COURSE_DATA" | jq -r '.pricing.group_price')
SINGLE_PRICE=$(echo "$COURSE_DATA" | jq -r '.pricing.single_price')

echo "  課程名稱：$COURSE_NAME"
echo "  小班制早鳥：$GROUP_EARLY 元"
echo "  一對一早鳥：$SINGLE_EARLY 元"
echo ""

# Step 2: 計算節省金額
echo "💰 步驟 2：計算節省金額..."

GROUP_SAVINGS=$((GROUP_PRICE - GROUP_EARLY))
SINGLE_SAVINGS=$((SINGLE_PRICE - SINGLE_EARLY))

echo "  小班制節省：$GROUP_SAVINGS 元"
echo "  一對一節省：$SINGLE_SAVINGS 元"
echo ""

# 安全檢查
if [ $GROUP_SAVINGS -lt 0 ] || [ $SINGLE_SAVINGS -lt 0 ]; then
  echo "❌ 錯誤：節省金額為負數，請檢查價格設定"
  exit 1
fi

# Step 3: 檢查 index mapping
echo "🔍 步驟 3：檢查課程 index..."

INDEX_DATA=$(jq ".highlight_index_mapping.mapping[\"$TARGET_COURSE_ID\"]" .kiro/personas/curator/memory.json)
TARGET_INDEX=$(echo "$INDEX_DATA" | jq -r '.index')

if [ "$TARGET_INDEX" = "null" ] || [ -z "$TARGET_INDEX" ]; then
  echo "❌ 錯誤：課程 $TARGET_COURSE_ID 的 index 尚未確認"
  echo ""
  echo "請執行以下步驟確認 index："
  echo "  1. 啟動本地伺服器：pnpm dev"
  echo "  2. 訪問：http://localhost:3000/products/$TARGET_COURSE_ID"
  echo "  3. 檢查 highlight1 在第幾個位置（0-based）"
  echo "  4. 更新 memory.json 中的 highlight_index_mapping.mapping[\"$TARGET_COURSE_ID\"].index"
  echo ""
  exit 1
fi

echo "  課程 $TARGET_COURSE_ID 的 index：$TARGET_INDEX"
echo ""

# Step 4: 讀取參考 SVG 模板
echo "📋 步驟 4：讀取參考課程的 SVG 模板..."

# 從 HighlightCard.js 提取課程 5 (index === 0) 的 SVG
SVG_TEMPLATE=$(grep -A 20 'const testSVG = index === 0' app/products/[id]/HighlightCard.js | sed -n '/<svg/,/<\/svg>/p' || true)

if [ -z "$SVG_TEMPLATE" ]; then
  echo "❌ 找不到參考 SVG 模板（index === 0）"
  exit 1
fi

echo "  ✅ SVG 模板已讀取"
echo ""

# Step 5: 替換價格數字
echo "🔧 步驟 5：替換價格數字..."

# 格式化節省金額（加入千分位）
GROUP_SAVINGS_FORMATTED=$(printf "%'d" $GROUP_SAVINGS)
SINGLE_SAVINGS_FORMATTED=$(printf "%'d" $SINGLE_SAVINGS)

NEW_SVG="$SVG_TEMPLATE"

# 替換小團班價格（只替換價格數字，不替換 y 座標）
NEW_SVG=$(echo "$NEW_SVG" | sed "s/>590</>$GROUP_EARLY</g")

# 替換一對一價格
NEW_SVG=$(echo "$NEW_SVG" | sed "s/>990</>$SINGLE_EARLY</g")

# 替換節省金額
NEW_SVG=$(echo "$NEW_SVG" | sed "s/>省 890 元</>省 $GROUP_SAVINGS_FORMATTED 元</g")
NEW_SVG=$(echo "$NEW_SVG" | sed "s/>省 1,510 元</>省 $SINGLE_SAVINGS_FORMATTED 元</g")

echo "  ✅ 價格已替換"
echo ""

# Step 6: 輸出結果
echo "✅ 完成！請手動更新 HighlightCard.js"
echo ""
echo "--- 新增以下代碼到 HighlightCard.js ---"
echo ""
echo "const testSVG = index === $TARGET_INDEX ? \`$NEW_SVG\` : null;"
echo ""
echo "--- 或修改現有的 testSVG 判斷邏輯 ---"
echo ""
echo "const testSVG = index === 0 ? \`...\` : index === $TARGET_INDEX ? \`$NEW_SVG\` : null;"
echo ""
echo "📝 下一步："
echo "  1. 更新 app/products/[id]/HighlightCard.js"
echo "  2. 執行 pnpm dev 測試"
echo "  3. 訪問 http://localhost:3000/products/$TARGET_COURSE_ID"
echo ""

# 輸出 JSON 格式供 Claude 讀取
cat > /tmp/curator-svg-update-result.json <<EOF
{
  "success": true,
  "target_course_id": $TARGET_COURSE_ID,
  "target_index": $TARGET_INDEX,
  "course_name": "$COURSE_NAME",
  "pricing": {
    "group_early": $GROUP_EARLY,
    "single_early": $SINGLE_EARLY,
    "group_savings": $GROUP_SAVINGS,
    "single_savings": $SINGLE_SAVINGS
  },
  "svg_code": "const testSVG = index === $TARGET_INDEX ? \\\`$NEW_SVG\\\` : null;",
  "next_steps": [
    "更新 app/products/[id]/HighlightCard.js",
    "執行 pnpm dev 測試",
    "訪問 http://localhost:3000/products/$TARGET_COURSE_ID"
  ]
}
EOF

echo "💾 結果已儲存到 /tmp/curator-svg-update-result.json"
