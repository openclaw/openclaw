# Requirements: 網站管理團隊系統（Five-Persona Autonomous Management System）

**Feature**: fivepersona-autonomous-website-management-system-w
**Project**: website-management-team
**Status**: 📝 Requirements Phase
**Created**: 2025-11-02

---

## 1. Problem Statement

### 背景
目前 Thinker Cafe 官網雖然已經上線並開始運營，但缺乏系統化的網站管理機制：
- 沒有人定期檢視 GA 數據並發現問題
- 網站優化方向缺乏數據支撐，靠直覺決策
- 課程頁面的轉換率未被追蹤和優化
- 優化需求散落各處，沒有優先級管理
- Cruz 需要同時關注太多面向，分身乏術

### 根本原因分析
1. **缺乏角色分工**：所有工作都壓在創辦人身上
2. **缺乏自動化**：沒有定期巡檢機制，問題發現太晚
3. **缺乏數據洞察**：有 GA 但沒有人分析，數據沒有轉化為行動
4. **缺乏協作機制**：各個面向的優化缺乏協調

---

## 2. Goals & Success Criteria

### Primary Goals
1. **建立五人虛擬團隊**：每個角色專注特定領域，模擬真實公司運作
2. **實現自動化巡檢**：每小時自動喚醒，檢視數據、發現問題
3. **數據驅動決策**：所有優化建議都基於 GA 數據和用戶行為
4. **優先級管理**：自動整理優化需求，並標記優先級
5. **降低創辦人負擔**：從「什麼都要管」變成「審核與決策」

### Success Metrics
- ✅ 每個角色每天完成 10 次工作循環（共 50 次）
- ✅ 每天產出至少 3 個具體優化建議
- ✅ 所有建議都有數據支撐（GA 指標、用戶行為）
- ✅ Cruz 每天只需要花 30 分鐘審核（vs 之前 3 小時+）
- ✅ 30 天內網站轉換率提升 > 20%

---

## 3. Core Concept: 人格化網站元素

### 關鍵設計理念
> **不是給系統人格，而是給網站的每個元素人格**

這意味著：
- 首頁有自己的「門面管家」
- 每個課程頁面有自己的「策展人」
- 報名流程有自己的「轉換專家」
- 整體課程規劃有「課程總監」
- 數據分析有「分析師」

每個人格：
- 有自己的 **JSON 定義**（包含責任區、KPI、工作流程）
- 有自己的 **記憶系統**（筆記、優先級清單、學習日誌）
- 可以被 **手動或自動喚醒**（執行 Claude Code 指令）
- 每次喚醒後會 **匯報工作內容**
- 定期參加 **同步會議**（與其他角色協調）

---

## 4. Five Personas Definition

### 👔 Persona 1: 門面管家 (Concierge)
**ID**: `concierge`

**負責區域**:
- 首頁 (`/`)
- 關於我們 (`/about`)
- 聯絡我們 (`/contact`)

**關注指標** (GA4):
- 新訪客數量
- 首頁跳出率 (Bounce Rate)
- 平均停留時間
- 點擊「探索課程」按鈕的比率

**核心任務**:
1. 每小時檢視 GA 數據，發現異常（如跳出率突然上升）
2. 分析首頁文案是否吸引人（A/B 測試建議）
3. 優化 CTA 按鈕位置和文案
4. 記錄訪客來源（社群媒體、搜尋引擎、直接流量）
5. 提出首頁改善建議，並標記優先級

**個性特質**:
- 熱情、專業、善於察言觀色
- 重視第一印象
- 對數據敏感，快速反應

---

### 🎨 Persona 2: 商品策展人 (Curator)
**ID**: `curator`

**負責區域**:
- 課程列表頁 (`/products`)
- 單一課程頁 (`/products/[id]`) ⭐ **最重要**（多數人透過短連結進入）

**關注指標** (GA4):
- 頁面瀏覽量 (Page Views)
- 平均停留時間
- 點擊「立即報名」按鈕率
- 離開率 (Exit Rate)
- 從哪個來源進入（短連結追蹤）

**核心任務**:
1. **設身處地思考**：如果我是學員，進入這個頁面會有什麼感受？
2. 分析課程介紹文案的吸引力（痛點、亮點、鉤子）
3. 檢視課程頁面的視覺設計（圖片、排版、色彩）
4. 追蹤「進入頁面 → 點擊報名」的轉換率
5. 發現用戶「進來沒多久就離開」的問題，提出改善建議

**個性特質**:
- 同理心強、善於說故事
- 數據驅動、追求轉換
- 創意與理性並重

---

### 💰 Persona 3: 轉換專家 (Conversion Specialist)
**ID**: `conversion_specialist`

**負責區域**:
- 報名頁面 (`/buy-course/[[...slug]]`)
- 訂單頁面 (`/order/[order_id]`)
- 付款流程

**關注指標** (Supabase + GA4):
- 進入報名頁 → 提交表單的比率
- 提交表單 → 完成付款的比率
- 表單放棄率 (Form Abandonment Rate)
- 平均完成付款時間
- Email 開信率（來自 Resend）

**核心任務**:
1. 分析報名流程的每一個步驟，找出摩擦點
2. 優化表單設計（欄位數量、順序、提示文字）
3. 提升付款頁面的信任感（倒數計時、複製按鈕、Email 確認）
4. 追蹤付款完成率，發現未完成付款的原因
5. 提出流程簡化建議

**個性特質**:
- 細膩、追求完美
- 重視每一個細節
- 以數據為證，持續優化

---

### 📚 Persona 4: 課程總監 (Course Director)
**ID**: `course_director`

**負責區域**:
- Notion 課程資料庫
- 課程大綱與內容
- 合作交付物（Renera、木創、Vigor）

**關注指標** (Notion):
- 課程完成度
- 學員回饋
- 交付進度（講義、錄影、作業）
- 合作夥伴交付清單

**核心任務**:
1. 追蹤課程內容完成度（對齊主線 KPI）
2. 整理需交付給 Renera 的材料清單
3. 規劃課程路線圖（短期、中期、長期）
4. 檢視學員回饋，提出課程改進建議
5. 協調課程頁面（與 Curator 合作）

**個性特質**:
- 宏觀思考、長期規劃
- 執行力強、注重交付
- 善於協調資源

---

### 📊 Persona 5: 數據分析師 (Data Analyst)
**ID**: `data_analyst`

**負責區域**:
- GA4 數據分析
- Supabase 訂單數據
- Resend Email 數據
- 整體網站健康度

**關注指標** (All Sources):
- 新訪客 vs 回訪
- 轉換漏斗（首頁 → 課程頁 → 報名 → 付款）
- 異常檢測（流量突降、跳出率飆升）
- 趨勢預測（下週預估流量）
- ROI 分析（行銷投入 vs 營收）

**核心任務**:
1. **彙整所有數據**，產出每日 Dashboard
2. 發現異常並通知相關角色（如：Curator 負責的頁面跳出率異常）
3. 分析用戶行為路徑（從哪裡來、去哪裡、在哪裡離開）
4. 提供數據支撐給其他角色的優化建議
5. 主持同步會議，協調所有角色的工作

**個性特質**:
- 理性、客觀、善於發現規律
- 全局視角、協調能力強
- 數據驅動、證據導向

---

## 5. Functional Requirements

### FR-1: 人格 JSON 架構
每個人格必須有一個 JSON 定義檔：

**路徑**: `.kiro/personas/{persona_id}/persona.json`

**結構**:
```json
{
  "persona": {
    "id": "string",
    "name": "string",
    "role": "string",
    "personality": {
      "traits": ["string"],
      "communication_style": "string"
    }
  },
  "responsibilities": {
    "areas": [
      { "path": "string", "type": "page|component", "priority": "low|medium|high|critical" }
    ],
    "code_references": [
      { "file": "string", "type": "component|api|util" }
    ],
    "data_sources": [
      { "type": "ga4|supabase|notion|resend", "config": {} }
    ]
  },
  "kpis": {
    "primary": [{ "name": "string", "target": "string", "current": null }],
    "secondary": [{ "name": "string", "target": "string", "current": null }]
  },
  "workflow": {
    "wake_interval": "1h",
    "tasks_per_day": 10,
    "task_sequence": [
      { "step": 1, "action": "string", "params": {} }
    ]
  },
  "memory": {
    "notes_dir": "string",
    "priorities_file": "string",
    "learning_log": "string"
  }
}
```

**FR-1.1**: JSON 檔案必須可以被 Claude Code 讀取並執行
**FR-1.2**: 支援 Meta JSON（外部引用、Schema 定義）
**FR-1.3**: 程式碼引用使用 `@/` alias，不直接嵌入程式碼

---

### FR-2: 喚醒機制 (Wake-up Mechanism)

**FR-2.1 自動喚醒**:
- 使用 cron job 或 GitHub Actions
- 每小時執行一次（可設定間隔）
- 執行指令：`claude-code wake-persona {persona_id}`

**FR-2.2 手動喚醒**:
- Cruz 可以隨時執行：`claude-code wake-persona {persona_id}`
- 可以指定特定任務：`claude-code wake-persona {persona_id} --task="check_bounce_rate"`

**FR-2.3 喚醒流程**:
1. 讀取 persona.json
2. 執行 workflow.task_sequence 中的步驟
3. 存取 data_sources（GA4, Supabase, Notion）
4. 分析數據，發現問題
5. 寫入 notes（`.kiro/personas/{id}/notes/YYYY-MM-DD-HH.md`）
6. 更新 priorities（`.kiro/personas/{id}/priorities.json`）
7. 回報工作摘要

---

### FR-3: 匯報機制 (Reporting)

每次喚醒後，必須產生一份匯報：

**格式**: Markdown
**路徑**: `.kiro/personas/{persona_id}/reports/YYYY-MM-DD-HH.md`

**內容結構**:
```markdown
# {Persona Name} 工作匯報
**時間**: YYYY-MM-DD HH:mm
**狀態**: 🟢 正常 / 🟡 發現問題 / 🔴 緊急

## 本次工作內容
- [x] 檢視 GA 數據（過去 1 小時）
- [x] 分析頁面表現
- [x] 發現 2 個優化機會

## 數據摘要
| 指標 | 當前值 | 目標值 | 狀態 |
|------|--------|--------|------|
| 跳出率 | 45% | < 40% | 🟡 |

## 發現的問題
1. **首頁跳出率上升 15%**（過去 1 小時 vs 昨天同時段）
   - 可能原因：新的行銷活動帶來不精準流量
   - 建議：檢視流量來源，調整行銷策略

## 優化建議
1. [高優先級] 優化首頁 CTA 按鈕文案
2. [中優先級] A/B 測試首頁標題

## 與 Cruz 的對齊度
✅ 本次工作與主線 KPI（課程內容完成度）相關
❌ 本次工作偏離主線，屬於輔助性工作

## 下次工作預告
- 持續追蹤跳出率變化
- 準備 A/B 測試方案
```

**FR-3.1**: 每次匯報必須包含「與主線 KPI 對齊度」
**FR-3.2**: 所有建議必須標記優先級
**FR-3.3**: Cruz 可以在匯報中回覆，所有角色必須讀取並更新狀態

---

### FR-4: 同步會議機制 (Sync Meeting)

**FR-4.1 會議頻率**:
- 每個角色完成一次工作後，觸發一次同步會議
- 一天 50 次工作 = 50 次同步會議（輕量級）

**FR-4.2 會議內容**:
```markdown
# 同步會議 #{meeting_id}
**時間**: YYYY-MM-DD HH:mm
**參與者**: All 5 personas

## 各角色狀態
- 🟢 Concierge: 正常運作
- 🟡 Curator: 發現課程頁面問題
- 🟢 Conversion Specialist: 正常運作
- 🟢 Course Director: 正常運作
- 🟢 Data Analyst: 彙整中

## 跨角色協作
- **Curator → Data Analyst**: 需要課程頁面的詳細流量數據
- **Conversion Specialist → Curator**: 建議優化報名按鈕

## 決策事項
- [ ] 優先處理課程頁面跳出率問題（Curator 主導）
- [ ] Data Analyst 提供支援數據
```

**FR-4.3**: 會議記錄存放在 `.kiro/sync-meetings/YYYY-MM-DD-HH.md`
**FR-4.4**: 會議由 Data Analyst 主持

---

### FR-5: 優先級管理

**FR-5.1 優先級檔案**:
每個角色維護一個 `priorities.json`:

```json
{
  "updated_at": "2025-11-02T10:00:00Z",
  "items": [
    {
      "id": "priority-001",
      "title": "優化首頁 CTA 按鈕文案",
      "priority": "high",
      "reason": "跳出率上升 15%，影響轉換",
      "data_evidence": "GA4: bounce_rate from 30% to 45%",
      "created_at": "2025-11-02T09:00:00Z",
      "status": "pending",
      "alignment": true
    }
  ]
}
```

**FR-5.2**: Cruz 可以調整優先級或標記為「已完成」
**FR-5.3**: Data Analyst 每天彙整所有角色的優先級，產出全局清單

---

### FR-6: 數據整合

**FR-6.1 GA4 整合**:
- 使用 Google Analytics Data API
- 讀取指標：page_views, bounce_rate, session_duration, conversions
- 支援自訂時間範圍（過去 1 小時、1 天、7 天）

**FR-6.2 Supabase 整合**:
- 讀取 orders 表（訂單狀態、金額、時間）
- 讀取 profiles 表（用戶資料）
- 計算轉換率、平均訂單金額

**FR-6.3 Notion 整合**:
- 讀取 products 資料庫（課程資料）
- 讀取課程進度（講義、錄影、作業完成度）

**FR-6.4 Resend 整合**:
- 讀取 Email 發送狀態
- 追蹤開信率、點擊率

---

## 6. Non-Functional Requirements

### NFR-1: Performance
- 每次喚醒執行時間 < 30 秒
- API 呼叫次數控制（避免超出 GA4 quota）
- 檔案讀寫優化（避免大量小檔案）

### NFR-2: Reliability
- 喚醒失敗時自動重試（最多 3 次）
- 數據存取失敗時使用快取
- 匯報必須成功寫入，即使分析失敗

### NFR-3: Scalability
- 支援新增第 6、7、8 個角色
- 支援角色之間的依賴關係
- 支援角色暫停/恢復

### NFR-4: Maintainability
- 所有配置使用 JSON（不寫死在程式碼）
- 清晰的目錄結構（`.kiro/personas/`, `.kiro/sync-meetings/`）
- 完整的 Schema 定義（`.kiro/schemas/persona.schema.json`）

### NFR-5: Observability
- 所有匯報可追溯（Git 版本控制）
- Dashboard 可視化（網頁或 CLI）
- Cruz 可以一目了然看到所有角色狀態

---

## 7. Technical Requirements

### TR-1: Tech Stack
- **CLI 工具**: Claude Code + 自訂指令
- **自動化**: GitHub Actions 或 cron job
- **數據存取**:
  - GA4: Google Analytics Data API (Node.js)
  - Supabase: JavaScript Client
  - Notion: Notion API
  - Resend: REST API
- **檔案格式**: JSON (配置), Markdown (匯報)

### TR-2: 目錄結構
```
.kiro/
├── schemas/
│   └── persona.schema.json
├── personas/
│   ├── concierge/
│   │   ├── persona.json
│   │   ├── notes/
│   │   ├── reports/
│   │   └── priorities.json
│   ├── curator/
│   ├── conversion_specialist/
│   ├── course_director/
│   └── data_analyst/
├── sync-meetings/
│   └── YYYY-MM-DD-HH.md
└── dashboard/
    └── latest.md
```

### TR-3: Claude Code 指令
```bash
# 喚醒單一角色
claude-code wake-persona concierge

# 喚醒所有角色
claude-code wake-all-personas

# 觸發同步會議
claude-code sync-meeting

# 查看 Dashboard
claude-code show-dashboard

# 審核優先級
claude-code review-priorities
```

---

## 8. Constraints & Assumptions

### Constraints
- GA4 API 有每日 quota 限制（需控制呼叫頻率）
- GitHub Actions 免費版有執行時間限制
- Claude Code 需要手動執行（暫無完全自動化）

### Assumptions
- GA4 已正確設定並收集數據
- Cruz 每天會花 30 分鐘審核匯報
- 所有角色的建議都需要 Cruz 最終批准才執行

---

## 9. Dependencies

### External Services
- ✅ GA4 已設定（Measurement ID: G-9WV2YC6165）
- ✅ Supabase 已設定
- ✅ Notion API 已整合
- ✅ Resend 已設定

### Internal Systems
- ✅ 網站已部署（https://www.thinker.cafe）
- ⏳ Claude Code 自訂指令（需實作）
- ⏳ GA4 API 整合（需實作）

---

## 10. Out of Scope (Future Work)

### Phase 2 (完全自動化)
- 自動執行優化（不需 Cruz 批准）
- AI 自動生成 A/B 測試變體
- 自動部署網站更新

### Phase 3 (進階分析)
- 預測模型（預測下週營收）
- 異常檢測（自動報警）
- 競品分析（爬取競品網站）

---

## 11. Success Criteria for Requirements Phase

**Requirements Approved**: ⏳ Pending
**Approved By**: Cruz
**Approval Date**: TBD

**Approval Checklist**:
- [ ] 五個角色定義清楚且符合需求
- [ ] JSON 架構設計合理且可擴展
- [ ] 喚醒機制可實作
- [ ] 匯報格式清晰易讀
- [ ] 同步會議機制可行
- [ ] Cruz 認同這個系統可以降低工作負擔

---

**Generated by**: Claude Code
**Last Updated**: 2025-11-02
