# Bita LINE AI 客服 — 系統架構與部署指南

> 決策日期：2026-03-02
> 參與者：Cruz, Wuji
> 狀態：架構定案，待部署

---

## 一句話描述

在 Fly.io 上部署一台獨立的 OpenClaw，專門接 LINE 客戶的換幣諮詢，Telegram 作為員工後台監控。

---

## 全景架構圖

```
╔═════════════════════════════════════════════════════════════════════╗
║  Layer 0: 人類操作者                                                ║
║  Cruz (TPE, 架構/開發)          Rhaenyra (EST, 產品/部署/營運)       ║
╚════════════╤═══════════════════════════╤════════════════════════════╝
             │                           │
╔════════════╪═══════════════════════════╪════════════════════════════╗
║  Layer 1: Claude Code (Terminal CLI)                                ║
║                                                                     ║
║  能做的事：                                                          ║
║  ├─ 寫/改 SOUL.md、知識庫、openclaw.json                             ║
║  ├─ fly deploy (部署到 Fly.io)                                      ║
║  ├─ fly ssh console (進前線改設定)                                    ║
║  ├─ fly logs (看前線日誌)                                            ║
║  ├─ wuji CLI (管理所有 agent)                                       ║
║  ├─ git commit/push (版本控制)                                      ║
║  └─ debug / 搜經驗記憶 / sentinel 管理                               ║
║                                                                     ║
║  repo: ~/clawd (GitHub: tangcruz/clawd)                             ║
╚════════════╤═══════════════════════════╤════════════════════════════╝
             │ 管理/開發                  │ fly deploy / fly ssh
             ▼                           ▼
╔════════════════════════════╗  ╔═════════════════════════════════════╗
║  Layer 2A: 母艦 (本機 Mac)  ║  ║  Layer 2B: 前線 (Fly.io Docker)     ║
║  OpenClaw :18789           ║  ║  OpenClaw :3000                     ║
║  名稱：clawd               ║  ║  名稱：bita-line                    ║
║                            ║  ║  URL: bita-line.fly.dev              ║
║  Agents:                   ║  ║                                     ║
║  ├─ bita (QA校準)          ║  ║  Agent:                             ║
║  ├─ 66-desk                ║  ║  └─ bita-cs (LINE客服)              ║
║  ├─ meihui                 ║  ║     ├─ 匯率計算 (自動)              ║
║  ├─ xo                    ║  ║     ├─ FAQ 回答 (自動)               ║
║  └─ ...                   ║  ║     ├─ 引導轉帳 (自動)               ║
║                            ║  ║     └─ 標記轉人 (需要時)            ║
║  基礎設施:                  ║  ║                                     ║
║  ├─ Sentinel daemon        ║  ║  知識庫 (Volume /data):             ║
║  ├─ Experience Memory      ║  ║  ├─ platforms.md (匯率)             ║
║  └─ wuji CLI               ║  ║  ├─ banks.md (銀行代碼)            ║
║                            ║  ║  ├─ faq.md                          ║
║  Channels:                 ║  ║  └─ shortcuts.md (話術)             ║
║  ├─ Telegram (9群，內部)   ║  ║                                     ║
║  ├─ Discord                ║  ║  Channels:                          ║
║  └─ Chrome DevTools        ║  ║  ├─ LINE (前台，面客戶)             ║
║                            ║  ║  └─ Telegram (後台，員工)           ║
╚════════════╤═══════════════╝  ╚═══╤═════════════╤═══════════════════╝
             │                      │             │
             │◄─ webhook API ───────┤             │
             │  (匯報/同步/推更新)    │             │
             ▼                      ▼             ▼
╔═════════════════════════════════════════════════════════════════════╗
║  Layer 3: 通訊渠道                                                  ║
║                                                                     ║
║  Telegram                            LINE                           ║
║  ├─ [母艦] Bita管理群 (QA校準)       ├─ Bita 官方帳號 (面客)        ║
║  ├─ [母艦] 員工回報群 ×8             └─ webhook → bita-line.fly.dev ║
║  ├─ [母艦] 66群 / 美慧群                                            ║
║  └─ [前線] 客服後台群 (看LINE對話)                                   ║
╚═════════════════════════════════════════════════════════════════════╝
             │                                    │
             ▼                                    ▼
╔═════════════════════════════════════════════════════════════════════╗
║  Layer 4: 終端使用者                                                ║
║                                                                     ║
║  LINE 客戶                           Telegram 員工                   ║
║  「我要贏 1000塊」                    看到對話 → 確認轉帳 → /完成     ║
║  「星城 2000 換多少」                                                ║
║  「轉好了」(附截圖)                                                  ║
╚═════════════════════════════════════════════════════════════════════╝
```

---

## 為什麼是兩套 OpenClaw

| 考量     | 說明                                                 |
| -------- | ---------------------------------------------------- |
| 記憶隔離 | LINE 客服不該知道 QA 校準、員工績效、其他 agent 的事 |
| 安全     | 面客的 bot 被試探時，不會洩漏內部資料                |
| 穩定     | Fly.io 掛了不影響母艦，母艦重開不影響客服            |
| 成本     | 前線用便宜模型（DeepSeek/Haiku），母艦用 Claude      |
| 部署獨立 | 改匯率、改話術只動 Fly.io，不影響本機                |

---

## 核心客服流程

```
1. 客戶 LINE 說「我要贏 1000塊」
2. AI 自動回覆：「好的老闆，1000 × 132 = 132,000 遊戲幣，沒問題喔！」
3. AI 問付款方式：「請問要用銀行轉帳還是超商代碼？」
4. 客戶選「銀行轉帳」
5. AI 提供帳號
   同時 → Telegram 後台通知「[新交易] LINE用戶XXX，我要贏 1000元，銀行轉帳」
6. 客戶轉帳後傳截圖
7. 員工在 Telegram 看到 → 確認到帳 → 贈禮 → /完成
8. AI 在 LINE 回覆：「已贈禮完成，祝老闆爆大分🎰」
```

---

## 資料存放策略

```
Docker image (build 時打包，不常變)
├── OpenClaw 核心程式碼
├── LINE 插件 (@openclaw/line)
└── 基礎設定

Fly Volume /data (持久化，可動態更新，不用重新 deploy)
├── openclaw.json           ← 主配置
├── workspace/bita-cs/
│   ├── SOUL.md             ← AI 人格與規則
│   ├── knowledge/
│   │   ├── platforms.md    ← 匯率表（會更新）
│   │   ├── banks.md        ← 銀行代碼
│   │   ├── faq.md          ← 常見問題
│   │   └── shortcuts.md    ← 標準話術
│   └── memory/             ← 運行時對話記錄
└── state/                  ← session、lock 等
```

**知識庫放 Volume 不打包進 Docker** — 改匯率只需 `fly ssh console` 進去改，不用重新 deploy。

---

## 命名對照

|                 | 母艦 (本機)             | 前線 (Fly.io)               |
| --------------- | ----------------------- | --------------------------- |
| OpenClaw app 名 | clawd                   | bita-line                   |
| Agent ID        | bita (QA 校準)          | bita-cs (customer service)  |
| SOUL 性格       | 校準分析師 — 打分、績效 | 氣質美女 — 算幣、轉帳、答疑 |
| Model           | DeepSeek                | DeepSeek 或 Haiku           |
| 記憶            | 累積校準歷史            | 只保當日對話，可定期清理    |

---

## 母艦 ↔ 前線 關係

母艦可透過 webhook API 控制前線：

```bash
# 推送匯率更新
curl -X POST https://bita-line.fly.dev/hooks/agent \
  -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
  -d '{"agentId":"bita-cs","message":"更新匯率：我要贏買入改 135"}'

# 拉對話摘要（未來可由 Sentinel 排程自動做）
# 遠端重啟
fly machine restart <machine-id>
```

---

## 部署步驟 (Rhaenyra SOP)

### 前置準備

- [ ] LINE Developers 帳號 → 建 Messaging API channel → 拿 token + secret
- [ ] Fly.io 帳號 → 安裝 flyctl CLI
- [ ] 確認有 DeepSeek 或 Anthropic API key

### 部署流程

```bash
# 1. Clone OpenClaw
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# 2. 建 Fly app（region 選東京，離台灣近）
fly apps create bita-line
fly volumes create openclaw_data --size 1 --region nrt

# 3. 設定 secrets（不進 Docker，安全）
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
fly secrets set DEEPSEEK_API_KEY=sk-...           # 或 ANTHROPIC_API_KEY
fly secrets set LINE_CHANNEL_ACCESS_TOKEN=你的TOKEN
fly secrets set LINE_CHANNEL_SECRET=你的SECRET
fly secrets set TELEGRAM_BOT_TOKEN=你的TG_TOKEN

# 4. 修改 fly.toml
#    app = "bita-line"
#    primary_region = "nrt"

# 5. 部署（Dockerfile 已經寫好，直接用）
fly deploy

# 6. 確認運行
fly status
fly logs

# 7. SSH 進去寫配置和知識庫
fly ssh console
mkdir -p /data/workspace/bita-cs/knowledge
# 寫 openclaw.json, SOUL.md, 知識庫檔案（見下方）
```

### LINE Webhook 設定

到 LINE Developers Console → Messaging API：

- Webhook URL: `https://bita-line.fly.dev/line/webhook`
- 啟用 Use webhook
- 關閉自動回覆訊息

### 更新匯率 (日常操作)

```bash
# 方法 1: SSH 直接改
fly ssh console
vi /data/workspace/bita-cs/knowledge/platforms.md

# 方法 2: 透過 Claude Code
# 在 Terminal 裡跟 Claude 說「幫我改前線的匯率」
# Claude 會幫你跑 fly ssh 去改
```

---

## Rhaenyra 日常操作速查

| 我想要...           | 做法                                          |
| ------------------- | --------------------------------------------- |
| 改匯率              | `fly ssh console` → 改 platforms.md           |
| 加新 FAQ            | `fly ssh console` → 改 faq.md                 |
| 看客服 log          | `fly logs`                                    |
| 重新部署            | `fly deploy`                                  |
| 看運行狀態          | `fly status`                                  |
| 重啟                | `fly machine restart <id>`                    |
| 用 Claude Code 幫忙 | 打開 Terminal → `claude` → 用自然語言描述需求 |

---

## 待辦事項

1. [ ] 寫 bita-cs 的 SOUL.md（LINE 客服專用人格）
2. [ ] 準備 Fly.io 的 openclaw.json 完整配置
3. [ ] LINE Developers 建 channel，拿 credentials
4. [ ] 建 Telegram 客服後台群
5. [ ] 首次 fly deploy
6. [ ] 測試 LINE → AI 回覆 → Telegram 通知 完整流程
7. [ ] 設計母艦 → 前線的匯率同步機制
