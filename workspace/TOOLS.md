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

## Local Services

### Telethon HTTP Bridge (杜甫帳號)

- **Port**: `localhost:18790`
- **進程**: `/opt/anaconda3/bin/python scripts/http_bridge.py --port 18790`（從 `~/clawd/workspace/skills/telegram-userbot/` 啟動）
- **Session 檔**: `~/Documents/two/mcp-telegram/session/claude_session.session`
- **⚠️ Session 檔被鎖時不要直接用 Telethon，走 HTTP API**
- **API**:
  - `GET /chats` — 列出所有對話
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

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
