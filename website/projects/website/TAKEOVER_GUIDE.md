# 🚀 Thinker Cafe 官方網站 - 完整接管指南

## 📋 目錄
1. [專案概述](#專案概述)
2. [技術架構](#技術架構)
3. [環境設定](#環境設定)
4. [API 清單與資料流](#api-清單與資料流)
5. [資料庫結構](#資料庫結構)
6. [部署與維護](#部署與維護)
7. [常見問題排解](#常見問題排解)

---

## 專案概述

**Thinker Cafe 官方網站** 是一個完整的線上 AI 課程平台，提供課程展示、線上報名、用戶管理等功能。

### 核心功能
- ✅ 課程列表展示（精選課程、完整課程清單）
- ✅ 單一課程詳細頁（課程介紹、亮點、技能標籤等）
- ✅ 用戶註冊/登入系統（Supabase Auth）
- ✅ 課程報名與訂單管理
- ✅ 我的課程頁面
- ✅ 關於我們頁面（品牌故事、價值觀、團隊介紹）
- ✅ 聯絡表單（自動寫入 Notion）

---

## 技術架構

### 前端框架
- **Next.js 15** (App Router)
- **React 19**
- **TypeScript**

### UI/UX
- **Tailwind CSS 4** (樣式框架)
- **shadcn/ui** (UI 元件庫)
- **Radix UI** (無障礙元件)
- **Lucide React** (圖示庫)

### 資料來源
- **Notion API** - 內容管理系統 (CMS)
  - 課程內容資料
  - About 頁面內容
  - 聯絡表單提交記錄

- **Supabase** - 後端服務
  - 用戶認證 (Auth)
  - 資料庫 (PostgreSQL)
  - courses 資料表
  - orders 資料表
  - profiles 資料表

### 套件管理
- **pnpm** v10.17.0

---

## 環境設定

### 1. 安裝 pnpm（如果尚未安裝）

```bash
npm install -g pnpm@10.17.0
```

### 2. 安裝專案依賴

```bash
cd /Users/thinkercafe/Documents/thinker_official_website
pnpm install
```

### 3. 設定環境變數

複製 `.env.example` 並建立 `.env.local`:

```bash
cp .env.example .env.local
```

然後編輯 `.env.local`，填入以下資訊：

#### 3.1 Notion API 設定

1. **取得 Notion Integration Token**
   - 前往 https://developers.notion.com/my-integrations
   - 建立新的 Integration
   - 複製 "Internal Integration Token"
   - 填入 `NOTION_TOKEN`

2. **取得 Notion Database IDs**

   需要建立以下 6 個 Notion Databases：

   - **Products Database** (課程資料)
   - **Our Story Database** (品牌故事)
   - **Our Values Database** (價值觀)
   - **Our Team Database** (團隊介紹)
   - **Mission & Vision Database** (使命與願景)
   - **Contact Submissions Database** (聯絡表單)

   詳細欄位結構請參考 [NOTION_SETUP.md](./NOTION_SETUP.md)

3. **分享 Databases 給 Integration**
   - 在每個 Database 點擊右上角 "Share"
   - 邀請你的 Integration
   - 複製 Database ID（URL 中的一串英數字）

#### 3.2 Supabase 設定

1. **建立 Supabase 專案**
   - 前往 https://supabase.com/dashboard
   - 建立新專案

2. **取得 API Keys**
   - 前往 Project Settings → API
   - 複製 `Project URL` → 填入 `NEXT_PUBLIC_SUPABASE_URL`
   - 複製 `anon public` key → 填入 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

3. **建立資料表**（見下方「資料庫結構」章節）

### 4. 啟動開發伺服器

```bash
pnpm dev
```

專案會在 http://localhost:3000 啟動

---

## API 清單與資料流

### API Endpoints

| Endpoint | 方法 | 功能 | 資料來源 |
|----------|------|------|----------|
| `/api/products` | GET | 取得所有已發布課程 | Supabase + Notion |
| `/api/about` | GET | 取得關於我們頁面內容 | Notion |
| `/api/about?section=story` | GET | 取得品牌故事 | Notion |
| `/api/about?section=values` | GET | 取得價值觀 | Notion |
| `/api/about?section=team` | GET | 取得團隊介紹 | Notion |
| `/api/about?section=mission-vision` | GET | 取得使命與願景 | Notion |
| `/api/contact` | POST | 提交聯絡表單 | Notion |

### 混合式資料流設計（重要！）

`/api/products` 路由採用**混合式資料流**：

```
1. 從 Supabase courses 資料表取得 course_id 清單
   ↓
2. 從 Notion Products Database 取得完整課程內容
   ↓
3. 以 course_id 為 key 合併兩邊資料
   ↓
4. 只顯示 published: true 的課程
   ↓
5. 依 sort_desc 排序後回傳
```

**為什麼要這樣設計？**
- Supabase: 控制哪些課程要顯示（快速開關）
- Notion: 管理課程內容（方便編輯）
- 兩者結合: 靈活性 + 易用性

---

## 資料庫結構

### Supabase 資料表

#### 1. `courses` 資料表

```sql
CREATE TABLE courses (
  course_id INT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**說明**: 僅儲存要顯示的 course_id，與 Notion 的課程資料對應。

#### 2. `orders` 資料表

```sql
CREATE TABLE orders (
  order_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  course_id INT NOT NULL,
  course_variant VARCHAR(10) NOT NULL CHECK (course_variant IN ('group', 'single')),
  total INT NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'payed', 'messaged', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 設定 RLS (Row Level Security)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- 用戶只能看到自己的訂單
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
```

**欄位說明**:
- `order_id`: 訂單 ID (UUID)
- `user_id`: 用戶 ID（關聯到 auth.users）
- `course_id`: 課程 ID
- `course_variant`: 上課方式（`group` 小班制 / `single` 一對一）
- `total`: 訂單金額（新台幣）
- `state`: 訂單狀態
  - `created`: 已建立，等待繳費
  - `payed`: 已繳費，等待審核
  - `messaged`: 已聯繫客服
  - `confirmed`: 已確認，課程開通

#### 3. `profiles` 資料表

```sql
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  email VARCHAR(255),
  full_name VARCHAR(100),
  phone VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 設定 RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = user_id);
```

### Notion Databases

詳細欄位結構請參考 [NOTION_SETUP.md](./NOTION_SETUP.md)

#### 1. Products Database (課程資料)

**重要欄位**:
- `course_id` (Number) - 與 Supabase courses.course_id 對應
- `published` (Checkbox) - 是否發布
- `sort_desc` (Number) - 排序權重（越大越前面）
- `en_name` / `zh_name` (Title/Text) - 課程名稱
- `en_description` / `zh_description` (Text) - 課程描述
- `image` (File) - 課程封面圖
- `en_category` / `zh_category` (Multi-select) - 課程分類
- `featured` (Checkbox) - 是否為精選課程
- `group_price` / `group_price_early` (Number) - 小班制價格/早鳥價
- `single_price` / `single_price_early` (Number) - 一對一價格/早鳥價
- `content_video` (File) - 課程介紹影片
- `content_highlight1~6` (Text) - 課程亮點標題
- `content_highlight1~6_description` (Text) - 課程亮點說明
- `content_highlight1~6_image` (File) - 課程亮點圖片
- `bar_text_1~4` (Text) - 課程特色標籤
- `you_will_learn` (Text) - 你將學會...
- `skill_tags` (Multi-select) - 技能標籤
- `content_tags` (Multi-select) - 內容標籤
- `summery` (Text) - 課程摘要

#### 2. Our Story Database (品牌故事)
#### 3. Our Values Database (價值觀)
#### 4. Our Team Database (團隊介紹)
#### 5. Mission & Vision Database (使命與願景)
#### 6. Contact Submissions Database (聯絡表單)

---

## 部署與維護

### 部署到 Vercel

1. **連結 GitHub Repository**
   ```bash
   # 確保專案已推送到 GitHub
   git remote -v
   ```

2. **在 Vercel 建立專案**
   - 前往 https://vercel.com/dashboard
   - Import GitHub Repository
   - 選擇此專案

3. **設定環境變數**
   - 在 Vercel 專案設定中加入所有 `.env.local` 的變數

4. **部署**
   - Vercel 會自動部署
   - 每次推送到 `main` 分支都會自動重新部署

### 維護清單

#### 每週檢查
- [ ] 檢查 Notion API 連線是否正常
- [ ] 檢查 Supabase 資料庫連線
- [ ] 檢查新的聯絡表單提交

#### 每月檢查
- [ ] 更新套件版本（`pnpm update`）
- [ ] 檢查 Vercel 部署日誌
- [ ] 備份 Supabase 資料庫

---

## 常見問題排解

### Q1: 課程列表頁顯示空白

**可能原因**:
1. Notion API Token 錯誤或過期
2. Supabase courses 資料表為空
3. Notion Products Database 中沒有 `published: true` 的課程

**解決方法**:
```bash
# 檢查環境變數
cat .env.local | grep NOTION_TOKEN

# 檢查 Supabase courses 資料表
# 前往 Supabase Dashboard → Table Editor → courses
```

### Q2: 無法登入/註冊

**可能原因**:
- Supabase Auth 設定問題

**解決方法**:
1. 前往 Supabase Dashboard → Authentication → Providers
2. 確認 Email provider 已啟用
3. 檢查 Site URL 設定

### Q3: 課程報名後無法看到訂單

**可能原因**:
- RLS (Row Level Security) 設定問題
- profiles 資料表未建立

**解決方法**:
1. 檢查 Supabase RLS policies
2. 確認 profiles 資料表存在且有對應紀錄

### Q4: 環境變數無法讀取

**可能原因**:
- Next.js 需要重啟才能讀取新的環境變數

**解決方法**:
```bash
# 停止開發伺服器後重新啟動
pnpm dev
```

---

## 聯絡資訊

**公司資訊**:
- 登記名稱: 思考者咖啡有限公司
- 統一編號: 00207322
- Email: hello@thinker.cafe
- 手機: 0937-431-998

**技術支援**:
- 如有任何問題，請聯繫開發團隊或參考 README.md

---

## 附錄

### 專案結構

```
thinker_official_website/
├── app/                    # Next.js App Router 目錄
│   ├── page.tsx           # 首頁
│   ├── products/          # 課程列表
│   ├── buy-course/        # 課程報名
│   ├── orders/            # 我的課程
│   ├── order/[order_id]/  # 單一訂單頁
│   ├── signin/            # 登入
│   ├── signup/            # 註冊
│   ├── more-info/         # 更多資訊
│   ├── about/             # 關於我們
│   ├── contact/           # 聯絡我們
│   └── api/               # API Routes
├── components/            # React 元件
│   ├── core/              # 核心元件
│   └── ui/                # shadcn/ui 元件
├── lib/                   # 函式庫
│   └── notion.ts          # Notion API 封裝
├── utils/                 # 工具函式
│   ├── supabase/          # Supabase 客戶端
│   └── ...
├── public/                # 靜態檔案
├── styles/                # 樣式檔案
├── .env.local             # 環境變數（需自行建立）
├── .env.example           # 環境變數範例
├── package.json           # 專案設定
├── README.md              # 專案說明
├── NOTION_SETUP.md        # Notion 設定指南
└── TAKEOVER_GUIDE.md      # 本文件
```

### 常用指令

```bash
# 安裝依賴
pnpm install

# 啟動開發伺服器
pnpm dev

# 建置生產版本
pnpm build

# 啟動生產伺服器
pnpm start

# 程式碼檢查
pnpm lint
```

---

**文件版本**: v1.0
**最後更新**: 2025-11-02
**維護者**: Thinker Cafe Team
