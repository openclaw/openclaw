# 幣塔 Domain Memory

## 基本資訊

- **角色**: 杜甫是 AI 顧問，用 Andrew 帳號溝通
- **對接人**: Josh
- **員工**: 兔兔、小峻、子墨(Z)、羽玲、小周/米花、QQ
- **系統設計**: 月球體系（嫦娥/氣質美女/貴賓狗/社交NB 四角色）

## Workspace

- **路徑**: `~/Documents/幣塔/`
- **DB**: `data/bita.db`（transactions, calibration_reports, daily_summary）
- **員工**: `data/employees.json`（BT-001~BT-007）
- **Growth Profiles**: `data/growth-profiles/BT-XXX.json`
- **每日分析**: `data/daily/{YYYY-MM-DD}/`
- **Agent 家**: `~/clawd/workspace/agents/bita/`
- **Skill 定義**: `~/clawd/workspace/skills/bita/SKILL.md`

## Chat IDs

| ID             | 說明           |
| -------------- | -------------- |
| -1003849990504 | 幣塔管理群     |
| -5297227033    | 幣塔-營銷客服  |
| -5070604096    | AI工作回報(子) |
| -5186655303    | AI工作回報(茂) |
| -5023713246    | AI工作回報(葦) |
| -5295280162    | AI工作回報(周) |
| -5030731997    | AI工作回報(QQ) |
| -5148508655    | AI工作回報(兔) |
| -5159438640    | AI工作回報(俊) |

## 客服經驗累積戰略（2026-01-30）

- **核心目標**: 不只是校準報告，要持續累積話術、案例、SOP
- **最終目標**: 累積足夠上下文 → 未來代替員工直接服務客戶
- **累積內容**: 話術模式、客戶類型、FAQ、SOP（入金/出金/活動/異常）、員工風格差異

## Image Understanding

- 幣塔子群曾累積 106 張圖超過限制，session 癱瘓
- 解決方案：啟用 `tools.media.image`，圖片先用 vision 轉文字再進 context
