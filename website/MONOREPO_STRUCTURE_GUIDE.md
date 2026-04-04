# Thinker-Cafe Monorepo 結構完全指南

## 整體視圖

```
thinker-cafe/                          # Git Root (版本控制)
│
├── 📚 知識庫層 (跨專案共享)
│   └── knowledge-base/
│       ├── CLAUDE_ROOT.md             # 🔑 根記憶系統 (所有專案繼承)
│       ├── profile/                   # Cruz 個人資料
│       ├── content/                   # 可複用內容
│       └── automation/                # 同步腳本
│
├── 🎯 產品線層 (ThinkerCafe 品牌)
│   └── projects/
│       ├── website/                   # ⭐ 主應用 (Next.js)
│       │   └── 課程、會員、ThinkerKit
│       ├── resume/                    # Cruz 履歷 (靜態 HTML)
│       ├── news/                      # 🆕 新聞系統 (Python + GitHub Actions)
│       ├── template/                  # 新專案範本
│       └── [其他演進版本...]
│
├── 🚀 客戶應用層 (獨立品牌)
│   └── apps/
│       ├── template/                  # 客戶專案範本
│       ├── meri-bot/                  # (未來) Telegram Bot
│       ├── pcb-erp/                   # (未來) 昌明鑽孔 ERP
│       └── [客戶應用...]
│
├── 📦 共用資源層 (目前為空)
│   └── packages/
│       └── [共用庫、工具、組件...]
│
├── 🛠️ 自動化層
│   ├── scripts/
│   │   └── init-project.sh            # 新專案初始化工具
│   └── .github/
│       └── workflows/                 # GitHub Actions 配置
│
└── ⚙️ Monorepo 配置
    ├── package.json                   # 根級 package (workspace 定義)
    ├── pnpm-workspace.yaml            # pnpm 工作區配置
    ├── turbo.json                     # Turbo 構建配置
    ├── vercel.json                    # Vercel 部署配置
    ├── .gitignore                     # Git 忽略規則
    ├── README.md                      # 主文檔
    ├── PROJECT_STATUS.md              # 建置狀態
    ├── THINKER_NEWS_INTEGRATION_GUIDE.md  # 新聞整合指南
    ├── INTEGRATION_SUMMARY.md         # 整合摘要
    └── MONOREPO_STRUCTURE_GUIDE.md    # 本文件
```

---

## 各層級詳細說明

### 層級 1: 知識庫層 (knowledge-base/)

**用途**: 跨專案的共享知識和記憶

**結構**:
```
knowledge-base/
├── CLAUDE_ROOT.md           # 根記憶 - Cruz 的數位分身
├── profile/
│   ├── personal.yaml        # 個人資料
│   ├── professional.yaml    # 專業背景
│   └── social.yaml          # 社交平台
├── content/
│   ├── courses/             # 課程相關內容
│   ├── articles/            # 文章庫
│   └── templates/           # 可複用模板
└── automation/
    ├── sync-knowledge.py    # 知識同步腳本
    ├── backup.sh            # 備份腳本
    └── update-profiles.py   # 資料更新腳本
```

**特點**:
- 由 Turbo 的 `globalDependencies` 監控
- 任何更改都觸發其他專案的重新構建
- 所有專案 CLAUDE.md 都從此繼承

---

### 層級 2: 產品線層 (projects/)

**用途**: ThinkerCafe 品牌下的所有應用和工具

**共同特徵**:
- 同一品牌: ThinkerCafe
- 同一網域: thinker.cafe (或 subdomain)
- 共享認證: NextAuth.js
- 共享資料: Vercel Postgres
- 統一部署: Vercel

**項目分類**:

#### 2.1 Website (主應用)
```
projects/website/
├── app/                     # Next.js App Router
│   ├── (public)/           # 公開頁面
│   ├── (auth)/             # 需認證頁面
│   ├── api/                # 後端 API
│   └── layout.tsx
├── components/             # React 組件
├── lib/                    # 工具和配置
├── public/                 # 靜態文件
├── CLAUDE.md              # AI 記憶
├── package.json           # 應用配置
└── next.config.js         # Next.js 配置
```

**功能**:
- 課程展示與報名
- 會員中心 (/dashboard)
- @cruz 個人主頁
- ThinkerKit 整合 (/kit/*)

#### 2.2 Resume (個人履歷)
```
projects/resume/
├── index.html             # 主頁面
├── data.json              # 多語系數據
├── styles.css             # 樣式
├── scripts/
│   └── translate.py       # AI 翻譯腳本
├── CLAUDE.md              # AI 記憶
├── package.json           # 配置
└── vercel.json            # Vercel 配置
```

**特點**:
- 靜態網站
- JSON 驅動的多語系
- AI 輔助翻譯

#### 2.3 News (新增 - 新聞系統)
```
projects/news/
├── .github/workflows/     # GitHub Actions
│   └── daily-news.yml     # 每天 06:00 執行
├── scripts/               # Python 主邏輯
│   ├── main.py            # 主執行腳本
│   ├── rss_fetcher.py     # RSS 讀取
│   ├── news_filter.py     # 台灣本地化篩選
│   ├── ai_processor.py    # AI 處理鏈
│   ├── html_generator.py  # HTML 生成
│   ├── utils.py           # 工具函數
│   └── notify_slack.py    # Slack 通知
├── api/                   # Vercel Serverless
│   └── line-webhook.py    # LINE 機器人 webhook
├── docs/                  # 文檔和指南
├── requirements.txt       # Python 依賴
├── CLAUDE.md              # AI 記憶
├── package.json           # NPM 配置
└── .gitignore             # Git 忽略規則
```

**特點**:
- Python + GitHub Actions
- 自動化系統
- 多渠道發佈 (網頁、LINE、Notion)

---

### 層級 3: 客戶應用層 (apps/)

**用途**: 獨立客戶項目

**共同特徵**:
- 獨立品牌
- 獨立網域
- 獨立認證
- 獨立資料庫
- 各自部署到 Vercel

**範例結構**:
```
apps/
├── template/              # 客戶項目範本
│   ├── CLAUDE.md
│   ├── package.json
│   └── README.md
├── meri-bot/             # (未來) Telegram Bot
│   ├── src/
│   ├── CLAUDE.md
│   ├── package.json
│   └── requirements.txt
└── pcb-erp/              # (未來) ERP 系統
    ├── app/              # Next.js
    ├── CLAUDE.md
    ├── package.json
    └── vercel.json
```

---

### 層級 4: 共用資源層 (packages/)

**用途**: 跨專案的可複用代碼

**目前**: 為空

**未來可能**:
```
packages/
├── ui/                    # 共用 UI 組件庫
├── utils/                 # 工具函數集
├── hooks/                 # React 自定義 Hook
├── config/                # 共用配置
└── types/                 # 共用 TypeScript 類型
```

---

### 層級 5: Monorepo 根級配置

#### package.json
```json
{
  "name": "thinker-cafe-monorepo",
  "version": "1.0.0",
  "private": true,
  "workspaces": ["apps/*", "projects/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "deploy": "turbo run deploy",
    "sync:knowledge": "node scripts/sync-knowledge.js",
    "init:project": "./scripts/init-project.sh"
  }
}
```

**作用**: 定義工作區，支援 pnpm 連結

#### pnpm-workspace.yaml
```yaml
packages:
  - 'apps/*'
  - 'projects/*'
  - 'packages/*'
```

**作用**: pnpm 工作區配置

#### turbo.json
```json
{
  "globalDependencies": ["knowledge-base/**"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": { "cache": false, "persistent": true }
  }
}
```

**作用**: Turbo 構建配置

---

## Thinker-News 整合對比

### 遷移前後結構

#### 遷移前
```
~
├── Documents/
│   ├── thinker-news/      # 獨立目錄
│   │   ├── scripts/
│   │   ├── api/
│   │   └── ...
│   └── thinker-cafe/      # 主 Monorepo
│       ├── projects/
│       ├── apps/
│       └── ...
```

**問題**: 
- 兩個獨立的 Git repos
- 知識系統分離
- 難以共享工具和配置

#### 遷移後
```
~
└── Documents/
    └── thinker-cafe/      # 統一 Monorepo
        ├── knowledge-base/
        ├── projects/
        │   ├── website/
        │   ├── resume/
        │   ├── news/      # 整合進來
        │   └── template/
        ├── apps/
        └── scripts/
```

**優勢**:
- 單一 Git repo
- 共享知識系統
- 統一配置管理
- 更好的項目組織

---

## AI 記憶層次結構

### 三層繼承模型

```
Layer 0: CLAUDE_ROOT.md
│
├─ Cruz 的核心身份
├─ 專業背景
├─ 價值觀和風格
└─ 跨專案共用知識
│
└─ (被所有專案繼承)
    │
    ├─ Layer 1: projects/website/CLAUDE.md
    │   ├─ 繼承 Layer 0
    │   ├─ 課程管理知識
    │   └─ 會員系統知識
    │
    ├─ Layer 1: projects/news/CLAUDE.md
    │   ├─ 繼承 Layer 0
    │   ├─ 新聞處理邏輯
    │   └─ AI 人格定義
    │
    └─ Layer 1: apps/{name}/CLAUDE.md
        ├─ 繼承 Layer 0
        ├─ 客戶特定知識
        └─ 項目特定邏輯
```

### 繼承語法

每個專案的 CLAUDE.md 開始:

```yaml
---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: project-name
persona: Role Name
project_type: [internal_automation|client_project|internal_tool]
---
```

---

## 命名慣例完整指南

### 目錄和檔案名

| 層級 | 名稱類型 | 規範 | 例子 |
|-----|---------|------|------|
| Package | NPM 包 | `@thinker-cafe/{name}` | `@thinker-cafe/news` |
| 專案 | 目錄 | kebab-case | `projects/news` |
| Python | 檔案 | snake_case | `news_filter.py` |
| Python | 類 | PascalCase | `NewsFilter` |
| Python | 函數 | snake_case | `filter_news()` |
| JavaScript | 檔案 | kebab-case | `daily-news.yml` |
| TypeScript | 檔案 | kebab-case | `news-api.ts` |
| TypeScript | 類型 | PascalCase | `NewsItem` |
| TypeScript | 接口 | PascalCase | `INewsFilter` |
| 環境變數 | - | UPPER_SNAKE | `GOOGLE_API_KEY` |

### 檔案結構命名

```
projects/{project-name}/
├── scripts/                 # 邏輯腳本
├── api/                     # API 端點
├── lib/                     # 工具庫
├── components/              # (React) 組件
├── hooks/                   # (React) Hooks
├── styles/                  # 樣式
├── public/                  # 靜態資源
├── tests/                   # 測試
├── docs/                    # 文檔
├── CLAUDE.md               # AI 記憶
├── README.md               # 說明文檔
├── package.json            # 包配置
└── .gitignore              # Git 忽略
```

---

## 部署拓撲

### Vercel 部署結構

```
thinker-cafe/ (根 Repo)
│
└─ Vercel 部署配置 (vercel.json)
   │
   ├─ projects/website         → thinker.cafe
   │   └─ 自動從 GitHub 部署
   │
   ├─ projects/resume          → resume.thinker.cafe
   │   └─ 自動從 GitHub 部署 (可選)
   │
   ├─ projects/news/api        → Vercel Serverless (可選)
   │   └─ LINE webhook 端點
   │
   └─ apps/{project}           → {project}.example.com
       └─ 各自獨立部署

GitHub Actions
│
└─ projects/news
   ├─ .github/workflows/daily-news.yml
   └─ 每天 06:00 UTC 自動執行 (與 Vercel 無關)
```

---

## 開發工作流程

### 本地開發

```bash
# 進入 monorepo
cd ~/Documents/thinker-cafe

# 安裝所有依賴 (一次性)
pnpm install

# 開發特定項目
cd projects/news
python scripts/main.py

cd projects/website
pnpm dev

# 使用 Turbo 執行多個項目
pnpm dev      # 執行所有 dev 任務
pnpm build    # 構建所有項目
```

### 新項目初始化

```bash
# 創建新客戶項目
./scripts/init-project.sh new-client-name

# 會自動創建:
# - apps/new-client-name/
# - 包含 CLAUDE.md, package.json, README.md
```

---

## Git 管理策略

### Monorepo 的單一 Git Repo

```
所有代碼
└── 一個 GitHub Repo
    ├── 所有提交歷史
    ├── 所有分支
    └── 所有 PR
```

**優勢**:
- 原子性提交 (修改多個項目時)
- 統一的版本控制
- 簡化 CI/CD 配置

**注意**:
- 需要明確的提交消息前綴:
  ```
  feat(projects/news): add new filter logic
  fix(apps/meri-bot): correct bot response
  docs(knowledge-base): update Cruz profile
  ```

### .gitignore 策略

**根級** (thinker-cafe/.gitignore):
```
node_modules/
.env.local
.DS_Store
*.log
.turbo/
```

**項目級** (projects/{name}/.gitignore):
- Python 項目: `__pycache__/`, `*.pyc`, `venv/`
- Next.js 項目: `.next/`, `out/`
- 生成文件: `dist/`, `build/`

---

## 性能優化

### Turbo 快取

```
turbo.json 配置
│
├─ build 任務
│   └─ 緩存 .next/ 和 dist/
│   └─ 依賴關係: depends on ^build
│   └─ 支持增量構建
│
└─ dev 任務
    └─ 不緩存 (watch mode)
    └─ persistent: true
```

### 工作區優化

```
pnpm-workspace 配置
│
└─ 使用 symlink (軟連結)
   ├─ 加速本地開發
   ├─ 支援跨項目依賴
   └─ 自動重新安裝依賴
```

---

## 監控和維護

### 項目健康檢查

```bash
# 列出所有工作區項目
pnpm list -r

# 檢查依賴更新
pnpm outdated

# 驗證 monorepo 結構
ls -la projects/
ls -la apps/

# 查看 Git 狀態
git status
git log --oneline | head -20
```

### 常見問題排查

| 問題 | 原因 | 解決 |
|------|------|------|
| `Cannot find module` | 依賴未安裝 | `pnpm install` |
| 構建失敗 | 循環依賴 | 檢查 turbo.json |
| 部署失敗 | 路徑錯誤 | 檢查 vercel.json |
| 環境變數未找到 | 未配置 GitHub Secrets | GitHub Settings → Secrets |

---

## 快速參考表

### 各層級職責

| 層級 | 職責 | 所有者 |
|-----|------|--------|
| knowledge-base | 共享知識 | Cruz (所有人可提交) |
| projects | ThinkerCafe 品牌應用 | Cruz + 開發團隊 |
| apps | 客戶應用 | 具體客戶或開發者 |
| packages | 共用代碼 | 開發團隊 |
| scripts | 自動化工具 | DevOps/開發團隊 |

### 技術棧決策矩陣

| 項目類型 | 推薦框架 | 部署方式 | 數據庫 |
|--------|---------|---------|-------|
| 網頁應用 | Next.js 15 | Vercel | Postgres |
| 靜態網站 | HTML/Astro | Vercel/GitHub Pages | N/A |
| CLI 工具 | Python/Node | GitHub Actions | N/A |
| 客戶應用 | Next.js/自選 | Vercel | Supabase/自選 |

---

## 資源清單

### 重要文檔位置

| 文檔 | 位置 | 用途 |
|-----|------|------|
| Monorepo README | `README.md` | 整體介紹 |
| 項目狀態 | `PROJECT_STATUS.md` | 構建進度 |
| 新聞整合指南 | `THINKER_NEWS_INTEGRATION_GUIDE.md` | 整合詳解 |
| 整合摘要 | `INTEGRATION_SUMMARY.md` | 快速指南 |
| 本文件 | `MONOREPO_STRUCTURE_GUIDE.md` | 結構詳解 |
| 根記憶 | `knowledge-base/CLAUDE_ROOT.md` | AI 記憶 |

### 外部資源

- [Monorepo.tools](https://monorepo.tools)
- [Turbo 官方文檔](https://turbo.build)
- [pnpm Workspaces](https://pnpm.io/workspaces)
- [Vercel Deployment](https://vercel.com/docs)

---

## 下一步

1. **了解結構**: 瀏覽本文檔和 README.md
2. **學習流程**: 研讀 `THINKER_NEWS_INTEGRATION_GUIDE.md`
3. **開始整合**: 按照 `INTEGRATION_SUMMARY.md` 的步驟執行
4. **建立新項目**: 當需要新客戶項目時，使用 `./scripts/init-project.sh`

---

**Made with by Claude Code**  
**For Cruz Tang**  
**Date: 2025-11-08**

