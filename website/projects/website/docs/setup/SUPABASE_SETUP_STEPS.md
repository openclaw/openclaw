# 🗄️ Supabase 設定步驟指南

## 階段一：測試環境設定 (thinker-test)

### 1. 選擇專案並取得 API Keys

1. 選擇 **thinker-test** 專案
2. 前往 `Project Settings` → `API`
3. 複製以下資訊:
   ```
   Project URL: https://xxxxx.supabase.co
   anon public key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   ```

### 2. 建立 `.env.local` 檔案

```bash
# 在專案根目錄建立 .env.local
cd /Users/thinkercafe/Documents/thinker_official_website
cp .env.example .env.local
```

編輯 `.env.local`,填入 thinker-test 的資訊:
```env
# Supabase (測試環境)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### 3. 建立資料表

前往 `thinker-test` → `Table Editor`，執行以下 SQL:

#### 3.1 建立 courses 資料表

```sql
-- 課程資料表（僅儲存要顯示的 course_id）
CREATE TABLE courses (
  course_id INT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 插入測試資料
INSERT INTO courses (course_id) VALUES
  (1),
  (2),
  (3);

COMMENT ON TABLE courses IS '課程清單：控制哪些課程要在網站上顯示';
COMMENT ON COLUMN courses.course_id IS '課程 ID，對應到 Notion Products Database';
```

#### 3.2 建立 profiles 資料表

```sql
-- 用戶資料表
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255),
  full_name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 啟用 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 用戶只能查看自己的 profile
CREATE POLICY "Users can view their own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

-- 用戶可以插入自己的 profile
CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用戶可以更新自己的 profile
CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);

COMMENT ON TABLE profiles IS '用戶資料表';
```

#### 3.3 建立 orders 資料表

```sql
-- 訂單資料表
CREATE TABLE orders (
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id INT NOT NULL,
  course_variant VARCHAR(10) NOT NULL CHECK (course_variant IN ('group', 'single')),
  total INT NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'payed', 'messaged', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 建立索引
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_state ON orders(state);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- 啟用 RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 用戶只能查看自己的訂單
CREATE POLICY "Users can view their own orders"
  ON orders FOR SELECT
  USING (auth.uid() = user_id);

-- 用戶只能建立自己的訂單
CREATE POLICY "Users can insert their own orders"
  ON orders FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- 用戶只能更新自己的訂單
CREATE POLICY "Users can update their own orders"
  ON orders FOR UPDATE
  USING (auth.uid() = user_id);

COMMENT ON TABLE orders IS '訂單資料表';
COMMENT ON COLUMN orders.order_id IS '訂單 UUID';
COMMENT ON COLUMN orders.user_id IS '用戶 ID';
COMMENT ON COLUMN orders.course_id IS '課程 ID（對應 Notion）';
COMMENT ON COLUMN orders.course_variant IS '上課方式：group 小班制, single 一對一';
COMMENT ON COLUMN orders.total IS '訂單金額（新台幣）';
COMMENT ON COLUMN orders.state IS '訂單狀態：created 已建立, payed 已繳費, messaged 已聯繫, confirmed 已確認';
```

#### 3.4 建立自動更新 updated_at 的 Trigger

```sql
-- 建立自動更新 updated_at 的函式
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 套用到 profiles 資料表
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 套用到 orders 資料表
CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
```

### 4. 設定 Authentication

前往 `Authentication` → `Providers`:

1. **Email Provider** (已預設啟用)
   - ✅ Enable Email provider
   - ✅ Confirm email (建議開啟)

2. **Email Templates** (可選)
   - 自訂註冊確認信件範本
   - 自訂密碼重設信件範本

3. **URL Configuration**
   - Site URL: `http://localhost:3000` (開發環境)
   - Redirect URLs:
     - `http://localhost:3000/**`
     - `https://yourdomain.com/**` (正式環境)

### 5. 測試連線

```bash
# 啟動開發伺服器
pnpm dev
```

測試以下功能:
- [ ] 註冊新用戶
- [ ] 登入
- [ ] 查看課程列表
- [ ] 建立訂單
- [ ] 查看我的課程

### 6. 插入測試資料（可選）

```sql
-- 測試用戶需要透過註冊頁面建立，這裡不需要手動插入

-- 可以直接在 courses 表新增更多測試課程
INSERT INTO courses (course_id) VALUES (4), (5), (6);
```

---

## 階段二：正式環境設定 (thinker-official)

當測試環境一切正常後，再依照相同步驟設定 thinker-official:

### 1. 切換到正式環境

1. 選擇 **thinker-official** 專案
2. 取得正式環境的 API Keys
3. 執行相同的 SQL 建立資料表
4. 設定 Authentication

### 2. 更新環境變數

**本地開發** (`.env.local`):
```env
# 保持使用測試環境
NEXT_PUBLIC_SUPABASE_URL=https://test-xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGci...test...
```

**Vercel 部署** (Production):
```env
# 使用正式環境
NEXT_PUBLIC_SUPABASE_URL=https://official-xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJhbGci...official...
```

### 3. 資料遷移（如果需要）

```sql
-- 如果測試環境有重要資料需要遷移，可以使用 Supabase 的資料匯出/匯入功能
-- 前往 Database → Backups
```

---

## 🔍 驗證清單

### 測試環境驗證
- [ ] 資料表建立成功（courses, profiles, orders）
- [ ] RLS 政策已啟用
- [ ] 可以註冊新用戶
- [ ] 可以登入
- [ ] 可以建立訂單
- [ ] 可以查看訂單列表
- [ ] API 回應正常

### 正式環境驗證
- [ ] 資料表建立成功
- [ ] RLS 政策已啟用
- [ ] Authentication 設定正確
- [ ] Vercel 環境變數已設定
- [ ] 正式網站可以正常運作

---

## ⚠️ 注意事項

1. **永遠不要在正式環境直接測試**
   - 先在 thinker-test 測試
   - 確認無誤後再部署到 thinker-official

2. **API Keys 安全**
   - 不要將 API Keys 提交到 Git
   - `.env.local` 已在 `.gitignore` 中

3. **RLS 政策**
   - 確保所有資料表都有啟用 RLS
   - 避免資料洩漏

4. **備份**
   - 定期備份正式環境資料
   - Supabase 提供自動備份功能（付費方案）

---

## 📞 需要協助？

如果遇到任何問題:
1. 檢查 Supabase Dashboard 的日誌
2. 檢查瀏覽器 Console
3. 檢查 Next.js 開發伺服器日誌
4. 參考 Supabase 官方文件: https://supabase.com/docs

---

**文件版本**: v1.0
**最後更新**: 2025-11-02
