# ThinkerCafe 註冊/登入系統完整分析報告

生成時間: 2025-11-05
目的: 為 LINE Login 整合提供完整的系統架構分析

---

## 1. 註冊/登入流程

### 1.1 註冊頁面 (`/app/signup/`)

**檔案結構:**
- `/app/signup/page.js` - 頁面入口 (使用 NoAuthPageWrapper)
- `/app/signup/SignUpPage.js` - 主要註冊表單組件

**收集資料:**
1. `email` - 電子信箱 (必填)
2. `password` - 密碼 (必填, 8-32碼, 需包含大小寫英文+數字)
3. `passwordConfirm` - 確認密碼 (必填)
4. `fullName` - 姓名 (必填, 最多100字元)
5. `phoneNumber` - 手機/市話 (必填, 最多100字元)
6. `agreeTos` - 同意條款 (必填, checkbox)

**註冊流程:**
```javascript
// SignUpPage.js 第 107-117 行
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    data: {
      fullName,      // 存入 auth.users.user_metadata
      phoneNumber,   // 存入 auth.users.user_metadata
      agreeTos,      // 存入 auth.users.user_metadata
    }
  }
});
```

**關鍵發現:**
- ✅ 使用 Supabase Auth 的 `signUp()` 方法
- ✅ `fullName`, `phoneNumber`, `agreeTos` 存入 `user_metadata`
- ❌ **沒有自動建立 `profiles` 記錄**
- ❌ **沒有 Database Trigger 自動建立 profile**

**註冊後導向:**
- 成功: `/signup-success` 或指定的 redirect 路徑
- 失敗: 顯示錯誤訊息

### 1.2 登入頁面 (`/app/signin/`)

**檔案結構:**
- `/app/signin/page.js` - 頁面入口 (使用 NoAuthPageWrapper)
- `/app/signin/SignInPage.js` - 主要登入表單組件

**收集資料:**
1. `email` - 電子信箱 (必填)
2. `password` - 密碼 (必填)

**登入流程:**
```javascript
// SignInPage.js 第 64-67 行
const { data, error } = await supabase.auth.signInWithPassword({
  email,
  password,
});
```

**登入後導向:**
- 成功: `/` (首頁) 或指定的 redirect 路徑
- 失敗: 顯示錯誤訊息

### 1.3 NoAuthPageWrapper 機制

**檔案:** `/components/core/NoAuthPageWrapper.js`

**功能:**
- Server Component，在頁面載入前檢查登入狀態
- 如果已登入，自動 redirect 到首頁
- 防止已登入用戶訪問註冊/登入頁面

```javascript
const { data: { user } } = await supabase.auth.getUser();
if (user) {
  redirect('/');
}
```

---

## 2. API 端點

### 2.1 認證相關 API

**發現:**
- ❌ **沒有自訂的 `/app/api/auth/` 端點**
- ✅ 完全使用 Supabase Auth 內建功能
- ✅ 所有認證操作透過 Supabase SDK 完成

**現有 API 端點:**
```
/app/api/
├── about/route.ts         - 取得關於頁面資料
├── contact/route.ts       - 處理聯絡表單
├── products/route.ts      - 取得課程列表
└── email/
    └── send-payment-reminder/route.ts - 發送繳費提醒
```

### 2.2 繳費提醒 Email API

**檔案:** `/app/api/email/send-payment-reminder/route.ts`

**資料查詢流程 (重要!):**
```javascript
// 1. 查詢訂單
const { data: order } = await supabase
  .from('orders')
  .select('*')
  .eq('order_id', orderId)
  .single();

// 2. 查詢 profiles (從 public.profiles)
const { data: profile } = await supabase
  .from('profiles')
  .select('*')
  .eq('user_id', order.user_id)
  .single();

// 3. 取得用戶 Email (從 auth.users，需要 admin client)
const supabaseAdmin = createAdminClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(order.user_id);

// 4. 使用資料
const email = user.email;              // 從 auth.users
const studentName = profile.name;      // 從 profiles
```

**關鍵發現:**
- ✅ Email 儲存在 `auth.users.email`
- ✅ 姓名儲存在 `profiles.name`
- ✅ 需要 Service Role Key 才能讀取 `auth.users` 的 email

---

## 3. Database Schema 詳細資訊

### 3.1 `auth.users` (Supabase 內建表)

**無法直接查看結構**，但根據程式碼推斷:
- `id` (UUID) - Primary Key
- `email` (VARCHAR) - 用戶信箱
- `encrypted_password` (TEXT) - 加密後的密碼
- `user_metadata` (JSONB) - 存放自訂資料
  - `fullName` - 從註冊表單寫入
  - `phoneNumber` - 從註冊表單寫入
  - `agreeTos` - 從註冊表單寫入
- `created_at` (TIMESTAMPTZ)
- `updated_at` (TIMESTAMPTZ)

**訪問限制:**
- ❌ 一般查詢無法直接讀取 (需要 Service Role Key)
- ✅ 透過 `supabase.auth.getUser()` 可以取得當前用戶資訊
- ✅ 透過 `supabaseAdmin.auth.admin.getUserById()` 可以取得任意用戶資訊 (需 admin)

### 3.2 `public.profiles` (完整結構)

**基礎欄位 (原始):**
```sql
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255),
  full_name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**新增欄位 (Migration 20251105):**
```sql
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(255) UNIQUE,
ADD COLUMN IF NOT EXISTS line_display_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS line_picture_url TEXT,
ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'email',
ADD COLUMN IF NOT EXISTS migrated_from_email BOOLEAN DEFAULT false;
```

**完整欄位列表:**
- `user_id` (UUID) - Primary Key, 關聯到 auth.users(id)
- `email` (VARCHAR 255) - **目前全部為 NULL** ⚠️
- `full_name` (VARCHAR 100) - 用戶姓名 (但實際是 `name` 欄位?)
- `phone` (VARCHAR 20) - 電話號碼
- `line_user_id` (VARCHAR 255) - LINE User ID (UNIQUE)
- `line_display_name` (VARCHAR 255) - LINE 顯示名稱
- `line_picture_url` (TEXT) - LINE 大頭貼 URL
- `auth_provider` (VARCHAR 20) - 登入方式 ('email' | 'line')
- `migrated_from_email` (BOOLEAN) - 是否從 email 遷移
- `created_at` (TIMESTAMPTZ)
- `updated_at` (TIMESTAMPTZ)

**索引:**
```sql
CREATE INDEX idx_profiles_line_user_id ON profiles(line_user_id);
CREATE INDEX idx_profiles_auth_provider ON profiles(auth_provider);
```

**RLS 政策:**
```sql
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
```

**問題發現:**
- ⚠️ `email` 欄位全部為 NULL (根據 DATABASE_REPORT.md)
- ⚠️ `phone` 欄位全部為 NULL
- ⚠️ 欄位名稱不一致: 程式碼使用 `profile.name`，但 schema 是 `full_name`
- ❌ **沒有 Database Trigger 在用戶註冊時自動建立 profile**

### 3.3 `public.orders`

**結構:**
```sql
CREATE TABLE orders (
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id INT NOT NULL,
  course_variant VARCHAR(10) NOT NULL CHECK (course_variant IN ('group', 'single')),
  total INT NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'created' 
    CHECK (state IN ('created', 'payed', 'messaged', 'confirmed')),
  transfer_account_last5 VARCHAR(5),  -- Migration 20251102
  transfer_time TIMESTAMPTZ,          -- Migration 20251102
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**索引:**
```sql
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_state ON orders(state);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
```

**RLS 政策:**
- 用戶只能查看/建立/更新自己的訂單 (透過 `auth.uid() = user_id`)

**關鍵邏輯:**
- 訂單建立時自動帶入 `user_id` (透過 Supabase client side RLS)
- 訂單查詢會 join profiles 取得用戶姓名

---

## 4. Supabase 設定

### 4.1 Client 端配置

**檔案:** `/utils/supabase/client.ts`

```typescript
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
}
```

**用途:**
- Client Component 中使用
- 瀏覽器端操作 (註冊、登入、訂單建立等)
- 自動處理 Session 管理

### 4.2 Server 端配置

**檔案:** `/utils/supabase/server.ts`

```typescript
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()
  
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component 中呼叫 setAll 可忽略錯誤
          }
        },
      },
    }
  )
}
```

**用途:**
- Server Component 中使用
- 頁面載入時檢查登入狀態
- Server-side 資料查詢

### 4.3 Middleware 配置

**檔案:** `/utils/supabase/middleware.ts` + `/middleware.ts`

```typescript
// middleware.ts
import { updateSession } from '@/utils/supabase/middleware'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

// 套用到所有路由 (除了靜態檔案)
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
```

**功能:**
- 每個請求都會執行 `supabase.auth.getUser()`
- 自動刷新 Session
- 確保 Cookie 同步

**關鍵:**
- ⚠️ **不能移除** `await supabase.auth.getUser()`，否則會導致 Session 不穩定

---

## 5. 報名流程與認證的關係

### 5.1 報名頁面 (`/app/buy-course/[[...slug]]/page.js`)

**認證檢查 (Server Component):**
```javascript
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();

if (!user) {
  const currentPath = courseId ? `/buy-course/${courseId}` : '/buy-course';
  redirect(`/signin?redirect=${encodeURIComponent(currentPath)}`);
}
```

**流程:**
1. 檢查登入狀態
2. 未登入 → redirect 到登入頁 (帶 redirect 參數)
3. 已登入 → 顯示報名表單

### 5.2 報名表單 (`BuyCourseForm.js`)

**訂單建立流程:**
```javascript
// 1. 建立訂單 (Client Component)
const { data, error } = await supabase
  .from('orders')
  .insert({
    course_id: courseId,
    course_variant: courseVariant,
    total: finalTotal,
    // user_id 會自動由 Supabase RLS 帶入 (auth.uid())
  })
  .select();

const orderId = data[0].order_id;

// 2. 發送繳費提醒 Email (非同步，不等待)
fetch('/api/email/send-payment-reminder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orderId }),
});

// 3. 導向繳費頁面
router.push(`/order/${orderId}`);
```

**關鍵發現:**
- ✅ `user_id` 由 Supabase RLS 自動帶入 (透過 `auth.uid()`)
- ✅ 訂單建立不需要手動傳入 user_id
- ✅ RLS 確保用戶只能建立自己的訂單

### 5.3 訂單頁面 (`/app/order/[order_id]/page.js`)

**資料查詢流程:**
```javascript
// 1. 檢查登入
const { data: { user } } = await supabase.auth.getUser();
if (!user) {
  redirect(`/signin?redirect=${encodeURIComponent(currentPath)}`);
}

// 2. 查詢訂單
const { data: orderData } = await supabase
  .from('orders')
  .select()
  .eq('order_id', order_id);

// 3. 查詢 profile
const { data: profileData } = await supabase
  .from('profiles')
  .select()
  .eq('user_id', user.id);

// 4. 如果 profile 不存在 → notFound()
if (profileError || profileData.length === 0) {
  notFound();
}
```

**問題分析:**
- ⚠️ **假設 profile 一定存在**
- ⚠️ 如果 profile 不存在，頁面會 404
- ❌ **目前系統沒有自動建立 profile 的機制**
- 🔴 **這是一個嚴重的流程漏洞！**

---

## 6. 流程圖說明

### 6.1 完整註冊流程

```
用戶填寫註冊表單
  ├─ email
  ├─ password
  ├─ fullName
  ├─ phoneNumber
  └─ agreeTos
        ↓
supabase.auth.signUp({
  email,
  password,
  options: {
    data: { fullName, phoneNumber, agreeTos }
  }
})
        ↓
建立 auth.users 記錄
  ├─ id (UUID)
  ├─ email
  ├─ encrypted_password
  └─ user_metadata: { fullName, phoneNumber, agreeTos }
        ↓
❌ profiles 表沒有對應記錄
        ↓
redirect to /signup-success
```

### 6.2 報名課程流程

```
用戶訪問 /buy-course
        ↓
Server Component 檢查登入
        ↓
未登入? → redirect to /signin
        ↓
已登入 → 顯示報名表單
        ↓
用戶提交表單
        ↓
建立 orders 記錄 (user_id 自動帶入)
        ↓
發送 Email (查詢 profiles + auth.users)
        ↓
❌ profiles 不存在 → Email 發送失敗
        ↓
redirect to /order/{order_id}
        ↓
查詢 profile
        ↓
❌ profile 不存在 → 404 Error
```

### 6.3 LINE Login 整合後的理想流程

```
用戶點擊 "LINE Login"
        ↓
redirect to LINE Authorization
        ↓
用戶授權
        ↓
LINE redirect back with code
        ↓
/api/auth/callback/line 處理
        ↓
取得 LINE User Info
  ├─ userId
  ├─ displayName
  ├─ pictureUrl
  └─ email (可能為空)
        ↓
檢查 profiles.line_user_id 是否存在
        ↓
存在? → 登入現有帳號
        ↓
不存在? → 建立新帳號
  ├─ supabase.auth.signUp() with LINE provider
  ├─ 建立 profiles 記錄
  │   ├─ line_user_id
  │   ├─ line_display_name
  │   ├─ line_picture_url
  │   ├─ auth_provider = 'line'
  │   └─ email (如果 LINE 提供)
  └─ 如果缺少必要資料 → redirect to /complete-profile
        ↓
登入成功 → redirect to original page
```

---

## 7. 關鍵邏輯分析

### 7.1 為什麼 profiles.email 全部為 NULL？

**原因分析:**

1. **註冊時只寫入 auth.users:**
   ```javascript
   await supabase.auth.signUp({
     email,
     password,
     options: {
       data: { fullName, phoneNumber, agreeTos }
     }
   });
   ```
   - Email 寫入 `auth.users.email`
   - fullName, phoneNumber 寫入 `auth.users.user_metadata`
   - **完全沒有寫入 `profiles` 表**

2. **沒有 Database Trigger:**
   - 查無任何 SQL 檔案定義 trigger
   - 查無 `handle_new_user` function
   - Supabase 預設不會自動建立 profile

3. **profiles 表需要手動建立或透過 API 建立:**
   - 目前系統沒有這個邏輯
   - 所以所有用戶都沒有 profile 記錄

**影響:**
- ✅ 註冊、登入功能正常 (只需要 auth.users)
- ✅ 訂單建立功能正常 (只需要 user_id)
- ❌ 訂單頁面會 404 (需要 profile)
- ❌ Email 發送會失敗 (需要 profile.name)

### 7.2 目前系統如何運作？

**假設 (需要驗證):**

有兩種可能:

1. **有一個未記錄的 Database Trigger:**
   - 註冊時自動建立 profile
   - 但沒有寫入 email, phone 欄位
   - 所以這些欄位都是 NULL

2. **有一個未記錄的 signup-success 頁面邏輯:**
   - 在 `/signup-success` 頁面手動建立 profile
   - 但沒有寫入 email, phone 欄位

**建議驗證方式:**
```sql
-- 檢查是否有 trigger
SELECT trigger_name, event_manipulation, event_object_table, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public' OR event_object_schema = 'auth';

-- 檢查是否有相關 function
SELECT routine_name, routine_definition
FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name LIKE '%user%';
```

### 7.3 訂單頁面為何能運作？

**根據程式碼:**
```javascript
// order/[order_id]/page.js 第 34-40 行
const { data: profileData, error: profileError } = await supabase
  .from('profiles')
  .select()
  .eq('user_id', user.id);

if (profileError || profileData.length === 0) {
  notFound();  // 如果沒有 profile，顯示 404
}
```

**邏輯:**
- 如果 profile 不存在 → 404
- 所以理論上，所有註冊用戶應該都有 profile 記錄
- 否則他們無法訪問訂單頁面

**結論:**
- 🟡 **一定有某個機制在建立 profile**
- 🟡 **但這個機制沒有寫入 email, phone 欄位**
- 🟡 **需要找到這個機制的位置**

---

## 8. 目前的問題點

### 8.1 註冊流程問題

| 問題 | 嚴重程度 | 說明 |
|------|----------|------|
| profiles.email 全部為 NULL | 🔴 高 | 影響 Email 發送功能 |
| profiles.phone 全部為 NULL | 🟡 中 | 影響聯絡功能 |
| 註冊時未建立 profile | 🔴 高 | 可能導致訂單頁面 404 |
| user_metadata 資料未同步到 profiles | 🟡 中 | 資料重複儲存但不一致 |

### 8.2 資料結構問題

| 問題 | 嚴重程度 | 說明 |
|------|----------|------|
| profiles.full_name vs profile.name | 🟡 中 | 欄位名稱不一致 |
| Email 分散在兩個地方 | 🟡 中 | auth.users.email vs profiles.email |
| updated_at 顯示 undefined | 🟢 低 | Trigger 可能有問題 |

### 8.3 LINE Login 整合障礙

| 障礙 | 影響 | 說明 |
|------|------|------|
| 缺少 profiles 自動建立機制 | 🔴 高 | LINE 用戶註冊後可能沒有 profile |
| Email 欄位邏輯不清楚 | 🟡 中 | 不確定應該使用哪個 Email |
| 缺少 OAuth callback endpoint | 🔴 高 | 需要建立 /api/auth/callback/line |
| 缺少帳號綁定邏輯 | 🟡 中 | Email 用戶想綁定 LINE |

---

## 9. LINE Login 整合建議

### 9.1 必須實作的功能

1. **Profile 自動建立機制**
   - 選項 A: Database Trigger (推薦)
   - 選項 B: signup-success 頁面邏輯
   - 選項 C: Supabase Edge Function

2. **OAuth Callback Endpoint**
   - `/app/api/auth/callback/line/route.ts`
   - 處理 LINE Authorization Code
   - 建立/更新 profile

3. **帳號綁定邏輯**
   - 檢查 email 是否已存在
   - 如果存在 → 綁定 LINE 到現有帳號
   - 如果不存在 → 建立新帳號

4. **Profile 完善頁面 (可選)**
   - `/app/complete-profile`
   - 如果 LINE 未提供 email → 要求補填
   - 要求補填 phone (如果需要)

### 9.2 資料同步策略

**策略 A: profiles 為主 (推薦)**
```
auth.users (只存認證資訊)
  ├─ id
  ├─ email
  └─ encrypted_password

profiles (存完整用戶資料)
  ├─ user_id
  ├─ email (同步自 auth.users)
  ├─ name (可來自 user_metadata 或 LINE)
  ├─ phone
  ├─ line_user_id
  ├─ line_display_name
  ├─ line_picture_url
  └─ auth_provider
```

**策略 B: 雙向同步**
- auth.users.user_metadata 保留原始資料
- profiles 複製一份方便查詢
- 需要處理資料一致性

### 9.3 實作步驟

**Phase 1: 修復現有問題**
1. 建立 Database Trigger 自動建立 profile
2. 同步 email 和 phone 到 profiles
3. 修復 updated_at trigger
4. 測試現有流程

**Phase 2: 實作 LINE Login**
1. 建立 LINE Login button
2. 實作 OAuth callback endpoint
3. 建立 profile 建立/更新邏輯
4. 實作帳號綁定檢查

**Phase 3: 優化與測試**
1. 實作 complete-profile 頁面
2. 測試各種情境
3. 錯誤處理與 rollback

---

## 10. 推薦的 Database Trigger

```sql
-- 建立自動建立 profile 的 function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, name, phone, auth_provider)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'fullName', ''),
    COALESCE(NEW.raw_user_meta_data->>'phoneNumber', ''),
    COALESCE(NEW.raw_app_meta_data->>'provider', 'email')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 建立 trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

---

## 11. 結論

### 11.1 系統現況

✅ **運作正常的部分:**
- 註冊/登入功能 (Supabase Auth)
- 訂單建立 (RLS 自動帶入 user_id)
- Session 管理 (Middleware + SSR)

⚠️ **需要釐清的部分:**
- Profile 建立機制 (一定存在，但位置不明)
- Email/Phone 儲存邏輯 (為何全部為 NULL)
- 資料表欄位命名 (full_name vs name)

🔴 **需要修復的問題:**
- profiles.email 同步
- profiles.phone 同步
- updated_at trigger

### 11.2 LINE Login 整合可行性

**可行性: 高 ✅**

**前提條件:**
1. 先修復 profile 建立機制
2. 確保資料同步邏輯正確
3. 實作 OAuth callback endpoint

**預估工作量:**
- Phase 1 (修復): 1-2 天
- Phase 2 (LINE Login): 2-3 天
- Phase 3 (測試優化): 1-2 天
- **總計: 4-7 天**

---

**報告結束**

生成時間: 2025-11-05
分析者: Claude Code (Sonnet 4.5)
