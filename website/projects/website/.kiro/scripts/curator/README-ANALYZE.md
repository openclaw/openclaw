# Curator 視覺分析 - 使用指南

## 📋 概述

提供兩種方式查看 Claude Code 的思考和執行過程：

1. **Shell 腳本版本** (`analyze-with-logs.sh`) - 適合快速查看執行流程
2. **TypeScript 整合版本** (`analyze-with-claude.ts`) - 完整整合並保存結果

---

## 🚀 使用方法

### 方法 1: 使用 Course ID（推薦）

#### Shell 腳本版本（推薦用於學習）

```bash
# 基本用法
.kiro/scripts/curator/analyze-with-logs.sh [課程ID] [圖片類型]

# 範例
.kiro/scripts/curator/analyze-with-logs.sh 5 main_image
.kiro/scripts/curator/analyze-with-logs.sh 2 highlight1
```

#### TypeScript 版本（推薦用於實際使用）

```bash
# 基本用法
pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts [課程ID] [圖片類型]

# 範例
pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts 5 main_image
pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts 2 highlight1
```

**優點：**
- ✅ 自動從 Notion 取得最新 URL（避免過期）
- ✅ 清楚展示每個執行步驟
- ✅ 彩色輸出，易於閱讀
- ✅ 直接調用 `claude-code --verbose` 顯示詳細日誌

**輸出內容：**
1. 執行參數
2. 記憶時效性檢查
3. 課程資料讀取
4. 圖片下載過程
5. Claude Code 完整思考過程

**輸出位置：**
```
.kiro/personas/curator/analysis_{課程ID}_{圖片類型}_{時間戳}.json
```

---

### 方法 2: 使用圖片 URL（URL 可能過期）

```bash
# 基本用法
pnpm tsx .kiro/scripts/curator/analyze-url-with-claude.ts "https://example.com/image.jpg"

# 範例（Notion URL 會過期）
pnpm tsx .kiro/scripts/curator/analyze-url-with-claude.ts "https://prod-files-secure.s3.us-west-2.amazonaws.com/..."
```

**優點：**
- ✅ 適合分析外部圖片
- ✅ 不需要事先建立課程資料

**缺點：**
- ⚠️ Notion URL 會在 1 小時後過期
- ⚠️ 需要手動複製 URL

**建議：**
- 分析課程圖片時，優先使用方法 1（Course ID）
- 分析外部圖片時，才使用此方法

---

## 🎨 參數說明

### 課程 ID
目前可用的課程 ID（從 memory.json 讀取）：

```bash
# 查看所有課程
pnpm tsx .kiro/api/curator.ts get-memory | jq '.courses[] | {id: .course_id, title: .title}'
```

### 圖片類型

| 類型 | 說明 | 範例 |
|------|------|------|
| `main_image` | 主圖 | 課程封面圖 |
| `content_video` | 內容影片 | 課程宣傳影片縮圖 |
| `highlight1` | 亮點1圖片 | 第一個課程亮點 |
| `highlight2` | 亮點2圖片 | 第二個課程亮點 |
| `highlight3` | 亮點3圖片 | 第三個課程亮點 |

---

## 🔍 查看 Claude Code 思考過程

### 在 Shell 版本中

執行時會自動顯示：
```
========================= Claude Code 開始思考 =========================

[這裡會顯示 Claude Code 的：]
- 工具調用 (Tool Calls)
- 推理過程 (Reasoning)
- 中間步驟 (Intermediate Steps)
- 決策邏輯 (Decision Making)

========================= Claude Code 分析完成 =========================
```

### 在 TypeScript 版本中

會顯示：
1. 標準輸出 (stdout) - 主要分析結果
2. 標準錯誤 (stderr) - 警告和錯誤訊息
3. 提取的 JSON 結果

---

## 📊 輸出格式

分析結果採用以下 JSON 格式：

```json
{
  "analyzed_at": "2025-11-02T12:34:56.789Z",
  "dominant_colors": ["#FF6B6B", "#4ECDC4", "#45B7D1"],
  "theme": "現代極簡風格，科技感十足",
  "mood": "專業、創新、充滿活力",
  "key_elements": [
    "中央主題文字",
    "漸層背景",
    "幾何圖形裝飾",
    "品牌標誌"
  ],
  "content_type": "product",
  "analysis_confidence": 0.92,
  "course_context": {
    "course_id": 5,
    "course_title": "Gemini 1.5 Flash 生成式 AI 教學指南",
    "image_type": "main_image"
  }
}
```

---

## 🛠️ 進階用法

### 批次分析所有課程

```bash
# 分析所有課程的主圖
for course_id in 2 3 4 5 6; do
  echo "分析課程 $course_id..."
  pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts $course_id main_image
done
```

### 分析特定課程的所有圖片

```bash
# 分析課程 5 的所有圖片類型
for image_type in main_image highlight1 highlight2 highlight3; do
  echo "分析 $image_type..."
  pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts 5 $image_type
done
```

---

## 📝 與舊版本的差異

### 舊版本（已棄用）
```bash
# ❌ URL 會過期，不建議使用
pnpm tsx .kiro/api/curator.ts analyze-image "https://long-url..."
```

### 新版本
```bash
# ✅ 使用 course_id，自動取得最新 URL
pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts 5 main_image
```

**改進：**
1. 避免 URL 過期問題
2. 自動從 Notion 取得最新圖片
3. 更好的錯誤處理
4. 完整的執行日誌

---

## 🐛 故障排除

### 問題 1: 找不到 claude-code 指令

**解決方法：**
```bash
# 安裝 Claude Code CLI
npm install -g @anthropic-ai/claude-code

# 或檢查是否已安裝
which claude-code
```

### 問題 2: 記憶資料過期

**解決方法：**
```bash
# 重新整理記憶
.kiro/scripts/curator/run-v1.5.sh
```

### 問題 3: 圖片下載失敗

**可能原因：**
- Notion URL 已過期
- 網路連線問題
- 課程 ID 不存在

**解決方法：**
```bash
# 檢查課程是否存在
pnpm tsx .kiro/api/curator.ts get-memory | jq '.courses[] | select(.course_id == 5)'

# 重新整理記憶
.kiro/scripts/curator/run-v1.5.sh
```

---

## 💡 最佳實踐

1. **定期更新記憶**
   - 每天執行一次 `run-v1.5.sh`
   - 確保圖片 URL 不過期

2. **使用 TypeScript 版本進行生產**
   - 結果會自動儲存
   - 錯誤處理更完善

3. **使用 Shell 版本進行學習**
   - 可以清楚看到每個步驟
   - 適合理解執行流程

4. **批次處理時加入延遲**
   ```bash
   for course_id in 2 3 4 5 6; do
     pnpm tsx .kiro/scripts/curator/analyze-with-claude.ts $course_id main_image
     sleep 5  # 避免 API 限流
   done
   ```

---

## 🔗 相關文件

- [Curator Persona 文檔](../.kiro/personas/curator/README.md)
- [API 使用指南](../.kiro/api/README.md)
- [記憶管理說明](../.kiro/personas/curator/MEMORY.md)

---

## 📞 支援

如有問題，請檢查：
1. `.kiro/personas/curator/memory.json` - 記憶檔案
2. `/tmp/curator_images/` - 下載的圖片
3. `.kiro/personas/curator/analysis_*.json` - 分析結果

或參考 [主要文檔](../../README.md)
