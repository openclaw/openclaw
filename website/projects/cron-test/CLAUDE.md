---
inherits_from: ../../knowledge-base/CLAUDE_ROOT.md
project: cron-test
version: 1.0
---

# Cron Test Project

## 🎯 專案目標

這是一個用於測試 Vercel Cron Job 功能的簡單專案，目的是驗證：
- Vercel 的 cron job 基本功能
- MCP Vercel 工具的部署與管理能力
- 自動化排程的執行狀態監控

## 🏗️ 專案架構

```
projects/cron-test/
├── api/
│   └── cron/
│       └── test.js          # Cron Job API 端點
├── public/                  # 靜態資源 (目前為空)
├── index.html              # 主頁面（測試介面）
├── package.json            # 套件配置
├── vercel.json             # Vercel 部署配置
└── CLAUDE.md              # 本檔案
```

## 🤖 Cron Job 配置

### 排程設定
- **執行頻率**：每 5 分鐘一次 (`*/5 * * * *`)
- **API 端點**：`/api/cron/test`
- **最大執行時間**：30 秒
- **區域**：香港 (hkg1) - 最接近台灣

### 功能特色
- 自動記錄執行時間戳記
- 區分 Cron Job 呼叫與手動 API 呼叫
- 輸出台灣時間格式
- 包含環境資訊和請求標頭
- 支援 CORS 跨域請求

## 🧪 測試方式

### 自動測試（Cron Job）
- 部署後會自動每 5 分鐘執行
- 檢查 Vercel Function Logs 確認執行狀態
- 監控執行頻率和成功率

### 手動測試
1. 訪問專案主頁：`https://[deployment-url].vercel.app`
2. 點擊「測試 Cron Job API」按鈕
3. 查看回傳的 JSON 結果
4. 確認時間戳記和執行資訊正確

### 使用 MCP 測試
- 使用 `mcp__vercel__get_deployment_build_logs` 查看構建日誌
- 使用 `mcp__vercel__list_deployments` 監控部署狀態
- 使用 `mcp__vercel__get_deployment` 檢查部署詳情

## 🔧 技術規格

### 技術棧
- **Runtime**：Node.js (Vercel Functions)
- **部署平台**：Vercel
- **API 類型**：Serverless Functions
- **前端**：純 HTML/CSS/JavaScript

### 環境變數
- 目前無需特殊環境變數
- 會自動讀取 `VERCEL_ENV` 環境識別

### 相依套件
- 目前無外部相依套件，使用 Node.js 內建功能

## 📊 監控指標

### 成功指標
- ✅ 每 5 分鐘正常執行
- ✅ API 回應時間 < 1 秒
- ✅ 正確輸出時間戳記和環境資訊
- ✅ 手動測試功能正常

### 失敗指標
- ❌ Cron Job 執行失敗或中斷
- ❌ API 回應時間 > 5 秒
- ❌ 回傳錯誤狀態碼
- ❌ 日誌中出現錯誤訊息

## 🚀 部署指令

```bash
# 進入專案目錄
cd projects/cron-test

# 使用 MCP Vercel 部署
# 透過 Claude Code 執行：mcp__vercel__deploy_to_vercel

# 或使用 CLI 部署
vercel --prod
```

## 🛠️ 維護說明

### 定期檢查項目
1. **每日**：檢查 Cron Job 執行日誌
2. **每週**：驗證執行頻率是否正確
3. **每月**：檢查 Vercel 用量是否在預期範圍

### 故障排除
- 若 Cron Job 停止執行，檢查 Vercel Function Logs
- 若 API 回應異常，檢查程式碼邏輯
- 若部署失敗，檢查 vercel.json 配置

### 擴展方向
- 添加資料庫記錄執行歷史
- 集成 Slack/LINE 通知
- 添加更複雜的排程邏輯
- 監控其他 ThinkerCafe 專案狀態

## 📈 學習重點

此專案作為 ThinkerCafe monorepo 中的實驗專案，主要學習：

1. **Vercel Cron Jobs**
   - 基本配置方法
   - 排程語法運用
   - 函式執行限制

2. **MCP Vercel 整合**
   - 自動化部署流程
   - 日誌監控方法
   - API 狀態檢查

3. **Serverless 最佳實踐**
   - 函式冷啟動處理
   - 錯誤處理機制
   - 效能優化技巧

---

**建立時間**：2025-11-09
**負責人**：Cruz Tang
**狀態**：開發中
**下一步**：部署測試與功能驗證