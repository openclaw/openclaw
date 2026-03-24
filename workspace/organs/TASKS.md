# TASKS.md - 任務佇列

## 待辦

- [ ] [P1] Vivian 聯絡人建檔 `memory/contacts/vivian.md` — 指派：無極 — 期限：2026-02-19
- [ ] [P2] DeepSeek API key 設定，bita/xo 改回 DeepSeek 省錢 — 指派：Cruz 提供 key — 期限：本週
- [ ] [P2] Threads 自動化流程設計 — 指派：無極 — 期限：待 Cruz 提供 API
- [ ] [P3] The Collision 產品規格確認 — 指派：Cruz — 期限：待定
- [ ] [P3] ThinkerCafe 現狀盤點 — 指派：Cruz/R — 期限：待定

## 進行中

- [-] [P1] bita 客服群回覆修復 — 指派：無極 — 開始：2026-02-18（SOUL.md/AGENTS.md 已改，待驗證）
- [-] [P0] Genesis Kernel 落地 — 指派：無極 — 開始：2026-02-18
- [-] [P1] LoLo Care Phase 5：並行運行 7 天後退役 NPC B — 指派：無極 — 開始：2026-02-19
- [-] [P1] Chat-as-OS：擴充 widget 種類 — 指派：無極 — 開始：2026-02-19

## 完成

- [x] [P1] OpenClaw 升級 2026.1.30 → 2026.2.15 — 完成：2026-02-17
- [x] [P1] 清除舊 LaunchAgent com.clawdbot.gateway — 完成：2026-02-17
- [x] [P1] HEARTBEAT.md 啟用 — 完成：2026-02-18
- [x] [P1] Genesis Kernel 存檔 — 完成：2026-02-18
- [x] [P1] LoLo Care 遷移 Phase 2-4 — 完成：2026-02-19
- [x] [P1] Chat-as-OS 第一個 Live Widget (Dashboard) — 完成：2026-02-19

## 待辦

- [ ] [P1] Win 要 P0 召回效果數據 — 指派：無極 — 期限：2026-02-24
  - Google Sheet: https://docs.google.com/spreadsheets/d/1j9MxrwEl_pJ54zE6xbjk60Sc-MYGOcZauQUQ1YNIZGs
  - 範圍：2/3-2/9 第一批 P0 名單（4,056 人）
  - 欄位：充值金額、投注量、註冊天數、登入天數、提款金額、最後登入日期、召回獎金金額、總獎金金額
  - 數據起算：2026-02-03
  - 狀態：分批查詢中，4K 人 IN clause + 5 JOIN 太重被 SIGKILL，需分批 1000 人跑
  - player_id 來源：~/Documents/two/data/p0/2026-02-05/ + 2026-02-06/
  - 已上傳 ids 到遠端 /tmp/p0_batch1_ids.txt 並 split 成 5 chunks
