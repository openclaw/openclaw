# Thinker-News 整合進 Thinker-Cafe Monorepo - 詳細分析報告

**報告生成日期**: 2025-11-08  
**分析層級**: Medium  
**目標**: 為 thinker-news 在 thinker-cafe monorepo 中的位置和整合方式提供完整指導

---

## 1. Monorepo 整體架構分析

### 1.1 目錄結構和功能定位

```
thinker-cafe/
├── knowledge-base/              # 📚 Cruz 的數位分身 (Level 0)
│   ├── CLAUDE_ROOT.md          # 根記憶系統 (所有專案繼承)
│   ├── profile/                # 結構化個人資料
│   ├── content/                # 可複用內容
│   └── automation/             # 同步腳本
│
├── projects/                    # 🎯 ThinkerCafe 產品線
│   ├── website/                # thinker.cafe 統一應用 (Next.js 15)
│   ├── resume/                 # resume.thinker.cafe (Cruz 履歷)
│   ├── template/               # 新專案範本
│   ├── website-fresh/          # 備用/演進版本
│   ├── my-awesome-project/     # 示例專案
│   └── website.backup-monorepo-attempt/  # 備份
│
├── apps/                        # 🚀 客戶接案專案 (獨立網域)
│   ├── template/               # 客戶專案範本
│   └── (未來: meri-bot, pcb-erp 等)
│
├── packages/                    # 📦 共用資源 (目前為空)
│
├── scripts/                     # 🛠️ 自動化工具
│   └── init-project.sh         # 新專案初始化
│
└── 根級配置
    ├── package.json            # Monorepo 配置
    ├── pnpm-workspace.yaml     # pnpm 工作區
    ├── turbo.json              # Turbo 構建配置
    ├── vercel.json             # Vercel 部署配置
    └── .gitignore              # Git 忽略規則
```

### 1.2 核心配置檔案詳解

**package.json (Monorepo 根)**
- workspaces: `["apps/*", "projects/*", "packages/*"]`
- scripts: `dev`, `build`, `deploy`, `sync:knowledge`, `init:project`
- 依賴: Next.js 15, React 19, TypeScript 5, Turbo 2.0, Tailwind 4.1

**pnpm-workspace.yaml**
```yaml
packages:
  - 'apps/*'
  - 'projects/*'
  - 'packages/*'
```
- 簡單明確，遵循 pnpm 標準
- 支援符號連結 (symlink)，加速本地開發

**turbo.json**
```json
{
  "globalDependencies": ["knowledge-base/**"],
  "pipeline": {
    "build": { "dependsOn": ["^build"], "outputs": [".next/**", "dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "deploy": { "dependsOn": ["build"] }
  }
}
```
- 將 knowledge-base 設為全局依賴 (任何更新都觸發重建)
- build 任務支持增量構建
- dev 禁用快取，保證實時重載

**vercel.json (Monorepo 級)**
```json
{
  "buildCommand": "pnpm install && cd projects/website && pnpm build",
  "installCommand": "pnpm install",
  "outputDirectory": "projects/website/.next"
}
```
- 只部署 `projects/website` (主產品)
- apps/ 專案各自獨立部署

### 1.3 AI 記憶系統架構

**3層級記憶模型**:

```
Level 0: knowledge-base/CLAUDE_ROOT.md
└─ Cruz 的完整數位分身
   ├─ 核心身份與價值觀
   ├─ 專業背景與經歷
   ├─ 溝通風格與決策框架
   └─ 所有專案共用的知識

Level 1: projects/website/CLAUDE.md  |  apps/*/CLAUDE.md
└─ 應用/專案特定記憶
   ├─ 該應用/專案的專用知識
   ├─ 特定功能文檔
   └─ 業務邏輯說明

Level 2: (可選) 模組級 CLAUDE.md
└─ 深層細節
```

**繼承機制**:
```yaml
# 每個專案 CLAUDE.md 的開頭
---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: [專案名稱]
persona: [角色定位]
---
```

---

## 2. Projects vs Apps - 區別與定位

### 2.1 Projects/ (ThinkerCafe 產品線)

**特徵**:
- 同一品牌: ThinkerCafe
- 同一網域: thinker.cafe
- 共享認證: NextAuth.js
- 共享資料: Vercel Postgres

**現有專案**:
1. **website/** - 主統一應用
   - 框架: Next.js 15 + React 19
   - 內容: 課程展示、報名、@cruz 個人頁、會員中心
   - 整合: ThinkerKit (成長工具), Notion (課程同步)
   - 部署: Vercel (thinker.cafe)

2. **resume/** - Cruz 個人履歷
   - 框架: 靜態 HTML
   - 內容: 多語系履歷數據 (JSON 控制)
   - 部署: Vercel (resume.thinker.cafe)

### 2.2 Apps/ (客戶接案專案)

**特徵**:
- 不同品牌: 客戶品牌或個人專案
- 獨立網域: 各自網域或子網域
- 獨立認證: 各自的使用者系統
- 獨立資料: 各自的資料庫

**部署方式**:
- 各自獨立在 Vercel 部署
- 在 Monorepo 中統一管理代碼
- 通過 `init-project.sh` 快速初始化新專案

---

## 3. Thinker-News 的位置分析

### 3.1 專案特性

**現有架構**:
```
thinker-news/
├── .github/workflows/           # GitHub Actions 配置
├── scripts/                     # Python 腳本 (n8n 遷移)
├── api/                         # Vercel Serverless Functions
├── docs/                        # 文檔
├── private/                     # 敏感資訊
├── 生成的 HTML 文件 (YYYY-MM-DD.html)
├── 生成的 JSON 數據 (latest.json)
└── Python 依賴 & 配置
```

**核心特性**:
- 自動化新聞生成系統 (每天 06:00 UTC+8)
- Python + GitHub Actions 技術棧
- RSS 讀取 → 台灣本地化篩選 → AI 處理 → HTML/JSON 生成
- 支援多渠道發佈 (網頁、LINE、Notion)

**構建方式**:
- GitHub Actions 定時觸發 (cron)
- 不需要構建步驟 (無 Next.js/Webpack)
- 直接生成靜態文件和 JSON API
- 支援本地測試和部署

### 3.2 整合位置判斷

| 屬性 | Projects | Apps | ThinkerNews |
|-----|---------|------|------------|
| 品牌 | ThinkerCafe | 客戶品牌 | ThinkerCafe |
| 網域 | thinker.cafe | 獨立 | thinker.cafe 或獨立 |
| 認證 | 共享 NextAuth | 獨立 | N/A (自動化) |
| 技術棧 | Next.js | 通用 | Python + GitHub Actions |
| 用途 | 統一應用 | 客戶應用 | 自動化工具 + 內容生成 |

**結論**: **Thinker-News 應該在 `projects/` 下**

理由:
1. ThinkerCafe 品牌專屬 → 應該在 projects/
2. thinker.cafe 網域相關 (至少在首頁展示) → 應該在 projects/
3. 不是客戶項目 → 不適合在 apps/
4. 是核心內容生成系統 → 應該靠近主應用

---

## 4. 建議的整合方案

### 4.1 目錄結構

```
thinker-cafe/
├── projects/
│   ├── website/              # 現有: 主應用
│   ├── resume/               # 現有: 履歷
│   ├── news/                 # 新增: Thinker-News ⭐
│   │   ├── .github/workflows/
│   │   │   └── daily-news.yml
│   │   ├── scripts/
│   │   │   ├── main.py
│   │   │   ├── rss_fetcher.py
│   │   │   ├── news_filter.py
│   │   │   ├── ai_processor.py
│   │   │   ├── html_generator.py
│   │   │   ├── utils.py
│   │   │   └── notify_slack.py
│   │   ├── api/               # Vercel Serverless (LINE webhook)
│   │   │   └── line-webhook.py
│   │   ├── docs/
│   │   ├── private/
│   │   ├── requirements.txt
│   │   ├── vercel.json
│   │   ├── CLAUDE.md          # AI 記憶檔案 ⭐
│   │   ├── README.md
│   │   ├── package.json       # 根級 package.json (保持兼容)
│   │   └── 生成的輸出檔案
│   └── template/
└── 其他...
```

### 4.2 Package.json 配置

**projects/news/package.json**:
```json
{
  "name": "@thinker-cafe/news",
  "version": "1.0.0",
  "private": true,
  "description": "Thinker News - AI 自動化新聞日報系統",
  "type": "module",
  "scripts": {
    "dev": "echo 'News automation (runs on GitHub Actions)'",
    "build": "echo 'Build news artifacts'",
    "generate": "python scripts/main.py",
    "test": "python scripts/test_local.py",
    "deploy": "python scripts/main.py && git add . && git commit -m 'Daily news update' && git push"
  },
  "keywords": ["news", "automation", "ai", "github-actions"],
  "engines": {
    "python": ">=3.11"
  }
}
```

**重點**:
- 使用 `@thinker-cafe/news` 作為包名稱 (遵循 monorepo 慣例)
- 包含 Python 命令
- 支援本地執行和測試
- 可選的 GitHub Actions 集成

### 4.3 AI 記憶文件 (CLAUDE.md)

**projects/news/CLAUDE.md**:

```markdown
# Thinker News - AI 自動化新聞日報系統

---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: thinker-news
persona: News Automation AI
project_type: internal_automation
---

## 🎯 專案身份

### 核心定位
- **專案名稱**: Thinker News
- **用途**: AI 驅動的每日新聞聚合與分析
- **使用者**: ThinkerCafe 用戶、LINE 訂閱者、Notion 筆記本
- **執行方式**: GitHub Actions + Python
- **執行頻率**: 每天 UTC 22:00 (台灣時間 06:00)

### 與其他專案的關係
- **主應用**: projects/website - 可展示最新新聞在首頁
- **LINE 機器人**: 通過 Vercel Serverless 發佈到 LINE
- **Notion 整合**: 每日新聞自動同步到 Notion
- **RSS**: 外部訂閱源輸入

## 🏗️ 系統架構

### 執行流程
```
GitHub Actions (每天 06:00 UTC+8)
  ↓
Python 主腳本 (scripts/main.py)
  ├─ RSS 讀取 (rss_fetcher.py)
  │   └─ 7 個來源: technews, ithome, TechCrunch, HN, ATA, OpenAI, Berkeley
  ├─ 台灣本地化篩選 (news_filter.py)
  │   └─ 智能評分 + 關鍵字匹配
  ├─ AI 處理鏈 (ai_processor.py)
  │   ├─ 數據煉金術師 (Gemini) - 標題/內容處理
  │   ├─ 科技導讀人 (OpenAI) - 完整日報撰寫
  │   └─ 總編輯 (OpenAI) - LINE 快訊提煉
  ├─ HTML 生成 (html_generator.py)
  │   └─ Jinja2 模板 → YYYY-MM-DD.html
  ├─ JSON API (utils.py)
  │   └─ latest.json 供前端使用
  └─ 通知 (notify_slack.py)
      └─ Slack 通知成功/失敗
```

### 核心模組

#### 1. RSS Fetcher (rss_fetcher.py)
- 並行讀取 7 個新聞源
- 提供原始文章列表
- 錯誤處理與重試機制

#### 2. News Filter (news_filter.py) ⭐ 核心特色
- **台灣本地化篩選**: 完全移植自 n8n 的 Code3 邏輯
- **評分系統**:
  - 基礎分數: 按來源優先級
  - 關鍵字加分: Taiwan interest + global trends
  - 排除詞扣分: 財經、募資等不相關內容
  - 實用性加分: 教學、評測等高價值內容
- **平衡策略**: 本地與國際新聞交錯混合
- **輸出**: 排序後的新聞列表 (約 15-20 篇)

#### 3. AI Processor (ai_processor.py)
- **數據煉金術師** (Gemini API)
  - 功能: 標題轉譯、內容摘要、智慧分類、價值排序
  - 輸入: 原始新聞列表
  - 輸出: 結構化新聞數據 (JSON)

- **科技導讀人** (OpenAI GPT-4)
  - 功能: 精選 8-10 則新聞、撰寫完整 Notion 日報、附加學習價值分析
  - 輸入: 結構化新聞
  - 輸出: Notion 日報 (Markdown)

- **總編輯** (OpenAI GPT-4)
  - 功能: 提煉 LINE 快訊、智能品管、清理生成痕跡
  - 輸入: Notion 日報
  - 輸出: LINE 短文本 (200-300 字)

#### 4. HTML Generator (html_generator.py)
- 使用 Jinja2 模板
- 生成 YYYY-MM-DD.html (今日新聞頁面)
- 更新 index.html (首頁)
- 生成 latest.json (API 使用)

#### 5. Utils (utils.py)
- Taiwan timezone date handling
- JSON validation & repair
- Error handling & logging
- Retry mechanisms

#### 6. Slack Notifier (notify_slack.py)
- 發送執行成功/失敗通知
- 包含執行統計
- 可選的詳細日誌

## 📦 技術依賴

### Python 環境
```
Python >= 3.11
feedparser       # RSS 解析
jinja2           # HTML 模板
google-generativeai  # Gemini API
openai           # OpenAI API
requests         # HTTP 請求
python-dotenv    # 環境變數
```

### 外部服務
- Google Gemini API (免費配額充足)
- OpenAI GPT-4 API (~$0.05-0.10 每天)
- Slack Webhook (可選)
- LINE Bot API (發佈功能)

### GitHub Actions
- 免費 2000 分鐘/月
- 每天執行 5-10 分鐘
- 成本: $0

## 🔄 工作流程詳解

### 每日執行步驟
1. **觸發**: GitHub Actions cron (每天 UTC 22:00)
2. **初始化**: 生成台灣時區日期
3. **RSS 讀取**: 並行讀取 7 個源 (~2 分鐘)
4. **篩選**: 應用台灣本地化邏輯 (~1 分鐘)
5. **AI 處理**: 三段式 AI 處理鏈 (~3-5 分鐘)
6. **生成**: HTML + JSON (~1 分鐘)
7. **部署**: Git 提交 + GitHub Pages (~1 分鐘)
8. **通知**: Slack + LINE 通知 (~1 分鐘)

**總耗時**: 約 8-12 分鐘

## 🔐 環境變數 & Secrets

### GitHub Secrets (必須)
```
GOOGLE_API_KEY          # Gemini API Key
OPENAI_API_KEY          # OpenAI API Key
SLACK_WEBHOOK_URL       # (可選) Slack 通知
LINE_CHANNEL_ACCESS_TOKEN  # (可選) LINE 發佈
```

### 本地開發 (.env)
```
GOOGLE_API_KEY=...
OPENAI_API_KEY=...
SLACK_WEBHOOK_URL=...
DEBUG=true
```

## 📊 成本分析

### 每月成本估算
- GitHub Actions: $0 (免費額度充足)
- Gemini API: $0-5 (免費配額)
- OpenAI API: ~$1.5-3 (按使用量)
- **總計**: ~$1.5-3/月 (vs. n8n 的 $20+)

## 🎯 集成要點

### 與 projects/website 的整合
1. **首頁展示**: 可在 website 首頁顯示最新新聞
2. **API 端點**: `/api/news/latest` 返回 latest.json
3. **內部連結**: 新聞詳情頁連結到完整 HTML
4. **Notion 同步**: 日報自動同步到 Notion 資料庫

### 與 knowledge-base 的關係
- 繼承 CLAUDE_ROOT.md 的 Cruz 身份
- 所有新聞內容體現 ThinkerCafe 的教育理念
- AI 人格設定遵循品牌指引

## 🚀 部署指南

### 本地測試
```bash
cd projects/news
pip install -r requirements.txt
export GOOGLE_API_KEY="your_key"
export OPENAI_API_KEY="your_key"
python scripts/main.py
```

### GitHub Actions 部署
1. 將整個 projects/news 目錄推送到 repo
2. 在 GitHub Settings → Secrets 配置 API keys
3. 驗證 .github/workflows/daily-news.yml
4. 推送後自動執行

## 📁 文件位置

### 生成的輸出
- **HTML**: `projects/news/YYYY-MM-DD.html` (日報頁面)
- **JSON**: `projects/news/latest.json` (API 數據)
- **索引**: `projects/news/index.html` (首頁)
- **日誌**: `projects/news/news_generation.log` (執行日誌)

### 配置文件
- **Workflow**: `projects/news/.github/workflows/daily-news.yml`
- **環境**: `projects/news/.env` (本地開發)
- **依賴**: `projects/news/requirements.txt`

## 💡 維護與優化

### 常見調整
1. **修改篩選邏輯**: 編輯 `news_filter.py` 的 FILTERS 配置
2. **調整 AI 提示詞**: 編輯 `ai_processor.py` 中的系統提示
3. **更改 RSS 來源**: 更新 `rss_fetcher.py` 的 RSS_SOURCES

### 監控與除錯
- 查看 GitHub Actions 日誌
- 檢查 `news_generation.log` 本地日誌
- Slack 通知提供快速反饋
- JSON 驗證確保數據完整性

## 🔄 版本歷史

- v1.0 (2025-11-08): 初始整合進 thinker-cafe monorepo
- (從 n8n 遷移的完整邏輯)

---

**最後更新**: 2025-11-08
**維護者**: Claude Code (协助 Cruz Tang)
**相關專案**: projects/website, knowledge-base
```

### 4.4 Git 和 .gitignore 配置

**projects/news/.gitignore**:
```
# Python
__pycache__/
*.py[cod]
*$py.class
*.so
venv/
env/

# Dependencies
node_modules/

# Environment
.env
.env.local
.env*.local

# Generated files
*.log
*.html
*.json
!.github/
!scripts/
!api/

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp
*.swo

# Vercel
.vercel/
```

### 4.5 Package Manager 配置

**根級 pnpm-workspace.yaml** 已配置為:
```yaml
packages:
  - 'apps/*'
  - 'projects/*'
  - 'packages/*'
```

無需修改，projects/news 會自動被 pnpm 認識為 workspace 的一部分。

---

## 5. 命名與結構規範

### 5.1 命名規範

| 層級 | 規範 | 範例 |
|-----|------|------|
| Package name | `@thinker-cafe/{name}` | `@thinker-cafe/news` |
| 目錄名 | kebab-case | `projects/news` |
| 檔案名 | snake_case (Python) | `news_filter.py` |
| 檔案名 | kebab-case (其他) | `daily-news.yml` |
| 模組名 | snake_case | `ai_processor` |
| 函數名 | snake_case | `process_news_items()` |
| Class 名 | PascalCase | `NewsFilter` |

### 5.2 專案結構規範

**最小結構**:
```
projects/{name}/
├── .github/
│   └── workflows/
│       └── *.yml              # CI/CD 配置
├── scripts/                   # 主要邏輯
│   ├── main.py
│   ├── *.py
│   └── utils.py
├── tests/                     # 測試 (可選)
├── docs/                      # 文檔 (可選)
├── CLAUDE.md                  # AI 記憶 (必須)
├── README.md                  # 說明文檔
├── package.json               # Package 配置
├── requirements.txt           # Python 依賴 (Python 項目)
├── vercel.json               # Vercel 配置 (如需部署)
└── .gitignore                # Git 忽略規則
```

### 5.3 CLAUDE.md 規範

每個專案必須有 CLAUDE.md，包含:

1. **前置元數據** (YAML):
```yaml
---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: [project-name]
persona: [AI 角色]
project_type: [internal_automation|client_project|internal_tool]
---
```

2. **核心章節**:
   - 🎯 專案身份
   - 🏗️ 系統架構
   - 📦 技術依賴
   - 🔄 工作流程
   - 🚀 部署指南
   - 💡 維護與優化

---

## 6. 文件遷移檢查清單

### 6.1 需要遷移的檔案

```
thinker-news/
├── .github/workflows/daily-news.yml      ✓
├── scripts/                              ✓
│   ├── main.py
│   ├── rss_fetcher.py
│   ├── news_filter.py
│   ├── ai_processor.py
│   ├── html_generator.py
│   ├── utils.py
│   └── notify_slack.py
├── api/line-webhook.py                  ✓
├── docs/                                 ✓
├── requirements.txt                      ✓
├── test_local.py                         ✓
├── README.md                             ✓ (可保留)
└── 生成的輸出 HTML/JSON                 ⚠️ (可選)
```

### 6.2 需要新建的檔案

```
projects/news/
├── CLAUDE.md                 ✓ (新建 - 上面提供了模板)
├── vercel.json              ✓ (可複製或新建)
├── .gitignore               ✓ (新建)
├── package.json             ✓ (新建)
└── private/                 ✓ (敏感資訊目錄)
```

### 6.3 需要刪除或清理的檔案

- `Icon` 檔案 (macOS 系統檔案)
- 舊的備份檔案
- 可選: 舊版 n8n workflow 備份 (保存在 docs 即可)

### 6.4 需要更新的參考路徑

在所有腳本和配置中，如果有硬編碼的路徑，需要更新:

```python
# 舊: ~/Documents/thinker-news
# 新: ~/Documents/thinker-cafe/projects/news

# 對於相對路徑:
# 使用 Python 的 pathlib 或 os.path
from pathlib import Path
project_root = Path(__file__).parent.parent  # 到達 projects/news
```

---

## 7. 整合步驟 (詳細操作指南)

### 第 1 步: 準備工作

```bash
# 確保備份原始 thinker-news
cp -r ~/Documents/thinker-news ~/Documents/thinker-news.backup

# 進入 monorepo
cd ~/Documents/thinker-cafe
```

### 第 2 步: 創建目錄結構

```bash
# 創建 projects/news 目錄
mkdir -p projects/news/{scripts,api,docs,.github/workflows}

# 保留必要子目錄
mkdir -p projects/news/private
```

### 第 3 步: 複製核心檔案

```bash
# 複製 Python 腳本
cp ~/Documents/thinker-news/scripts/*.py projects/news/scripts/
cp ~/Documents/thinker-news/requirements.txt projects/news/

# 複製 GitHub Actions workflow
cp ~/Documents/thinker-news/.github/workflows/*.yml projects/news/.github/workflows/

# 複製 API 檔案
cp ~/Documents/thinker-news/api/*.py projects/news/api/

# 複製文檔
cp -r ~/Documents/thinker-news/docs/* projects/news/docs/
```

### 第 4 步: 創建新檔案

```bash
# CLAUDE.md (使用上面提供的模板)
cat > projects/news/CLAUDE.md << 'EOF'
[複製上面的 CLAUDE.md 內容]
EOF

# package.json
cat > projects/news/package.json << 'EOF'
{
  "name": "@thinker-cafe/news",
  "version": "1.0.0",
  "private": true,
  "description": "Thinker News - AI 自動化新聞日報系統",
  "type": "module",
  "scripts": {
    "dev": "echo 'News automation (runs on GitHub Actions)'",
    "build": "echo 'Build news artifacts'",
    "generate": "python scripts/main.py",
    "test": "python scripts/test_local.py",
    "deploy": "python scripts/main.py && git add . && git commit -m 'Daily news update' && git push"
  }
}
EOF

# .gitignore (使用上面提供的)
cat > projects/news/.gitignore << 'EOF'
[複製上面的 .gitignore 內容]
EOF
```

### 第 5 步: 驗證和測試

```bash
# 驗證結構
ls -la projects/news/

# 檢查 pnpm 是否認識新專案
pnpm list -r

# 本地測試
cd projects/news
pip install -r requirements.txt
python scripts/test_local.py
```

### 第 6 步: Git 配置

```bash
# 新增到 Git
git add projects/news/

# 提交
git commit -m "feat: integrate thinker-news into monorepo as projects/news"

# 推送
git push origin main
```

### 第 7 步: GitHub Actions 配置

1. 進入 GitHub repo Settings → Secrets
2. 添加必要的 Secrets:
   - `GOOGLE_API_KEY`
   - `OPENAI_API_KEY`
   - `SLACK_WEBHOOK_URL`
3. 在 Actions 頁面手動觸發 workflow 測試
4. 驗證執行成功

### 第 8 步: 與 projects/website 集成 (可選)

如果想在主網站展示新聞:

```javascript
// projects/website/app/(public)/page.tsx
import { getLatestNews } from '@/lib/news-api'

export default async function Home() {
  const latestNews = await getLatestNews()
  return (
    <main>
      {/* ... 其他內容 ... */}
      <section className="news-section">
        <h2>最新新聞</h2>
        {latestNews.map(news => (
          <NewsCard key={news.id} news={news} />
        ))}
      </section>
    </main>
  )
}
```

---

## 8. 關鍵配置檔案參考

### 8.1 Turbo.json (可選更新)

如果想讓 Turbo 認識 news 專案:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["knowledge-base/**"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "deploy": {
      "dependsOn": ["build"]
    },
    "generate": {
      "cache": false,
      "outputs": ["*.html", "*.json"]
    }
  }
}
```

### 8.2 Vercel.json (可選)

如果要在 Vercel 上支援 LINE webhook:

```json
{
  "buildCommand": "pnpm install && cd projects/website && pnpm build",
  "installCommand": "pnpm install",
  "outputDirectory": "projects/website/.next",
  "rewrites": [
    {
      "source": "/api/line-webhook",
      "destination": "projects/news/api/line-webhook.py"
    }
  ]
}
```

---

## 9. 常見問題與解決方案

### Q1: Python 依賴如何管理?

**A**: 保持 `projects/news/requirements.txt` 獨立。GitHub Actions 會在執行時安裝這些依賴。不需要通過 pnpm 管理。

### Q2: 如何本地測試新聞生成?

**A**:
```bash
cd projects/news
pip install -r requirements.txt
export GOOGLE_API_KEY="your_key"
export OPENAI_API_KEY="your_key"
python scripts/main.py
```

### Q3: 生成的 HTML 文件應該提交到 Git 嗎?

**A**: 建議不提交生成的 HTML。在 `.gitignore` 中排除:
```
*.html        # 除了模板
!templates/   # 模板檔案保留
!docs/        # 文檔保留
```

### Q4: 如何與 projects/website 共享認證?

**A**: Thinker-News 不需要認證（它是自動化系統）。但如果需要 API 認證:
```bash
# 在 projects/news/api/line-webhook.py 中
import os
api_key = os.getenv("LINE_CHANNEL_ACCESS_TOKEN")
```

### Q5: 成本會增加嗎?

**A**: 不會。仍使用相同的 API keys 和配額。GitHub Actions 免費額度充足。

---

## 10. 最佳實踐建議

### 10.1 開發流程

1. **本地開發**: 在 projects/news 目錄進行修改
2. **本地測試**: 使用 `python scripts/test_local.py`
3. **提交**: `git commit` 並在 PR 中描述變更
4. **部署**: GitHub Actions 自動執行

### 10.2 監控與維護

```bash
# 查看最近的執行日誌
git log --oneline projects/news/ | head -20

# 檢查 GitHub Actions 日誌
# https://github.com/ThinkerCafe-tw/thinker-cafe/actions

# 本地查看生成的文件
ls -la projects/news/latest.json
cat projects/news/latest.json | python -m json.tool
```

### 10.3 數據備份

```bash
# 備份生成的新聞歷史
tar -czf news-backup-$(date +%Y%m%d).tar.gz \
  projects/news/*.html \
  projects/news/latest.json
```

### 10.4 版本管理

在 CLAUDE.md 中記錄主要版本:
```
v1.0 (2025-11-08): 初始整合進 thinker-cafe monorepo
v1.1 (2025-11-XX): 添加新聞篩選算法優化
v2.0 (2025-12-XX): 集成到 projects/website
```

---

## 11. 檢查清單

- [ ] 備份原始 thinker-news
- [ ] 創建 projects/news 目錄結構
- [ ] 複製所有核心腳本和檔案
- [ ] 創建 CLAUDE.md (使用提供的模板)
- [ ] 創建 package.json
- [ ] 創建 .gitignore
- [ ] 驗證目錄結構完整性
- [ ] 本地測試 Python 腳本
- [ ] 檢查所有路徑引用
- [ ] Git 提交
- [ ] GitHub 配置 Secrets
- [ ] 測試 GitHub Actions workflow
- [ ] (可選) 與 projects/website 集成
- [ ] 更新知識庫文檔

---

## 12. 後續建議

### 短期 (1-2 周)
1. 完成整合並驗證 GitHub Actions 穩定運行
2. 與 projects/website 簡單集成 (至少在首頁鏈接)
3. 更新根級 README 說明新聞系統

### 中期 (1 個月)
1. 優化台灣本地化篩選邏輯 (基於實際反饋)
2. 添加可視化儀表板 (執行統計、成本分析)
3. 建立備份和歷史檔案管理

### 長期 (3-6 個月)
1. 可能遷移到 projects/website 內作為集成功能
2. 根據用戶反饋優化 AI 人格和提示詞
3. 考慮添加更多新聞來源或定製化選項

---

## 總結

**Thinker-News 應該放在 `projects/news/` 下**，理由:
1. ✅ ThinkerCafe 品牌專屬
2. ✅ thinker.cafe 生態系的一部分
3. ✅ 內部自動化工具
4. ✅ 與主應用相關聯

**整合方式**:
1. 保持 Python 和 GitHub Actions 獨立運行
2. 通過 package.json 和 CLAUDE.md 在 monorepo 中有正式身份
3. 生成的輸出可通過 API 被 projects/website 使用
4. 遵循 monorepo 的命名和結構規範

**整合後的優勢**:
- 統一的 Git 管理
- AI 記憶系統統一
- 可與其他專案共享工具和知識庫
- 清晰的專案邊界和文檔

---

**報告完成日期**: 2025-11-08  
**分析者**: Claude Code (協助 Cruz Tang)  
**推薦行動**: 開始執行「第 7 節 - 整合步驟」

