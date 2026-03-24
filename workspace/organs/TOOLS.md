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

### SSH

- **BG666 遠端伺服器**: `ubuntu@13.205.188.209`（key: `~/.ssh/matomo.pem`）

### TTS

- Preferred voice: OpenAI "echo"
- Edge TTS: zh-TW-YunJheNeural

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
