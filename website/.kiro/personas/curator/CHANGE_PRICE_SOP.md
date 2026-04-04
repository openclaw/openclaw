# 課程價格更新 SOP

## 觸發條件

當 Cruz **明確**要求「改課程 X 的價格為 YYY」時，立即執行以下步驟，**不分析、不建議、不多問**。

---

## 執行步驟

### Step 1: 更新 Notion 資料庫

使用 `@notionhq/client` 更新該課程的 4 個價格欄位：
- `group_price` - 小班制定價
- `group_price_early` - 小班制早鳥價
- `single_price` - 一對一定價
- `single_price_early` - 一對一早鳥價

**執行腳本**：`.kiro/scripts/curator/update-notion-pricing.ts`

```bash
pnpm tsx .kiro/scripts/curator/update-notion-pricing.ts \
  --course-id <課程ID> \
  --group <小班價> \
  --group-early <小班早鳥價> \
  --single <一對一價> \
  --single-early <一對一早鳥價>
```

---

### Step 2: 更新定價圖片

#### 2.1 生成新的極簡版定價圖 (600x400px)

使用 Claude 生成新的 SVG，包含更新後的價格。

設計規格：
- 尺寸：600x400px
- 內容：標題 + 方案名稱 + 優惠價 + 節省金額（4 層資訊）
- 字體：價格 64px, 標題 40px, 其他 18-28px
- 顏色：#FF6B6B (紅), #28a745 (綠), #f8f9fa (背景)

#### 2.2 轉換為 PNG

```bash
qlmanage -t -s 1200 -o /tmp <svg檔名>
mv /tmp/<svg檔名>.png ./<輸出檔名>.png
```

#### 2.3 上傳到 Notion

```bash
NOTION_TOKEN=<token> pnpm tsx .kiro/scripts/curator/upload-to-notion.ts \
  <png檔案路徑> \
  <課程的notion_page_id> \
  content_highlight1_image
```

---

### Step 3: 刷新 Curator Memory

```bash
pnpm tsx .kiro/scripts/curator/build-memory-v1.5.ts
```

---

### Step 4: 驗證

1. 等待 60 秒（網站 revalidate 時間）
2. 開啟 `https://www.thinker.cafe/products/<課程ID>` 確認：
   - 定價顯示正確
   - 定價圖片已更新
3. 回報完成

---

## 唯一會停止詢問的情況

只有當發現**明顯錯誤**時才停止：
- 新價格比舊價格低 90% 以上（可能打錯）
- 一對一價格低於團班價格（邏輯錯誤）
- 缺少必要資訊（例如沒說早鳥價要改多少）

---

## 系統架構說明

### 價格資料流向

```
Notion Database (唯一來源)
    ↓ (60秒 revalidate)
Website API (自動同步)
    ↓
前端顯示 (報名表單、訂單頁、Email)
```

### 需要手動更新的位置

✅ **Notion Database** - 4 個價格欄位
✅ **content_highlight1_image** - 定價圖片
✅ **Curator Memory** - 快取

### 自動更新的位置（無需手動處理）

- 課程報名表單 (`app/buy-course/[[...slug]]/BuyCourseForm.js`)
- 訂單卡片 (`app/orders/OrderCard.js`)
- 付款頁面 (`app/order/[order_id]/CreatedOrderForm.js`)
- Email 通知系統
- API 端點

---

## 相關檔案

- 上傳腳本：`.kiro/scripts/curator/upload-to-notion.ts`
- Memory 建構：`.kiro/scripts/curator/build-memory-v1.5.ts`
- Curator Memory：`.kiro/personas/curator/memory.json`
- 價格更新腳本：`.kiro/scripts/curator/update-notion-pricing.ts`（待建立）

---

## 注意事項

1. **Single Source of Truth**：Notion 是唯一的價格來源
2. **不需改程式碼**：所有網站顯示都是動態抓取
3. **圖片需手動生成**：定價圖片不會自動更新
4. **快取時間**：API 60秒、Curator Memory 30分鐘

---

最後更新：2025-11-02
建立者：Claude Code + Curator
