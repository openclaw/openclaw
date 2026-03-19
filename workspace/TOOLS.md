# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## wuji tg CLI — Telegram 讀寫主工具（鐵規則）

**所有 Telegram 讀取操作用 `wuji tg`，不要用 raw HTTP bridge。**

```bash
# 讀取
exec python3 ~/clawd/workspace/scripts/wuji tg list                  # 列出所有已同步群組
exec python3 ~/clawd/workspace/scripts/wuji tg search "關鍵字"         # 跨群搜索
exec python3 ~/clawd/workspace/scripts/wuji tg <群名> [N]              # 看某群最後 N 則（模糊匹配群名）
exec python3 ~/clawd/workspace/scripts/wuji tg <群名> --my             # 只看我的訊息
exec python3 ~/clawd/workspace/scripts/wuji tg <群名> --search "關鍵字"  # 群內搜索

# 發送
exec python3 ~/clawd/workspace/scripts/wuji tg send <contact> "msg"   # 發訊息
exec python3 ~/clawd/workspace/scripts/wuji tg contacts               # 列出聯絡人 + bridges

# River（知識消化）
exec python3 ~/clawd/workspace/scripts/wuji tg digest <river>         # 消化某條 river 的新訊息
exec python3 ~/clawd/workspace/scripts/wuji tg rivers                 # 看所有 rivers
exec python3 ~/clawd/workspace/scripts/wuji tg think "問題"            # 跨 river 推理
```

**群名模糊匹配** — 打「666運營」就能匹配到「666運營咨詢」，不需要完整群名或 chat ID。

**絕對不要問用戶要 chatId** — `wuji tg list` 和 `wuji tg search` 自己找。

**t.me 連結解析** — `t.me/c/3506161262/2284` → chat_id `-1003506161262`，msg_id `2284`。直接 `wuji tg` 用群名讀取即可。

## Local Services

### Telethon HTTP Bridge (杜甫帳號)

- **Port**: `localhost:18790`
- **進程**: `/opt/anaconda3/bin/python scripts/http_bridge.py --port 18790`（從 `~/clawd/workspace/skills/telegram-userbot/` 啟動）
- **Session 檔**: `~/Documents/two/mcp-telegram/session/claude_session.session`
- **⚠️ Session 檔被鎖時不要直接用 Telethon，走 HTTP API**
- **API**:
  - `GET /chats` — 列出所有對話（用來搜索不認識的群名）
  - `GET /messages?chat=<id>&limit=30` — 讀取訊息
- **佔用檢查**: `fuser ~/Documents/two/mcp-telegram/session/claude_session.session`

### Telethon HTTP Bridge (Andrew 帳號 — LoLoTang 群用)

- **Port**: `localhost:18795`
- **Session 檔**: `~/Documents/24Bet/.telegram_session.session`（唯讀，不要修改）
- **用途**: 讀取 LoLoTang 群訊息（chat_id: -4745247300）
- **啟動**: `cd ~/clawd/workspace/skills/telegram-userbot && venv/bin/python scripts/http_bridge.py --port 18795 --session ~/Documents/24Bet/.telegram_session.session`
- **API**: 同杜甫 bridge（/health, /chats, /messages）

### 24 群

- **Chat ID**: `-1003573583957`（Supergroup，已升級）
- **用途**: 杜甫工作群，每日 check-in、專案進度報告

### BG666 Database (MySQL RDS via ZeroTier)

- **Host**: `bg666-market-readonly.czsks2mguhd5.ap-south-1.rds.amazonaws.com`
- **Port**: `3306`
- **User**: `market`
- **Password**: `hBVoVVm&)aZtW0t6`
- **Database**: `ry-cloud`
- **連線前提**: ZeroTier Network `48d6023c4641dcad` 必須已連接
- **權限**: 唯讀（readonly）
- **來源**: `~/Documents/two/mcp-telegram/.env` + `~/Documents/two/INFRA.md`
- **⚠️ BG666 ≠ 24Bet**：完全不同公司，資源不共用

### Matomo Database (需 SSH 跳板)

- **Matomo Server (跳板機)**: `ubuntu@3.108.143.44`（公網）或 `13.205.188.209`（key: `~/.ssh/matomo.pem`）
- **Matomo DB (內網)**: `10.188.4.51:3306`
- **User**: `matomo`
- **Password**: `Matomo@BG666!2026`
- **Database**: `matomo`
- **⚠️ 必須先 SSH 進 Matomo Server，再從內網連 DB，不能直連**
- **SSH 隧道建法**:
  ```bash
  ssh -i ~/.ssh/matomo.pem -L 3307:10.188.4.51:3306 ubuntu@3.108.143.44 -N
  ```
  隧道建好後本地用 `localhost:3307` 連接
- **pymysql 連線範例**:
  ```python
  DB_CONFIG = {
      'host': '127.0.0.1', 'port': 3307,
      'user': 'matomo', 'password': 'Matomo@BG666!2026',
      'database': 'matomo', 'connect_timeout': 10
  }
  ```
- **數據規模**: 日均 ~7.5 萬筆訪客記錄
- **用途**: 首頁熱力圖、充值漏斗歸因分析、Rebate/VIP 頁面行為分析

### SSH

- **BG666 遠端伺服器**: `ubuntu@13.205.188.209`（key: `~/.ssh/matomo.pem`）
- **Matomo 跳板機**: `ubuntu@3.108.143.44`（同一台，公網 IP 不同）

### TTS

- Preferred voice: OpenAI "echo"
- Edge TTS: zh-TW-YunJheNeural

## Threads Reply System（Threads 留言回覆管理）

**路徑**: `~/clawd/workspace/tools/threads-reply/`
**CLI**: `python3 ~/clawd/workspace/tools/threads-reply/threads_reply.py <command>`

**⚠️ 鐵律：所有 Threads 操作都用 `exec` 跑 Python CLI，絕對不要開瀏覽器。** API token 已設定在 `.env`，不需要瀏覽器登入。

### 指令表

| 指令                                | 用途                                      |
| ----------------------------------- | ----------------------------------------- |
| `scan`                              | 拉最新貼文 + 留言入 DB，自動標記已回/未回 |
| `pending [post_id]`                 | 列出未回覆的留言                          |
| `dive <username>`                   | 深挖用戶 profile（🥃 敬酒型專用）         |
| `draft <comment_id> <text>`         | 建立草稿                                  |
| `review`                            | 列出待審草稿                              |
| `approve <draft_id> [revised_text]` | 批准草稿（可附修改版）                    |
| `reject <draft_id>`                 | 退回草稿                                  |
| `send [--dry-run]`                  | 發送所有 pending replies                  |
| `quick <comment_id> <text>`         | 快速回覆（跳過草稿直接 pending）          |
| `status`                            | 看整體狀態                                |

### 回覆骨架（Cruz 教的鐵律）

**Phase 1: SCAN** → `scan` 拉最新數據
**Phase 2: CLASSIFY** → 看 `pending`，每則分類：

- 🎯 經營型（同路人/認同/提問/技術討論）→ profile 快掃
- 🥃 敬酒型（嗆/酸/沒讀懂就來留言）→ `dive` 深挖全部

**Phase 3: DRAFT** → 核心原則：

1. **字數反比定律** — 對方越短你越短。一句嗆配一句回，不解釋
2. **料要隱形** — profile 情報不是展示「我查過你」，而是讓那一句話精準到他心裡發毛
3. **冷笑語感** — 想像站在他右後方，耳邊一句話就走。不是正面對決
4. 🎯 經營型：正常篇幅，profile 快掃
5. 🥃 敬酒型：深挖全部，但產出反而最短，一兩句帶走

**Phase 4: REVIEW** → 草稿整批呈給 Cruz，Cruz 可以：

- ✅ 「發」→ `approve` + `send`
- ✏️ 給修改版 → `approve <id> "修改版文字"`
- ❌ 「不要」→ `reject`

**Phase 5: SEND** → `send` 發送，自動 30 秒 cooldown 間隔

### 資料庫

SQLite: `~/clawd/workspace/tools/threads-reply/threads.db`

- `posts` — 貼文
- `comments` — 留言（含 replied_to 追蹤）
- `profiles` — 用戶側寫
- `replies` — 已發送/待發送的回覆
- `drafts` — 草稿審核流

### Threads API

- Token 在 `.env`
- `config.json` 有 user_id、reply rules
- 用 conversation endpoint（不是 replies）才能拿到 replied_to parent-child 關係

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
