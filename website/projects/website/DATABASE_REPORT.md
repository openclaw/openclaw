# 📊 Supabase 資料庫完整報告

**生成時間**: 2025-11-02
**資料庫**: https://fpdcnbpeoasipxjibmuz.supabase.co

---

## 📋 資料表總覽

| 資料表 | 筆數 | 狀態 |
|--------|------|------|
| **courses** | 30 | ✅ OK |
| **orders** | 5 | ✅ OK |
| **profiles** | 9 | ✅ OK |

---

## 📚 COURSES (課程資料表)

### 資料結構
```sql
CREATE TABLE courses (
  course_id INT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 資料概況
- **總課程數**: 30 個
- **Course IDs**: 1-30
- **說明**: 控制哪些課程要在網站上顯示，與 Notion Products Database 對應

---

## 📦 ORDERS (訂單資料表)

### 資料結構
```sql
CREATE TABLE orders (
  order_id INT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  course_id INT NOT NULL,
  course_variant VARCHAR(10) CHECK (course_variant IN ('group', 'single')),
  total INT NOT NULL,
  state VARCHAR(20) DEFAULT 'created' CHECK (state IN ('created', 'payed', 'messaged', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 資料概況
- **總訂單數**: 5 筆
- **總金額**: NT$ 47,860

### 訂單明細

#### 訂單 #32 (最早)
- **用戶**: Mr. Foobar
- **課程**: 課程 1
- **上課方式**: 一對一
- **金額**: NT$ 39,800
- **狀態**: ✅ confirmed (已確認/已開通)
- **建立時間**: 2025-10-29 01:27

#### 訂單 #33
- **用戶**: Mr. Foobar
- **課程**: 課程 3
- **上課方式**: 小班制
- **金額**: NT$ 4,800
- **狀態**: 💬 messaged (已聯繫客服)
- **建立時間**: 2025-10-29 02:32

#### 訂單 #34
- **用戶**: Mr. Foobar
- **課程**: 課程 5
- **上課方式**: 一對一
- **金額**: NT$ 590
- **狀態**: 💰 payed (已繳費，待審核)
- **建立時間**: 2025-10-29 08:16

#### 訂單 #35
- **用戶**: Mr. Foobar
- **課程**: 課程 2
- **上課方式**: 小班制
- **金額**: NT$ 1,680
- **狀態**: ⏳ created (已建立，待繳費)
- **建立時間**: 2025-10-29 08:16

#### 訂單 #36 (最新)
- **用戶**: 湯明軒
- **課程**: 課程 5
- **上課方式**: 小班制
- **金額**: NT$ 990
- **狀態**: 💬 messaged (已聯繫客服)
- **建立時間**: 2025-11-02 00:15

### 訂單狀態分布
- ✅ **confirmed** (已確認): 1 筆
- 💰 **payed** (已繳費): 1 筆
- 💬 **messaged** (已聯繫): 2 筆
- ⏳ **created** (已建立): 1 筆

### 課程報名統計
- **課程 1**: 1 筆訂單 (NT$ 39,800)
- **課程 2**: 1 筆訂單 (NT$ 1,680)
- **課程 3**: 1 筆訂單 (NT$ 4,800)
- **課程 5**: 2 筆訂單 (NT$ 1,580)

### 上課方式分布
- **小班制 (group)**: 3 筆
- **一對一 (single)**: 2 筆

---

## 👤 PROFILES (用戶資料表)

### 資料結構
```sql
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  email VARCHAR(255),
  full_name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 資料概況
- **總用戶數**: 9 位

### 用戶清單

| # | 姓名 | 註冊時間 | 訂單數 | 總消費 |
|---|------|----------|--------|--------|
| 1 | Rhaenyra | 2025-10-15 | 0 | NT$ 0 |
| 2 | 連健亨 | 2025-10-20 | 0 | NT$ 0 |
| 3 | 顏毅俊 | 2025-10-23 | 0 | NT$ 0 |
| 4 | 施伯勳 | 2025-10-28 | 0 | NT$ 0 |
| 5 | **Mr. Foobar** | 2025-10-29 | **4** | **NT$ 46,870** |
| 6 | Mr. Haha | 2025-10-29 | 0 | NT$ 0 |
| 7 | 湯明軒 | 2025-10-30 | 1 | NT$ 990 |
| 8 | 鍾日欣 | 2025-10-31 | 0 | NT$ 0 |
| 9 | 施君瑩 | 2025-10-31 | 0 | NT$ 0 |

### VIP 用戶分析

#### 🌟 Mr. Foobar (user_id: 34eb5de8...)
- **訂單數**: 4 筆（最多）
- **總消費**: NT$ 46,870（最高）
- **訂單狀態**:
  - 1 筆已確認開通
  - 1 筆已繳費待審核
  - 2 筆處理中
- **報名課程**: 課程1, 課程2, 課程3, 課程5

---

## 📊 業務分析

### 轉換率
- **註冊用戶**: 9 位
- **有訂單用戶**: 2 位
- **轉換率**: 22.2%

### 客單價
- **平均訂單金額**: NT$ 9,572
- **最高訂單**: NT$ 39,800 (課程1, 一對一)
- **最低訂單**: NT$ 590 (課程5, 一對一)

### 訂單狀態流程健康度
- ✅ 已完成: 20% (1/5)
- 🚧 處理中: 80% (4/5)

**建議**:
- 有 4 筆訂單尚在處理中，建議優先處理已繳費訂單 (#34)
- 追蹤 messaged 狀態訂單 (#33, #36)
- 提醒 created 狀態訂單完成繳費 (#35)

---

## ⚠️ 注意事項

### Email 欄位全部未設定
所有 profiles 的 `email` 欄位都是空的，可能原因:
1. 註冊流程未將 email 寫入 profiles
2. 需要在註冊後自動建立 profile 記錄

**建議**:
- 檢查註冊流程，確保 email 正確寫入 profiles
- 可能需要建立 Database Trigger 或在註冊 API 中處理

### Phone 欄位全部未設定
所有用戶都未填寫電話，可能:
1. 電話欄位為選填
2. 用戶跳過此欄位

### updated_at 欄位顯示 undefined
可能原因:
1. Trigger 未正確設定
2. 欄位預設值問題

**建議**: 檢查並修復 `update_updated_at_column` trigger

---

## 🔒 安全性檢查

### RLS (Row Level Security)
- ✅ **orders**: 已啟用 RLS
- ✅ **profiles**: 已啟用 RLS
- ✅ **courses**: 公開資料，不需 RLS

### 測試結果
- ✅ 使用 anon key 無法看到其他用戶的訂單（RLS 正常運作）
- ✅ 使用 service_role key 可以看到所有資料（管理功能正常）

---

## 🎯 下一步建議

### 即時處理
1. ⚡ **處理訂單 #34** (已繳費，待審核)
2. 📞 **追蹤訂單 #33, #36** (已聯繫客服)
3. 💰 **提醒訂單 #35** 完成繳費

### 系統改進
1. 🔧 修復 `email` 欄位問題
2. 🔧 檢查 `updated_at` trigger
3. 📝 建議在報名表單加上電話為必填

### 資料分析
1. 📊 分析為何課程 5 最受歡迎
2. 📈 追蹤課程 1 的高單價轉換
3. 🎯 針對未下單用戶進行再行銷

---

**報告結束**
*此報告由 Claude Code 自動生成*
