# LINE Bot Webhook 故障排除

## 問題：發送 /news 沒有回應

### 檢查清單

#### 1. LINE Developers Console 設定

前往 [LINE Developers Console](https://developers.line.biz/console/) > 你的 Bot Channel > **Messaging API**

- [ ] **Webhook URL** 設定為：`https://thinker-news.vercel.app/api/line-webhook`
- [ ] **Webhook URL** 驗證狀態顯示 ✅ 成功
- [ ] **Use webhook** 開關已**開啟**（重要！）
- [ ] **Auto-reply messages** 已**關閉**（避免衝突）
- [ ] **Greeting messages** 已**關閉**（可選）

#### 2. LINE App 設定

- [ ] 已將 Bot 加為好友（掃描 QR code 或搜尋 Bot ID）
- [ ] Bot **未被封鎖**
- [ ] 在聊天室中發送訊息（不是在群組，是一對一聊天）

#### 3. 測試步驟

1. 在 LINE 中找到你的 Bot
2. 確認聊天視窗頂端顯示 Bot 名稱
3. 發送以下任一關鍵字：
   - `/news`
   - `新聞`
   - `news`
   - `今日新聞`
   - `每日新聞`

#### 4. 查看 Vercel 日誌

```bash
vercel logs https://thinker-news.vercel.app
```

如果有收到請求，會看到類似這樣的日誌：
```
Received signature: p/X5ybxewN473DCN/uyN...
Body length: 256
✅ Signature verification passed
```

如果**沒有任何日誌**，表示 LINE 沒有發送 webhook 請求給 Vercel。

---

## 解決方案

### 方案 1：確認 Webhook 已開啟

最常見的問題是 **Use webhook** 開關未開啟。

1. 前往 LINE Developers Console
2. Messaging API > **Use webhook**
3. 確認開關是**綠色**的（ON）
4. 重新測試

### 方案 2：檢查 Bot 狀態

1. 在 LINE App 中找到 Bot
2. 點擊 Bot 名稱 > 查看詳細資料
3. 確認沒有「封鎖」按鈕是灰色的
4. 如果被封鎖，點擊「解除封鎖」

### 方案 3：重新驗證 Webhook

1. LINE Developers Console > Messaging API
2. 點擊 Webhook URL 旁的 **Verify** 按鈕
3. 應該顯示 ✅ Success
4. 如果失敗，檢查 Vercel 部署狀態

### 方案 4：檢查 Access Token

確認 Channel Access Token 是否正確：

```bash
curl -X GET \
  'https://api.line.me/v2/bot/info' \
  -H 'Authorization: Bearer YOUR_CHANNEL_ACCESS_TOKEN'
```

如果返回 Bot 資訊，表示 token 正確。

---

## 測試 Webhook（不透過 LINE）

使用本地腳本直接測試 Vercel webhook：

```bash
python3 test_line_post.py
```

預期結果：
```
✅ Response Status: 200
Response: {"status": "ok"}
```

---

## 常見錯誤碼

| 錯誤碼 | 原因 | 解決方案 |
|-------|------|---------|
| 403 Forbidden | 簽名驗證失敗 | 檢查 `LINE_CHANNEL_SECRET` 是否正確（32字元） |
| 404 Not Found | URL 錯誤 | 確認 webhook URL 是 `/api/line-webhook` |
| 401 Unauthorized | Access Token 錯誤 | 重新生成 Channel Access Token |
| 沒有日誌 | Webhook 未開啟 | 確認 **Use webhook** 開關已開啟 |

---

## 手動觸發測試

如果想手動測試，可以使用 curl：

```bash
# 1. 生成測試事件
cat > test_event.json << 'EOF'
{
  "destination": "U123456789",
  "events": [
    {
      "type": "message",
      "replyToken": "test_reply_token_12345",
      "source": {
        "userId": "U123456789",
        "type": "user"
      },
      "timestamp": 1462629479859,
      "message": {
        "type": "text",
        "id": "325708",
        "text": "/news"
      }
    }
  ]
}
EOF

# 2. 計算簽名並發送（使用 Python 腳本）
python3 test_line_post.py
```

---

## 進階診斷

### 檢查 latest.json 是否存在

```bash
curl https://raw.githubusercontent.com/ThinkerCafe-tw/thinker-news/main/latest.json
```

如果返回 404，表示新聞檔案未生成或上傳失敗。

### 查看 GitHub Actions 狀態

前往：https://github.com/ThinkerCafe-tw/thinker-news/actions

確認 **Daily News Generation** workflow 是否成功執行。

---

## 聯繫資訊

如果問題仍未解決，請檢查：

1. Vercel 部署狀態：https://vercel.com/cruz-5538s-projects/thinker-news
2. LINE Bot Status：LINE Developers Console > Bot 詳細資料
3. GitHub Repository：https://github.com/ThinkerCafe-tw/thinker-news

---

最後更新：2025-11-08
