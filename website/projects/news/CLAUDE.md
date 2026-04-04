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
**維護者**: Claude Code (協助 Cruz Tang)
**相關專案**: projects/website, knowledge-base
