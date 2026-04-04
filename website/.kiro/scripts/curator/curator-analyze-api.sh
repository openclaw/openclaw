#!/bin/bash

# Curator 分析 API
#
# 用法:
#   ./curator-analyze-api.sh <course_id>
#
# 輸出: 純 JSON (stdout)
# 日誌: stderr
#
# 範例:
#   # 直接獲取 JSON
#   ./curator-analyze-api.sh 5
#
#   # 存成檔案
#   ./curator-analyze-api.sh 5 > result.json
#
#   # 用 jq 處理
#   ./curator-analyze-api.sh 5 | jq '.images[0].analysis'
#
#   # 當作 API 使用
#   RESULT=$(./curator-analyze-api.sh 5)
#   echo $RESULT | jq '.total_images'

set -e

COURSE_ID=${1:-5}

# 所有訊息輸出到 stderr，只有最終 JSON 輸出到 stdout
exec 3>&1  # 保存 stdout
exec 1>&2  # 重定向 stdout 到 stderr

echo "🤖 Curator 分析 API"
echo "課程 ID: $COURSE_ID"
echo ""

# 讀取課程資料
COURSE_DATA=$(pnpm tsx .kiro/api/curator.ts get-memory | jq ".courses[] | select(.course_id == $COURSE_ID)")

if [ -z "$COURSE_DATA" ]; then
  echo "❌ 找不到課程 ${COURSE_ID}"
  exit 1
fi

COURSE_TITLE=$(echo "$COURSE_DATA" | jq -r '.zh_name')
echo "📚 課程: $COURSE_TITLE"
echo ""

# 準備提示詞
read -r -d '' PROMPT << EOM || true
Hi 我是 Cruz

# 你是誰
你是 Curator（商品策展人），負責分析網站課程的視覺內容。

# 你的記憶
$(cat .kiro/personas/curator/memory.json | jq ".courses[] | select(.course_id == $COURSE_ID)")

# 你的任務
請分析課程 ${COURSE_ID}「${COURSE_TITLE}」的**所有圖片**。

## 執行步驟
1. 從記憶中列出所有圖片類型（main_image, content_video, highlight1-6）
2. 對每張圖片：
   a. 使用 Bash: \`pnpm tsx .kiro/api/curator.ts analyze-image ${COURSE_ID} <type>\`
   b. 從 JSON 輸出取得 \`_downloaded_path\`
   c. 使用 Read tool 讀取該路徑的圖片
   d. 分析視覺內容

## 分析要點
- **dominant_colors**: 3-5 個主色調（Hex）
- **theme**: 設計風格（例如：現代、科技、溫暖）
- **mood**: 情緒氛圍（例如：專業、活力、沉穩）
- **key_elements**: 3-5 個關鍵元素（例如：文字、圖標、人物）
- **content_type**: product/highlight/banner/video/icon
- **confidence**: 0-1 之間的信心度

## 輸出要求（重要！）
**你必須只輸出 JSON，不要有任何其他文字、說明或 markdown 標記。**

直接輸出以下格式的 JSON：

{
  "course_id": ${COURSE_ID},
  "course_title": "${COURSE_TITLE}",
  "analyzed_at": "ISO時間",
  "total_images": 8,
  "images": [
    {
      "type": "main_image",
      "title": "課程主圖",
      "downloaded_path": "/tmp/...",
      "analysis": {
        "dominant_colors": ["#RRGGBB"],
        "theme": "設計風格描述",
        "mood": "情緒描述",
        "key_elements": ["元素1", "元素2"],
        "content_type": "product",
        "confidence": 0.95
      }
    }
  ]
}

# 權限設定

## ✅ 你可以做的事
- 讀取任何檔案（Read tool）
- 執行 pnpm tsx .kiro/api/curator.ts 相關指令
- 讀取圖片並分析
- 輸出純 JSON 結果

## ❌ 你絕對不能做的事
- 修改任何網站原始碼（src/, app/, components/, lib/, public/）
- 修改 package.json, tsconfig.json, next.config.js
- 執行 git 操作
- 修改 .env 或其他設定檔
- 刪除任何檔案
- 執行 npm/pnpm install

## 執行指示
- 直接開始執行，不需要詢問授權
- 遇到錯誤請在 JSON 中記錄錯誤資訊
- 完成後只輸出 JSON，不要有其他文字
EOM

echo "🚀 執行中..."
echo ""

# 執行 Curator，輸出到臨時檔案
TEMP_OUTPUT=$(mktemp)
claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  -p \
  > "$TEMP_OUTPUT" 2>&1

# 檢查輸出
if [ -s "$TEMP_OUTPUT" ]; then
  # 嘗試驗證 JSON
  if cat "$TEMP_OUTPUT" | jq empty 2>/dev/null; then
    echo "✅ 分析完成！"
    echo ""

    # 輸出純 JSON 到原始的 stdout (fd 3)
    cat "$TEMP_OUTPUT" >&3
  else
    echo "⚠️  輸出不是有效的 JSON"
    echo ""
    echo "原始輸出:"
    cat "$TEMP_OUTPUT"

    # 嘗試提取 JSON
    if grep -q '{' "$TEMP_OUTPUT"; then
      echo ""
      echo "嘗試提取 JSON..."
      sed -n '/{/,/}/p' "$TEMP_OUTPUT" | jq '.' >&3 2>/dev/null || {
        echo "無法提取有效 JSON"
        exit 1
      }
    else
      exit 1
    fi
  fi
else
  echo "❌ 無輸出"
  exit 1
fi

# 清理
rm -f "$TEMP_OUTPUT"
