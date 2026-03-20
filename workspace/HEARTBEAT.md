# HEARTBEAT.md - 覺知循環

## Live State（任何 session 讀寫）

```yaml
last_updated: null
updated_by: null

threads:
  coverage: "647/710"
  coverage_pct: 91
  unreplied_to_us: 0
  last_scan: null

fb:
  groups_joined: []
  last_scan: null
  pending_drafts: 0

social_engine:
  contacts: 72
  subscribers: 32
  cross_platform_identities: 3 # jiang_yude, rhaenyra, vivi_bg666

dr:
  completed: 52
  pending: 8
  failed: 1

infra:
  gateway: null
  tunnel: null
  sentinel: null
```

**規則：每個 session 開工讀這段，收工更新。不認識其他 session，只認識這個狀態。**

---

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

### 7. Workspace 一致性（防漂移）

**背景**：2026-02-28 已統一 workspace 路徑，`openclaw.json` 的 `workspace` 指向 `~/clawd/workspace/`。
舊的 `~/.openclaw/workspace/` 已搬到 `~/.openclaw/workspace.old.20260228`。

檢查項目：

- [ ] `openclaw.json` 的 workspace 仍指向 `~/clawd/workspace/`：
  ```bash
  grep '"workspace"' ~/.openclaw/openclaw.json | grep -q 'clawd/workspace' || echo "DRIFT: workspace path changed!"
  ```
- [ ] `~/.openclaw/workspace/` 目錄沒有重新出現（OpenClaw 升級可能重建）：
  ```bash
  [ -d ~/.openclaw/workspace ] && echo "WARNING: ~/.openclaw/workspace recreated!"
  ```
- [ ] `~/.openclaw/*.md` 根層殭屍沒有重新出現：
  ```bash
  ls ~/.openclaw/*.md 2>/dev/null && echo "WARNING: stale root md files found"
  ```
- 發現任何漂移 → 報告 Cruz，不要自己改 openclaw.json

### 8. 跨 Agent 日報（每日一次）

- [ ] 執行 `python3 workspace/scripts/cross-digest.py`
- [ ] 確認 `workspace/memory/cross-digest-YYYY-MM-DD.md` 已生成
- [ ] 有重大發現 → 用 `python3 workspace/scripts/bulletin alert "..."` 記錄

### 9. 經驗自動入庫（每日一次）

- [ ] 執行 `python3 workspace/scripts/exp-autosave.py`
- [ ] 檢查輸出：有新經驗入庫嗎？有重複跳過嗎？

## 規則

- 全部 OK → 回 HEARTBEAT_OK
- 任何異常 → 報告問題，不要靜默
- **不要在 heartbeat 裡做大量分析**，只做快速檢查
