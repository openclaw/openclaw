# HEARTBEAT.md - 覺知循環

## 每次 Heartbeat 檢查（每小時）

### 1. 系統健康

- [ ] `openclaw gateway status` — Gateway 在跑嗎？
- [ ] 查最近 log 有沒有 ERROR（排除已知的 Gateway restart noise）
- [ ] bita 有沒有新的 Unknown model 或 task error？

### 2. 記憶完整性

- [ ] 今天的 `memory/YYYY-MM-DD.md` 存在嗎？最後更新時間？
- [ ] 如果這個 session 已經超過 20 輪對話，主動摘要寫入 daily note

### 3. 任務追蹤

- [ ] 讀 `TASKS.md`，有逾期的 P0/P1 嗎？
- [ ] 有 sub-agent 任務卡住超過 1 小時嗎？

### 4. Cruz 回應

- [ ] 過去 1 小時有沒有 Cruz 的訊息我漏回的？

### 5. Dashboard Widget 刷新

- [ ] 執行 `python3 agents/widgets/refresh_dashboard.py`
- [ ] 讀取輸出的 JSON，用 `message` tool 執行 edit（或 send 如果 widget 需要重建）
- [ ] 如果 edit 失敗（訊息被刪），執行 send 重建，然後更新 state.json：
      `python3 -c "from agents.widgets.widget_manager import WidgetManager; wm=WidgetManager(); wm.register('dashboard', chat_id='448345880', message_id='<NEW_ID>')"`

### 6. LoLo Care Widget 刷新

- [ ] 執行 `python3 agents/widgets/refresh_lolo.py`
- [ ] 讀取輸出的 JSON，用 `message` tool 執行 edit（或 send 如果 widget 需要重建）
- [ ] 如果 edit 失敗（訊息被刪），執行 send 重建，然後更新 state.json：
      `python3 -c "from agents.widgets.widget_manager import WidgetManager; wm=WidgetManager(); wm.register('lolo-care', chat_id='-4745247300', message_id='<NEW_ID>', widget_type='lolo-care')"`

## 規則

- 全部 OK → 回 HEARTBEAT_OK
- 任何異常 → 報告問題，不要靜默
- **不要在 heartbeat 裡做大量分析**，只做快速檢查
