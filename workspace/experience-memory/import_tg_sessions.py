#!/usr/bin/env python3
"""
import_tg_sessions.py — 從 TG Session 數據中提煉並導入結構化經驗
================================================================

數據來源：
  - ~/Documents/two/logs/polling.log  →  HTTP 409 踩坑
  - ~/Documents/two/mcp-telegram/wuji_tracker_state.json  →  監控系統問題
  - ~/Documents/two/mcp-telegram/learned_patterns.json  →  行為模式
  - ~/Documents/two/mcp-telegram/auto_reply_state.json  →  自動回覆系統
  - ~/Documents/two/logs/telegram-666数据需求群.md  →  基礎設施踩坑
  - MEMORY.md 中的已知架構知識
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from db import ExperienceDB


def build_experiences() -> list[dict]:
    """提煉所有 TG Session 中的經驗教訓。"""
    experiences = []

    # =========================================================================
    # 1. Telegram Bot Polling 409 衝突
    # =========================================================================
    experiences.append({
        "phenomenon": "Telegram Bot Polling 持續報 HTTP 409 Conflict 錯誤，無法接收訊息",
        "cause": "多個 Bot 實例同時調用 getUpdates API。Telegram 一個 Bot Token 只允許一個 polling 連線，多個實例會互相衝突導致 409。",
        "solution": "確保同一個 Bot Token 只有一個 polling 實例在運行。如果容器和本機都有 Bot，其中一個必須停掉或改用 webhook 模式。使用 `ps aux | grep polling` 檢查重複實例。",
        "methodology": "單點原則：一個 Token 一個消費者。如果需要多端，使用 webhook 模式（由 Telegram 主動推送），而非 polling 模式（主動拉取）。",
        "tags": ["telegram", "bot", "polling", "409", "conflict", "getUpdates"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 2. Telegram Token 衝突：容器 vs 本機
    # =========================================================================
    experiences.append({
        "phenomenon": "本機 Gateway 和 Docker 容器同時配置了 Telegram Bot Token，導致 getUpdates 衝突",
        "cause": "容器 (moltbot-core.router.wuji.01-stg) 負責處理 Telegram，但本機 Gateway 也配了同一個 Token，兩邊同時 polling 造成 409。",
        "solution": "在本機 Gateway 中刪除 Telegram Token（.env 或 config 中移除）。確保只有容器處理 Telegram 訊息。",
        "methodology": "職責分離：每個 channel 只由一個服務實例處理。本機 Gateway 處理 Browser Control 和 Discord，容器處理 Telegram 和 LINE。",
        "tags": ["telegram", "docker", "gateway", "architecture", "token"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 3. LINE Push Message 429 限流
    # =========================================================================
    experiences.append({
        "phenomenon": "LINE 回覆訊息時遇到 429 Too Many Requests，Push Message API 額度用完",
        "cause": "使用 `message` 工具回覆 LINE 訊息時，走的是 Push Message API（有免費額度限制，超額 429）。正確方式是用 Reply Token 回覆（免費無限）。",
        "solution": "永遠不要用 `message` 工具回覆 LINE！直接輸出文字讓系統自動使用 Reply Token。Reply Token 免費無限但只有 30 秒時效。",
        "methodology": "LINE 雙軌原則：Reply Token = 免費無限但有時效(30s)，Push Message = 有額度限制。非必要不用 Push。",
        "tags": ["LINE", "429", "rate-limit", "push-message", "reply-token"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 4. Wuji Tracker 無回應連續計數過高
    # =========================================================================
    experiences.append({
        "phenomenon": "Wuji Tracker 顯示 56 次無回應連續計數(no_response_streak)，112 次提醒已發送但全無回應",
        "cause": "追蹤器設計中沒有最大重試上限和指數退避機制。監控 14 個群組但 recorded_groups 和 pending_groups 都為空，表示追蹤邏輯可能有 bug 或群組已離開。",
        "solution": "1. 加入最大重試次數(max_retries)和指數退避; 2. 檢查群組是否仍然存在; 3. 加入狀態清理機制避免 streak 無限增長。",
        "methodology": "監控系統必備三要素：max_retries（避免無限重試）、exponential_backoff（避免刷屏）、dead_letter_queue（處理已死目標）。",
        "tags": ["monitoring", "tracker", "retry", "backoff", "design-pattern"],
        "severity": "warning",
        "source": "tg-import",
    })

    # =========================================================================
    # 5. MySQL 跨主機連線 — IP 白名單
    # =========================================================================
    experiences.append({
        "phenomenon": "Matomo-web (10.188.15.186) 無法連接 matomo-db (10.188.4.51:3306)，MySQL 連線失敗",
        "cause": "內網有強權限分配機制，MySQL 的 root 帳號沒有將 web 服務器 IP 加入白名單。服務器之間也禁 ping。",
        "solution": "1. 在 matomo-db 上檢查 MySQL root 用戶的 host 權限，確認加白 10.188.15.186; 2. 請運維開啟 ping（或用 telnet 測試 3306 端口）; 3. 一次性提出所有網路需求。",
        "methodology": "基礎設施連通性驗證順序：ping → telnet port → MySQL client 連線。需求一次性提出，避免多次來回。",
        "tags": ["mysql", "networking", "whitelist", "infrastructure", "matomo"],
        "severity": "warning",
        "source": "tg-import",
    })

    # =========================================================================
    # 6. Docker 容器路徑映射
    # =========================================================================
    experiences.append({
        "phenomenon": "在容器內使用宿主機路徑（如 /Users/sulaxd/clawd/...）存取檔案失敗",
        "cause": "Docker 容器內的檔案系統與宿主機不同，需要使用容器內的掛載路徑。例如 Telegram 圖片在容器內是 /app/media/telegram/，不是宿主機的 ~/clawd/workspace/skills/telegram-userbot/downloads/",
        "solution": "使用正確的容器內路徑映射：\n- ~/clawd/workspace/ → /app/workspace/\n- ~/.openclaw/persistent/data/ → /app/persistent/data/\n- ~/clawd/ → /home/node/clawd/\n- ~/Documents/ → /home/node/Documents/\nTelegram 圖片: /app/media/telegram/",
        "methodology": "在容器環境中，永遠先確認路徑映射關係再操作檔案。使用環境變數或配置檔統一管理路徑前綴。",
        "tags": ["docker", "path-mapping", "container", "volume-mount"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 7. 自動回覆系統設計
    # =========================================================================
    experiences.append({
        "phenomenon": "自動回覆系統需要分級處理不同優先度的訊息，但沒有統一的審批流程",
        "cause": "auto_reply_state.json 中有 pending_approval 機制，但訊息被分為 medium/high/low 優先度後，自動回覆的品質和時機不一致。",
        "solution": "設計三級回覆策略：low=靜默忽略或延遲回覆; medium=生成草稿等待審批; high=立即自動回覆。保留 pending_approval 佇列用於 medium 級別。",
        "methodology": "自動化系統的審批分級：低風險自動執行、中風險人工審批、高風險雙重確認。避免一刀切。",
        "tags": ["auto-reply", "priority", "approval", "design-pattern"],
        "severity": "info",
        "source": "tg-import",
    })

    # =========================================================================
    # 8. 多 Agent 路由架構
    # =========================================================================
    experiences.append({
        "phenomenon": "系統需要在多個 Agent (bita, xo) 之間正確路由訊息到對應群組",
        "cause": "Level 0 (wuji) 是戰略層，Level 1 有 bita (幣塔，9群組，DeepSeek) 和 xo (1群組，DeepSeek)。不同 agent 有不同的上下文和人格。",
        "solution": "使用 smart-router hook 根據 chat_id 映射到正確的 agent。CHATS/IDENTITIES 定義在 time-tunnel/handler.js 中。每個 agent 獨立的 context window。",
        "methodology": "Multi-Agent 路由：用 chat_id → agent_id 映射表，而非動態判斷。靜態路由表比動態路由更可靠、可除錯。",
        "tags": ["multi-agent", "routing", "architecture", "bita", "xo", "wuji"],
        "severity": "info",
        "source": "tg-import",
    })

    # =========================================================================
    # 9. 使用者行為模式學習
    # =========================================================================
    experiences.append({
        "phenomenon": "需要追蹤團隊成員的上班/午餐/打卡時間模式以改善互動時機",
        "cause": "learned_patterns.json 記錄了 6 位用戶的作息模式：上班 12:00、午餐出 14-17、午餐回 14-19、日報時間 22:00。",
        "solution": "使用 clock_time_distribution + personal_habits 數據做時間視窗偵測。關鍵詞匹配：'上班'=clock_in, '吃飯/吃饭'=lunch_out, '回来/回來'=lunch_back。",
        "methodology": "行為學習三步驟：1) 關鍵詞觸發識別 2) 時間分佈統計 3) 個人化模型建立。用戶不需主動設定，系統自動學習。",
        "tags": ["behavior-learning", "patterns", "clock-tracking", "personalization"],
        "severity": "info",
        "source": "tg-import",
    })

    # =========================================================================
    # 10. 部署安全規範
    # =========================================================================
    experiences.append({
        "phenomenon": "部署時如果不做預檢就直接 deploy，容易導致服務中斷或配置遺漏",
        "cause": "過去曾因環境變數缺失、端口衝突、Docker image 未更新等問題導致部署失敗。",
        "solution": "永遠先跑 deploy-check.sh（檢查環境變數、端口、依賴），再跑 zero-downtime-deploy.sh（藍綠部署）。",
        "methodology": "部署鐵律：先 check 再 deploy，永遠用零停機方案。部署 = 預檢 + 灰度 + 回滾計畫。",
        "tags": ["deploy", "zero-downtime", "blue-green", "safety"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 11. Time Tunnel 對話記錄架構
    # =========================================================================
    experiences.append({
        "phenomenon": "需要跨 session 的完整對話歷史查詢和意識層級追蹤",
        "cause": "標準 LLM 的 context window 有限，無法保留所有歷史。需要外部持久化。",
        "solution": "使用 SQLite (timeline.db) 作為 Time Tunnel：messages 表存對話、identities 表存用戶、chats 表存群組。Level 100-103 共 11 個意識表追蹤狀態。Level 104 用 sqlite-vec 做向量搜索。",
        "methodology": "三層記憶架構：短期(context window) + 中期(session memory) + 長期(SQLite/LanceDB)。每層有不同的存取速度和容量。",
        "tags": ["time-tunnel", "sqlite", "memory-architecture", "consciousness"],
        "severity": "info",
        "source": "tg-import",
    })

    # =========================================================================
    # 12. SSL 和網路超時處理
    # =========================================================================
    experiences.append({
        "phenomenon": "Telegram Polling 時偶發 SSL handshake error 和 read operation timed out",
        "cause": "網路環境不穩定（跨境連線、VPN、ISP 問題），長 polling 連線容易超時。",
        "solution": "1. 設定合理的 timeout (30-60s); 2. 捕獲 timeout/SSL 異常後自動重連; 3. 使用指數退避避免暴風雨式重試; 4. 記錄錯誤頻率用於監控。",
        "methodology": "網路韌性三件套：retry with backoff + connection pool + circuit breaker。不要讓暫態錯誤變成永久故障。",
        "tags": ["ssl", "timeout", "networking", "retry", "resilience"],
        "severity": "warning",
        "source": "tg-import",
    })

    # =========================================================================
    # 13. 財務報表自動化
    # =========================================================================
    experiences.append({
        "phenomenon": "每小時自動生成 BG666 財務報表（充值/提款/趨勢分析）並發送到 Telegram",
        "cause": "需要定時數據報告讓管理層了解業務狀況。手動報告效率低且容易遺漏。",
        "solution": "使用 cron + Python 腳本生成報表（CSV/PNG/HTML），通過 Telegram Bot API 發送。包含同比分析（vs 前小時/前日）和健康指標。",
        "methodology": "自動報表設計原則：1) 固定格式便於快速掃讀 2) 包含趨勢對比(環比/同比) 3) 異常自動高亮 4) 支持多格式輸出。",
        "tags": ["automation", "reporting", "cron", "financial", "telegram-bot"],
        "severity": "info",
        "source": "tg-import",
    })

    # =========================================================================
    # 14. 環境配置安全
    # =========================================================================
    experiences.append({
        "phenomenon": "對話記錄和配置文件中包含敏感資訊（API keys, SSH keys, MySQL 密碼）",
        "cause": "telegram-666 對話記錄中直接記錄了 SSH 密鑰路徑和 MySQL root 密碼。config.json 包含 Telegram API credentials。",
        "solution": "1. 敏感資訊只存在 .env 或 secrets manager 中; 2. 對話記錄/文檔中脫敏處理; 3. git commit 前檢查是否洩漏; 4. 使用 .gitignore 排除 .env, .session, credentials 文件。",
        "methodology": "安全鐵律：credentials 永遠不進 repo、不存文檔、不發聊天。統一用環境變數或 secrets manager。",
        "tags": ["security", "credentials", "secrets", "gitignore", "env"],
        "severity": "critical",
        "source": "tg-import",
    })

    # =========================================================================
    # 15. Internal Hooks 架構
    # =========================================================================
    experiences.append({
        "phenomenon": "OpenClaw 內部 Hook 系統用於對話攔截、路由、記錄和監控",
        "cause": "需要在不修改核心程式碼的情況下擴展功能。Hook 系統允許插件式的功能注入。",
        "solution": "四個核心 Hook：time-tunnel(記錄+狀態追蹤)、smart-router(任務/長度路由)、cost-tracker(成本日誌)、failover-monitor(通知+斷路器)。",
        "methodology": "Hook 設計原則：每個 hook 單一職責、可獨立停用、有 fallback。Hook 執行順序很重要：先路由、再記錄、最後監控。",
        "tags": ["hooks", "architecture", "plugin", "middleware", "design-pattern"],
        "severity": "info",
        "source": "tg-import",
    })

    return experiences


def main():
    db = ExperienceDB()

    print("🔄 Extracting experiences from TG sessions...")
    experiences = build_experiences()

    print(f"📦 Importing {len(experiences)} experiences...")
    imported = 0
    for exp in experiences:
        try:
            result = db.save(**exp)
            imported += 1
            severity_emoji = {"info": "ℹ️", "warning": "⚠️", "critical": "🔴"}.get(exp["severity"], "")
            print(f"  {severity_emoji} {result['id']}: {exp['phenomenon'][:60]}...")
        except Exception as e:
            print(f"  ❌ Failed: {exp['phenomenon'][:40]}... - {e}")

    print(f"\n✅ Imported {imported}/{len(experiences)} experiences")
    print(f"📊 Total in DB: {db.count()}")


if __name__ == "__main__":
    main()
