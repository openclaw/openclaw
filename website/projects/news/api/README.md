# LINE Bot Webhook API

這個目錄包含 Vercel Serverless Functions，用於處理 LINE Bot webhook。

## 檔案說明

- `line-webhook.py` - LINE Bot webhook 處理器

## 部署到 Vercel

### 1. 安裝 Vercel CLI

```bash
npm install -g vercel
```

### 2. 登入 Vercel

```bash
vercel login
```

### 3. 配置環境變數

在 Vercel Dashboard 設定以下環境變數：

- `LINE_CHANNEL_ACCESS_TOKEN` - LINE Bot Channel Access Token
- `LINE_CHANNEL_SECRET` - LINE Bot Channel Secret

或使用 CLI 設定：

```bash
vercel env add LINE_CHANNEL_ACCESS_TOKEN
vercel env add LINE_CHANNEL_SECRET
```

### 4. 部署

```bash
vercel --prod
```

### 5. 設定 LINE Webhook URL

部署完成後，將 webhook URL 設定到 LINE Developers Console：

```
https://your-project.vercel.app/api/line-webhook
```

## 使用方式

用戶在 LINE 發送以下關鍵字，會收到每日新聞：

- `/news`
- `新聞`
- `news`
- `今日新聞`
- `每日新聞`

## 測試

健康檢查（GET 請求）：

```bash
curl https://your-project.vercel.app/api/line-webhook
```

## 從 n8n 遷移說明

原本的 n8n workflow 已遷移為此 Vercel Serverless Function。

原始 n8n workflow 保留在：`docs/n8n_workflows/LINE自動發消息.json`
