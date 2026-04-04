#!/bin/bash

# Curator 視覺分析 - 帶詳細日誌版本
# 用途：展示完整的 Claude Code 思考與執行過程

set -e  # 遇到錯誤立即停止

# 顏色設定
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 參數
COURSE_ID=${1:-5}  # 預設課程 5
IMAGE_TYPE=${2:-main_image}  # 預設主圖

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}📸 Curator 視覺分析 (詳細日誌模式)${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Step 1: 顯示執行參數
echo -e "${BLUE}[1/5] 📋 執行參數${NC}"
echo "  課程 ID: $COURSE_ID"
echo "  圖片類型: $IMAGE_TYPE"
echo ""

# Step 2: 檢查記憶時效性
echo -e "${BLUE}[2/5] 🧠 檢查記憶時效性${NC}"
echo -e "${YELLOW}執行命令: pnpm tsx .kiro/api/curator.ts check-freshness${NC}"
FRESHNESS=$(pnpm tsx .kiro/api/curator.ts check-freshness)
echo "$FRESHNESS"
echo ""

# Step 3: 讀取課程資料
echo -e "${BLUE}[3/5] 📚 讀取課程資料${NC}"
echo -e "${YELLOW}執行命令: pnpm tsx .kiro/api/curator.ts get-memory | jq '.courses[] | select(.course_id == $COURSE_ID)'${NC}"
COURSE_DATA=$(pnpm tsx .kiro/api/curator.ts get-memory | jq ".courses[] | select(.course_id == $COURSE_ID)")
echo "$COURSE_DATA"
echo ""

# Step 4: 下載並準備圖片
echo -e "${BLUE}[4/5] 📥 下載圖片${NC}"
echo -e "${YELLOW}執行命令: pnpm tsx .kiro/api/curator.ts analyze-image $COURSE_ID $IMAGE_TYPE${NC}"
DOWNLOAD_RESULT=$(pnpm tsx .kiro/api/curator.ts analyze-image "$COURSE_ID" "$IMAGE_TYPE")
echo "$DOWNLOAD_RESULT"

# 提取下載路徑
IMAGE_PATH=$(echo "$DOWNLOAD_RESULT" | jq -r '._downloaded_path')
echo ""
echo -e "${GREEN}✓ 圖片已下載至: $IMAGE_PATH${NC}"
echo ""

# Step 5: 調用 Claude Code 分析
echo -e "${BLUE}[5/5] 🤖 調用 Claude Code 進行視覺分析${NC}"
echo ""
echo -e "${YELLOW}========================= Claude Code 開始思考 =========================${NC}"
echo ""

# 這裡可以看到 Claude Code 的實際執行過程
# 使用 --verbose 模式顯示詳細日誌
claude-code --verbose << EOF
請幫我分析這張圖片：$IMAGE_PATH

請從以下角度分析：
1. 主色調 (dominant_colors)
2. 設計風格/主題 (theme)
3. 傳達的情緒/氛圍 (mood)
4. 關鍵視覺元素 (key_elements)
5. 內容類型 (content_type: product/highlight/banner/video/icon)
6. 分析信心度 (analysis_confidence: 0-1)

請用 JSON 格式輸出結果。
EOF

echo ""
echo -e "${YELLOW}========================= Claude Code 分析完成 =========================${NC}"
echo ""

echo -e "${GREEN}✓ 分析完成！${NC}"
echo ""
echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}💡 說明：${NC}"
echo "  1. 使用 --verbose 可以看到 Claude Code 的思考過程"
echo "  2. 包含工具調用、推理步驟、決策邏輯等"
echo "  3. 圖片路徑: $IMAGE_PATH"
echo -e "${CYAN}========================================${NC}"
