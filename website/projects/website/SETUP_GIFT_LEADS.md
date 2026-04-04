# Gift Leads Email Collection Setup

## 設定步驟

### 1. 在 Supabase 執行 Migration

**IMPORTANT**: 如果之前執行過舊的 migration，請使用最新的修復版本：

#### 選項 A: 全新安裝（推薦）

前往 Supabase Dashboard → SQL Editor，複製並執行：
```
supabase/migrations/20251108120002_final_gift_leads_rls_fix.sql
```

這個 migration 會：
- 完全重置所有 RLS policies
- 建立正確的 anon role INSERT policy
- 自動驗證設定是否成功

#### 選項 B: 原始安裝（僅限未執行過任何 migration）

```sql
-- 複製 supabase/migrations/20251108120000_create_gift_leads_table.sql 的內容
```

執行後，你應該會在 **Messages** 看到：

```
===== VERIFICATION RESULTS =====
Total policies created: 3
Anon INSERT policies: 1
✅ RLS policies successfully configured!
================================
```

**如果沒看到這個訊息，請聯繫技術支援！**

### 2. 驗證資料表建立成功

在 Supabase Dashboard → Table Editor，應該會看到 `gift_leads` 資料表，包含以下欄位：

- `id` (UUID, Primary Key)
- `email` (TEXT)
- `gift_type` (TEXT)
- `completed_prompts` (INTEGER)
- `password` (TEXT)
- `source` (TEXT)
- `created_at` (TIMESTAMP)
- `updated_at` (TIMESTAMP)

### 3. 測試 API Endpoint

```bash
# 測試 POST 提交 Email
curl -X POST http://localhost:3000/api/gift-leads \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "gift_type": "efficiency",
    "completed_prompts": 1,
    "password": "CRUZ2025",
    "source": "fb-ad-jan"
  }'

# 預期回應
{
  "success": true,
  "message": "Email saved successfully",
  "data": {
    "id": "uuid...",
    "email": "test@example.com"
  }
}
```

### 4. 測試禮包頁面

1. 訪問禮包頁面：
   ```
   http://localhost:3000/ai/templates/gift_CRUZ2025_20250131_普發1萬的11門課廣告禮包.html?password=CRUZ2025
   ```

2. 選擇一個禮包類型（效率淘金包、內容印鈔機、決策智囊團）

3. 生成第一個提示詞

4. 輸入 Email 並提交

5. 檢查：
   - 瀏覽器 Console 應該顯示 `✅ Email 提交成功`
   - Supabase Dashboard → Table Editor → gift_leads 應該看到新紀錄

### 5. 查詢收集到的 Leads

```bash
# 查詢所有 leads
curl http://localhost:3000/api/gift-leads

# 查詢特定密碼的 leads
curl http://localhost:3000/api/gift-leads?password=CRUZ2025&limit=50
```

## 資料結構

### gift_leads 表

| 欄位 | 類型 | 說明 |
|-----|------|------|
| id | UUID | 主鍵 |
| email | TEXT | 使用者 Email |
| gift_type | TEXT | 禮包類型 (efficiency/content/decision) |
| completed_prompts | INTEGER | 完成的提示詞數量 (0-3) |
| password | TEXT | 禮包密碼 (例如 CRUZ2025) |
| source | TEXT | 流量來源 (例如 fb-ad-jan) |
| created_at | TIMESTAMP | 建立時間 |
| updated_at | TIMESTAMP | 更新時間 |

## 安全性

- ✅ **Row Level Security (RLS)** 已啟用
- ✅ **公開插入政策**: 允許匿名使用者提交 Email
- ✅ **認證查詢政策**: 只有認證使用者可以查詢所有 leads
- ✅ **Service Role 完整權限**: 管理員可以管理所有資料

## 匯出 Email 清單

### 從 Supabase Dashboard

1. Table Editor → gift_leads
2. 點擊右上角的「Export」
3. 選擇 CSV 格式
4. 下載檔案

### 使用 SQL 查詢

```sql
-- 依照密碼分組統計
SELECT
  password,
  gift_type,
  COUNT(*) as count,
  COUNT(DISTINCT email) as unique_emails
FROM gift_leads
GROUP BY password, gift_type
ORDER BY password, gift_type;

-- 匯出特定活動的所有 emails
SELECT
  email,
  gift_type,
  completed_prompts,
  created_at
FROM gift_leads
WHERE password = 'CRUZ2025'
ORDER BY created_at DESC;
```

## 故障排除

### Email 沒有被儲存

1. 檢查瀏覽器 Console 是否有錯誤訊息
2. 檢查 Supabase Dashboard → Logs → API
3. 驗證環境變數是否正確設定
4. 確認 RLS policies 是否正確啟用

### API 回傳 500 錯誤

1. 檢查 Supabase URL 和 ANON KEY 是否正確
2. 驗證資料表是否已建立
3. 檢查 Server Logs (Vercel Dashboard 或本地 terminal)

## 監控與分析

建議追蹤的指標：

- **總 Email 數**: 了解整體成效
- **轉換率**: 訪問者 → Email 提交的比例
- **禮包偏好**: 哪個禮包最受歡迎
- **完成度**: 使用者平均完成幾個提示詞

可以在 Supabase Dashboard 建立 Views 來追蹤這些指標。
