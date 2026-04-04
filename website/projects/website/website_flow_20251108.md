# Website Flow Analysis - 2025/11/08

## 🏢 建築結構總覽

這是一個 Next.js 15.2.4 的 AI 課程平台，採用 App Router 架構。

### 技術棧
- **框架**: Next.js 15.2.4 (App Router)
- **React**: 19.x
- **樣式**: Tailwind CSS 4.1.9
- **數據來源**: Notion API + Supabase
- **認證**: Supabase Auth (LINE Login)
- **分析**: Google Analytics 4
- **郵件**: Resend
- **UI 組件**: Radix UI + shadcn/ui

---

## 🚪 櫃檯：首頁 (`/`)

**檔案**: `app/page.tsx`

### 功能
1. **Hero 區塊** - 全螢幕歡迎區
   - 標題：「開啟無限可能的 AI 課程」
   - CTA 按鈕：「探索課程」→ `/products`
   - 追蹤事件：`click_explore_courses` (GA4)

2. **精選課程輪播** - `<ProductCarousel />`
   - 從 `/api/products` 取得課程列表
   - 過濾 `featured: true` 的課程
   - 自動輪播（5 秒）
   - 點擊卡片 → `/products/[id]`

3. **為何選擇我們** - 三大特色
   - 專家規劃
   - 路徑完整
   - 實用性高

4. **底部 CTA** - 再次引導報名
   - 按鈕：「上課去！」→ `/products`
   - 追蹤事件：`click_explore_courses`

### 依賴組件
- `components/product-carousel.tsx`
- `components/scroll-reveal-section.tsx`
- `components/scroll-reveal.tsx`
- `lib/analytics.js`

---

## 📚 一樓：課程列表 (`/products`)

**檔案**: `app/products/page.tsx` + `app/products/ProductGrid.tsx`

### 功能
1. **分類篩選器**
   - 從 API 動態取得分類
   - 預設顯示「全部」

2. **課程卡片網格**
   - 3 欄式佈局（響應式）
   - 每張卡片顯示：
     - 課程圖片
     - 課程 ID（三位數格式）
     - 課程名稱
     - 簡短描述
     - 「精選」標籤（featured）
     - 「即將開放」標籤（course_id !== 6）

3. **點擊追蹤**
   - 追蹤事件：`view_item` (GA4 電商事件)
   - 記錄課程 ID、名稱、分類、價格

### 資料流
```
ProductGrid (Client Component)
  ↓ useEffect
  → fetch('/api/products')
  ↓
  /api/products (Server Route)
  ↓
  1. Supabase: SELECT * FROM courses
  2. Notion: getProducts()
  3. 合併資料（以 course_id 為 key）
  4. 過濾 published: true
  5. 排序 sort_desc
  ↓
  返回課程列表
```

---

## 🚪 二樓：課程詳細頁 (`/products/[id]`)

**檔案**: `app/products/[id]/page.tsx`

### 頁面結構（從上到下）

#### 1. Hero 區塊 (`<Cover>`)
- 全螢幕影片背景（`product.content_video`）
- 課程分類徽章
- 課程 ID + 名稱
- 課程描述
- **「立即報名」按鈕** → `/buy-course/[courseId]`

#### 2. 課程進度追蹤器 (`<CourseProgressTracker>`)
- **僅第六課顯示**
- 追蹤使用者滾動進度

#### 3. Bar 資訊區塊 (`<Bar>`)
- 顯示 4 個重點資訊
- 資料來源：`product.bar_text_1` ~ `bar_text_4`

#### 4. 角色選擇器 (`<RoleSelector>`)
- **僅第六課顯示**
- 讓使用者選擇職業角色

#### 5. 課程資訊 (`<CourseInfo>`)
- **僅第六課顯示**
- 顯示：
  - 💰 價格：NT$ 10,000
  - 📅 課程日期（3 天）
  - 📍 上課地點（板橋教室）
  - 🚇 交通方式
  - 👨‍🏫 課程講師（Cruz Tang）
  - ⏰ 報名截止：11/24
  - 👥 名額限制：12 人

#### 6. 課程內容 (`<Content>`)
- 顯示 `product.summery`
- 「你將學會」列表
- 技能標籤 (`skill_tags`)
- 內容標籤 (`content_tags`)

#### 7. 準備清單 (`<PreparationChecklist>`)
- **僅第六課顯示**

#### 8. 亮點網格 (`<HighlightGrid>`)
- **非第六課顯示**
- 顯示 6 個課程亮點

#### 9. FAQ 區塊 (`<FAQ>`)
- 第六課：`course6FAQ`
- 其他課程：`universalFAQ`

#### 10. 滾動偵測器 (`<ScrollBottomDetector>`)
- **僅第六課顯示**

#### 11. 探索者獎勵 (`<ExplorerReward>`)
- **僅第六課顯示**
- 發放折扣碼到 localStorage

#### 12. 底部報名按鈕

### 資料流
```
page.tsx (Server Component)
  ↓
  getProductById(id) → Notion API
  ↓
  返回完整課程資料（包含所有欄位）
  ↓
  傳遞給各個子組件
```

### SEO 優化
- 動態 Meta Tags（Open Graph、Twitter）
- Course Schema（結構化資料）
- FAQPage Schema

---

## 🔐 三樓：認證系統

### 登入頁 (`/signin`)

**檔案**: `app/signin/page.js` + `app/signin/SignInPage.js`

- LINE Login 整合
- Redirect 參數支援（登入後返回原頁面）

### 報名流程（需登入）

**流程圖**:
```
點擊「立即報名」
  ↓
檢查登入狀態
  ↓ (未登入)
  redirect → /signin?redirect=/buy-course/6
  ↓ (已登入)
  → /buy-course/6
```

---

## 🛒 四樓：報名系統 (`/buy-course/[[...slug]]`)

**檔案**: `app/buy-course/[[...slug]]/page.js` + `BuyCourseForm.js`

### 步驟 1: 選擇課程

1. **課程選擇器**
   - 只顯示 `course_id === 6` 的課程
   - 其他課程自動過濾

2. **上課方式選擇**
   - 小班制（group）
   - 一對一（single）
   - 顯示價格：
     - 原價（`group_price` / `single_price`）
     - 早鳥價（`group_price_early` / `single_price_early`）

3. **探索者折扣**
   - 從 localStorage 讀取 `explorer_discount`
   - 檢查 `courseId === 6`
   - 自動套用折扣

### 步驟 2: 確認資訊

顯示：
- 課程名稱
- 上課方式
- 原價
- 探索者折扣（如有）
- **實付金額**

### 步驟 3: 建立訂單

**流程**:
```javascript
onSubmit()
  ↓
1. trackBeginCheckout() - GA4 追蹤
  ↓
2. supabase.from('orders').insert({
     course_id,
     course_variant,
     total: finalTotal
   })
  ↓
3. trackPurchase() - GA4 追蹤
  ↓
4. fetch('/api/email/send-payment-reminder') - 非同步
  ↓
5. toast('報名成功！')
  ↓
6. router.push(`/order/${orderId}`)
```

---

## 💳 五樓：訂單頁面 (`/order/[order_id]`)

**檔案**: `app/order/[order_id]/page.js`

### 訂單狀態流程

```
created (已建立)
  ↓
  顯示 <CreatedOrderForm>
  - 繳費資訊（銀行帳號）
  - 上傳繳費證明
  - 備註欄位
  ↓
payed (已付款) / messaged (已回報)
  ↓
  顯示 <PayedOrMessagedOrderForm>
  - 等待人工確認
  ↓
confirmed (已確認)
  ↓
  顯示 <ConfirmedOrderForm>
  - 課程開始通知
```

### 權限控制
- 檢查登入狀態
- 檢查訂單所有權（user_id）

---

## 🔌 API Routes

### `/api/products`
```
GET /api/products
  ↓
1. Supabase: courses 表
2. Notion: getProducts()
3. 合併 + 過濾 published
4. 排序 sort_desc
  ↓
返回課程列表
```

### `/api/enrollment-count`
```
GET /api/enrollment-count?course_id=6
  ↓
SELECT COUNT(*) FROM orders
WHERE course_id = 6
  AND state = 'payed'
  ↓
返回已報名人數
```

### `/api/email/send-payment-reminder`
```
POST /api/email/send-payment-reminder
Body: { orderId }
  ↓
1. 查詢訂單資料
2. 查詢使用者資料
3. 發送 Resend Email
  ↓
返回成功/失敗
```

### `/api/analytics/*`
- `/api/analytics/funnel` - 轉換漏斗數據
- `/api/analytics/stats` - 統計數據

---

## 📊 資料架構

### Notion Database
- **ID**: `26405e9de12180ff9e11e4b93209d16b`
- **欄位**:
  - `course_id` (number) - 課程 ID
  - `published` (checkbox) - 是否發布
  - `featured` (checkbox) - 是否精選
  - `sort_desc` (number) - 排序權重
  - `zh_name`, `en_name` - 課程名稱
  - `zh_description`, `en_description` - 課程描述
  - `image` - 主圖
  - `content_video` - Hero 影片
  - `group_price`, `group_price_early` - 團班價格
  - `single_price`, `single_price_early` - 一對一價格
  - `content_highlight1~6` - 亮點標題
  - `content_highlight1~6_description` - 亮點描述
  - `content_highlight1~6_image` - 亮點圖片
  - `bar_text_1~4` - Bar 區塊文字
  - `you_will_learn` - 學習內容
  - `skill_tags`, `content_tags` - 標籤
  - `summery` - 總結

### Supabase Tables

#### `courses`
```sql
- course_id (int, PK)
- ... (其他欄位)
```

#### `orders`
```sql
- order_id (uuid, PK)
- user_id (uuid, FK)
- course_id (int, FK)
- course_variant (enum: 'group' | 'single')
- total (numeric)
- state (enum: 'created' | 'payed' | 'messaged' | 'confirmed')
- created_at (timestamp)
```

#### `profiles`
```sql
- user_id (uuid, PK, FK)
- email (text)
- display_name (text)
- ... (其他個人資料)
```

---

## 🎯 使用者旅程地圖

### Journey 1: 一般訪客 → 報名成功

```
1. 進入首頁 (/)
   ↓
2. 點擊「探索課程」→ /products
   ↓
3. 瀏覽課程列表，點擊課程卡片 → /products/6
   ↓
4. 滾動頁面，查看課程資訊
   ↓
5. 點擊「立即報名」
   ↓
6. 被導向登入頁 /signin?redirect=/buy-course/6
   ↓
7. LINE Login 登入
   ↓
8. 自動返回 /buy-course/6
   ↓
9. 選擇課程方案（小班制/一對一）
   ↓
10. 點擊「繼續」
   ↓
11. 確認資訊，點擊「確認無誤，前往繳費」
   ↓
12. 建立訂單，導向 /order/[order_id]
   ↓
13. 上傳繳費證明
   ↓
14. 等待人工確認
```

### Journey 2: 探索者獎勵流程

```
1. 進入課程頁 /products/6
   ↓
2. 滾動到底部
   ↓
3. <ScrollBottomDetector> 偵測到
   ↓
4. <ExplorerReward> 彈出
   ↓
5. 折扣碼存入 localStorage (key: 'explorer_discount')
   ↓
6. 點擊「立即報名」
   ↓
7. 在 BuyCourseForm 中自動套用折扣
   ↓
8. 顯示原價、折扣、實付金額
```

---

## 🐛 已發現的 Bug 和問題

### Bug #1: Build Error - useContext in /500 page ⚠️ **HIGH PRIORITY**

**錯誤訊息**:
```
TypeError: Cannot read properties of null (reading 'useContext')
    at g (.next/server/pages/_error.js:1:7409)
Error occurred prerendering page "/500"
```

**位置**: `.next/server/pages/_error.js`

**原因分析**:
- Next.js 15 使用 React 19，在 Server Component 環境中某個組件錯誤使用了 `useContext`
- 這可能是某個 UI 組件（Radix UI）的問題
- 錯誤頁面無法正常渲染

**影響**:
- Build 可以完成，但有警告
- 500 錯誤頁面無法正常顯示
- 可能影響錯誤處理和使用者體驗

**建議修復方案**:
1. 檢查是否有自定義的 `app/error.tsx` 或 `app/500.tsx`
2. 如果沒有，建立一個簡單的錯誤頁面
3. 確保所有使用 `useContext` 的組件都標記為 `'use client'`

---

### Bug #2: Edge Runtime Warning - Supabase ⚠️ **MEDIUM PRIORITY**

**警告訊息**:
```
./node_modules/@supabase/supabase-js/dist/module/index.js
A Node.js API is used (process.version at line: 24) which is not supported in the Edge Runtime.
```

**位置**: `utils/supabase/middleware.ts`

**原因**:
- Supabase 客戶端使用了 Node.js API (`process.version`)
- 但在 Edge Runtime 中不支援

**影響**:
- 如果有使用 Middleware 且部署到 Vercel Edge，可能無法正常運作
- 目前看起來沒有使用 middleware（找不到 `middleware.ts` 檔案）

**建議**:
- 如果不需要 Edge Runtime，可忽略
- 如果需要，考慮使用 Supabase 的 Edge-compatible 版本

---

### Bug #3: TypeScript & ESLint 被停用 ⚠️ **MEDIUM PRIORITY**

**位置**: `next.config.mjs`

```javascript
eslint: {
  ignoreDuringBuilds: true,
},
typescript: {
  ignoreBuildErrors: true,
}
```

**問題**:
- 這會導致型別錯誤和 Linting 問題被忽略
- 降低程式碼品質保證

**影響**:
- 可能隱藏潛在 bug
- 團隊協作時缺乏程式碼規範

**建議**:
- 逐步修復 TypeScript 錯誤
- 啟用 ESLint，設定合理的規則
- 使用 CI/CD 強制檢查

---

### Issue #4: 課程日期硬編碼 📅 **LOW PRIORITY**

**位置**: `app/products/[id]/CourseInfo.tsx:19-23`

```typescript
dates: [
  { date: '2024/11/29', day: '(六)', time: '09:30-15:30' },
  { date: '2024/12/06', day: '(六)', time: '09:30-15:30' },
  { date: '2024/12/13', day: '(六)', time: '09:30-15:30' },
],
```

**問題**:
- 課程日期寫死在程式碼中
- 每次開新課程都要改程式碼

**建議改進**:
- 將日期資料移到 Notion Database
- 從 API 動態取得
- 或使用環境變數

---

### Issue #5: 探索者折扣邏輯僅限第六課 🎁 **LOW PRIORITY**

**位置**:
- `app/buy-course/[[...slug]]/BuyCourseForm.js:81`
- `app/products/[id]/page.tsx:202-203`

**問題**:
- 探索者獎勵功能硬編碼只給第六課
- 其他課程無法使用此功能

**建議**:
- 改為可配置的功能
- 在 Notion 中設定哪些課程啟用探索者獎勵

---

### Issue #6: 只開放第六課報名 🔒 **KNOWN LIMITATION**

**位置**:
- `app/products/[id]/BuyCourseButton.js:11`
- `app/buy-course/[[...slug]]/BuyCourseForm.js:49`
- `app/products/ProductGrid.tsx:114-118`

**現況**:
- 寫死只有 `course_id === 6` 可報名
- 其他課程顯示「即將開放」

**建議**:
- 在 Notion 中加入 `enrollment_open` 欄位
- 動態控制哪些課程可報名

---

### Issue #7: 缺少 /orders 頁面實作 📝 **MEDIUM PRIORITY**

**位置**: `app/orders/page.js`

**問題**:
- 有 `app/orders/` 目錄
- 但沒有在任何地方連結
- 使用者看不到歷史訂單列表

**建議**:
- 實作「我的訂單」頁面
- 在導航列加入連結
- 顯示使用者的所有訂單

---

### Issue #8: 課程價格顯示不一致 💰 **LOW PRIORITY**

**位置**: `app/products/[id]/CourseInfo.tsx:46-47`

```typescript
<div className="text-5xl font-black text-white">
  NT$ 10,000
</div>
```

**問題**:
- 價格寫死在組件中
- 與 Notion 資料不同步
- 第六課實際有早鳥價 (`group_price_early`)

**建議**:
- 從 `product.group_price_early` 或 `product.group_price` 取得
- 保持單一資料來源原則

---

### Issue #9: Google Analytics ID 硬編碼 📊 **LOW PRIORITY**

**位置**: `components/analytics/GoogleAnalytics.tsx:7`

```javascript
const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-9WV2YC6165';
```

**問題**:
- Fallback 值寫死在程式碼中
- 如果環境變數未設定，會使用硬編碼值

**影響**:
- 開發環境和正式環境可能混用同一個 GA ID
- 資料分析不準確

**建議**:
- 移除 fallback 值
- 強制要求環境變數設定
- 或在未設定時不載入 GA

---

### Issue #10: 礼包頁面重定向 🎁 **QUESTIONABLE**

**位置**: `app/ai/gift/page.tsx`

```typescript
export default function GiftPage() {
  redirect('/ai/gift.html');
}
```

**問題**:
- Next.js 頁面重定向到靜態 HTML
- 為什麼不直接使用 Next.js 頁面？

**建議**:
- 檢查 `public/ai/gift.html` 的內容
- 考慮將其改寫為 Next.js 頁面
- 或使用 Next.js 的 Rewrites

---

### Issue #11: CourseInfo 講師照片使用外部長 URL 🖼️ **LOW PRIORITY**

**位置**: `app/products/[id]/CourseInfo.tsx:148`

**問題**:
- 講師照片使用 Next.js Image Optimizer 的完整 URL
- URL 包含臨時的 AWS 簽名 (expires)
- 照片可能過期失效

**建議**:
- 將照片上傳到 `public/` 目錄
- 或使用 Notion 圖片欄位
- 使用相對路徑

---

## 🔍 程式碼品質觀察

### ✅ 做得好的地方

1. **清晰的目錄結構**
   - App Router 使用得當
   - 組件分離明確

2. **完整的 GA4 追蹤**
   - 電商事件完整（view_item, add_to_cart, begin_checkout, purchase）
   - 自定義事件有意義

3. **良好的 SEO 設定**
   - Meta Tags 完整
   - Structured Data (Schema.org)
   - Open Graph & Twitter Cards

4. **使用者體驗**
   - 載入狀態處理
   - 錯誤訊息提示
   - Toast 通知

5. **安全性**
   - 使用 Supabase RLS
   - Server-side 權限檢查
   - Admin Client 分離

### ⚠️ 可以改進的地方

1. **硬編碼問題**
   - 課程日期、價格、ID 等寫死在程式碼中
   - 應該從資料庫或 CMS 取得

2. **型別安全**
   - TypeScript 錯誤被忽略
   - 缺少型別定義

3. **錯誤處理**
   - 500 頁面無法渲染
   - 缺少全域錯誤邊界

4. **資料同步**
   - Notion 和 Supabase 雙資料來源
   - 需要手動同步（透過 API）

5. **測試覆蓋率**
   - 看到測試設定，但沒有看到測試檔案
   - 應該補充單元測試和 E2E 測試

---

## 🎯 建議優先處理的問題

### 🔴 緊急 (1-2 天內)
1. **修復 500 錯誤頁面** (Bug #1)
   - 影響使用者體驗
   - 建立自定義錯誤頁面

### 🟡 重要 (1 週內)
2. **啟用 TypeScript 檢查** (Bug #3)
   - 逐步修復型別錯誤
   - 提升程式碼品質

3. **實作訂單列表頁** (Issue #7)
   - 讓使用者查看歷史訂單
   - 完整的使用者體驗

4. **修復價格顯示不一致** (Issue #8)
   - 確保價格資料單一來源
   - 避免混淆

### 🟢 一般 (有空時)
5. **將課程日期改為動態** (Issue #4)
6. **移除 GA ID 硬編碼** (Issue #9)
7. **優化講師照片** (Issue #11)
8. **改進探索者獎勵邏輯** (Issue #5)

---

## 📝 總結

整體來說，這是一個**結構良好、功能完整**的 AI 課程平台。主要問題集中在：

1. **過多的硬編碼** - 降低了靈活性
2. **型別檢查被停用** - 隱藏潛在問題
3. **錯誤處理不足** - 500 頁面無法渲染

建議優先修復 Bug #1 和 Bug #3，然後逐步將硬編碼改為動態配置。

---

**分析完成時間**: 2025/11/08
**分析者**: Claude Code (Sonnet 4.5)
**網站版本**: Next.js 15.2.4
