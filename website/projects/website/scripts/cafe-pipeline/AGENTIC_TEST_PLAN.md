# Agentic Test Loop v2 — 自我推進的視覺品質永動機

## 核心概念

測試不是防守（pass/fail），是進攻（下一輪燃料）。
評審 Agent 帶著審美標準看截圖，產出的報告直接變成 Sculptor 的 prompt。

## 架構

```
Sculptor Agent (Sonnet) 改完一個元素
  → commit + push
  → 觸發 Test Agent (Sonnet)
      → Smoke Gate: __CAFE_STATE__ 驗證 (tiles>20, fps>30, no crash)
      → ❌ 失敗 → 跳過 Vision，直接報 P0 crash
      → ✅ 通過 → Playwright headless 截圖 5 個關鍵幀
      → Claude Vision 評審（角色：資深設計師 + 反AI審美）
      → 讀取 history/ 前一輪結果，對比進度
      → 產出 next-task.md（P0/P1/P2 分層）
      → 更新 tried-and-rejected.md（如果本輪改動被打回）
      → 熔斷檢查：連續 N 輪無提升 → 暫停
  → 下一輪 Sculptor 讀取 next-task.md + tried-and-rejected.md
  → ♻️ 永動機
```

## 六個組件

### 1. Test Seams — Canvas 狀態暴露 ✅ DONE

在 engine-pixi.js 的 gameTick 末尾，每幀更新：

```javascript
window.__CAFE_STATE__ = {
  player: { tileX: player.tileX, tileY: player.tileY, pixelX: player.pixelX, pixelY: player.pixelY },
  camera: { scale: camera.scale, offsetX: camera.offsetX, offsetY: camera.offsetY, isMobile: camera.isMobile, introActive: introCamera.active },
  npcs: npcs.map(function(n) { return { id: n.id, tileX: n.tileX, tileY: n.tileY, facing: n.facing }; }),
  tiles: { cacheKeys: window.CafeTiles ? Object.keys(window.CafeTiles.getCache()) : [] },
  fps: Math.round(app.ticker.FPS),
  entryState: entryState,
  idleMinutes: cachedIdleMinutes,
  timestamp: now
};
```

### 2. Playwright 截圖腳本 ✅ DONE

```
tests/cafe-visual.spec.js — iPhone 14 viewport, 5 keyframes
playwright.config.js — mobile-cafe project
```

5 個關鍵幀：
| 關鍵幀 | 觸發條件 | 視覺重點 |
|--------|---------|---------|
| intro-hold | waitMs 1500 | Cruz/吧台首屏品牌感 |
| intro-midpan | waitMs 3500 | 相機平移中的視覺一致性 |
| player-door | waitMs 6000 | 玩家在門口的空間引導 |
| player-bar | ArrowUp 3s | 高密度吧台區可讀性 |
| corner-npc | ArrowLeft 1.5s | 暗角 NPC 細節與環境融合 |

### 3. Smoke Gate — 多階段門檻 🆕

Vision tokens 很貴。在截圖前先跑 smoke gate，不通過就不燒錢：

```javascript
// 在 cafe-visual.spec.js 的截圖循環前
const state = await page.evaluate(() => window.__CAFE_STATE__);

// P0 gates — 任一失敗就中斷，不截圖
expect(state.tiles.cacheKeys.length).toBeGreaterThan(20);  // tiles loaded
expect(state.fps).toBeGreaterThan(30);                       // not frozen
expect(state.camera).toBeDefined();                          // engine alive
expect(state.npcs.length).toBeGreaterThan(0);                // entities spawned

// 如果 smoke gate 失敗，輸出:
// { "gate": "FAIL", "reason": "fps=12, tiles=0", "action": "skip_vision" }
```

### 4. Vision 評審 Prompt — 角色深度升級 🆕

```
你是一名具備 15 年經驗的像素藝術遊戲 UI 設計師，專精手機端可讀性。
你同時是「反 AI Slop」審美的守門人——任何看起來像是 AI 生成的平庸設計都要標記。

你收到了 Thinker Cafe 在 iPhone 14 上的 5 張關鍵幀截圖。

## 審美維度（每張截圖都評估）

1. **光的層級**：吧台最亮→桌區次之→角落最暗。光源是否有呼吸感？
2. **32px 可讀性**：在手機距離（~30cm）下，每個元素是否可辨識？
   - 對比度閾值：前景/背景色差 > 4.5:1（WCAG AA）
   - sub-pixel 偵測：是否有 lineWidth < 1.0 的幽靈線條？
3. **色彩分離**：每個元素是否跟鄰近物件有足夠色差？是否有混色？
4. **空間引導線**：門→光池→吧台的視覺動線是否可讀？
5. **反 AI Slop**：是否有過於均勻的漸層、缺乏個性的配色、機械式重複？
6. **氛圍一致性**：整體是否「深夜溫暖咖啡廳」？有沒有破壞沉浸的元素？

## 優先級定義

- **P0 (Critical)**：元素不可見、crash、功能障礙。必修。
- **P1 (Aesthetic)**：對比度不足、混色、光影不一致。應修。
- **P2 (Polish)**：微調韻律、氛圍細節、風格提升。可選。

## 輸出格式（JSON）

對 5 張截圖都做評審：
{
  "keyframe": "intro-hold",
  "score": 8,
  "issues": [
    {
      "element": "bar shelf bottles row 2",
      "priority": "P1",
      "description": "第二排瓶子標籤跟磚牆混色",
      "suggestion": "提高標籤對比度或加 1px 深色描邊"
    }
  ]
}

最後產出 ranked 任務清單（最多 5 項），P0 在最前。
如果本輪的某個改動讓 score 下降了，明確標記為 REGRESSION。
```

### 5. next-task.md + 歷史追蹤 🆕

#### 目錄結構
```
tests/
  screenshots/           # 每輪截圖（覆寫）
  history/
    round-001.json       # { round: 1, scores: [...], tasks: [...], timestamp }
    round-002.json
    ...
  next-task.md           # 當前輪的任務清單（Sculptor 讀這個）
  tried-and-rejected.md  # 反向記憶（Sculptor 避免重蹈覆轍）
```

#### next-task.md 格式
```markdown
# Next Sculptor Tasks (auto-generated)
Round: 7 | Updated: 2026-04-04T15:30:00
Previous round score: 7.2 → Current: 7.8 (+0.6)

## P0 — Must Fix
(none this round)

## P1 — Aesthetic
1. corner NPC 髮型在暗角不可讀 — corner-npc score 6.5
2. bar shelf 第二排瓶子標籤混色 — intro-hold score 7.0

## P2 — Polish
3. 走道第3個光池偏暗 — player-door score 8.0

Overall scene score: 7.8/10
Delta from last round: +0.6
```

#### tried-and-rejected.md 格式
```markdown
# Tried and Rejected — 不要再試的方向

## Round 3: 把 NPC outline 從 1px 加到 2px
**Result**: Judge 打回。原因：2px outline 讓像素角色看起來像卡通貼紙，破壞「深夜寫實」氛圍。
**Rule**: outline 最大 1px，用色差而非粗線來分離元素。

## Round 5: 把走道光池從暖色改冷色
**Result**: score 從 7.5 降到 6.8 (REGRESSION)。
**Rule**: 走道光池必須暖色（呼應吧台），冷色會打斷視覺動線。
```

### 6. 熔斷器 — 治理與預算控制 🆕

```javascript
const GOVERNANCE = {
  maxRounds: 10,            // 硬上限：10 輪後強制暫停
  tokenBudget: 50000,       // Vision tokens 預算帽
  stallThreshold: 2,        // 連續 N 輪 score 無提升（delta < 0.1）→ 暫停
  regressionLimit: 1,       // 連續 N 輪 score 下降 → 回滾 + 暫停
  minScoreToStop: 8.5,      // 達到此分數 → 宣告勝利，停止循環
};
```

#### 熔斷邏輯
```
每輪結束時：
  1. 讀 history/ 計算 delta
  2. if (round >= maxRounds) → HALT "迭代上限"
  3. if (totalTokens >= tokenBudget) → HALT "預算耗盡"
  4. if (連續 stallThreshold 輪 delta < 0.1) → HALT "停滯"
  5. if (連續 regressionLimit 輪 delta < 0) → git revert + HALT "倒退"
  6. if (currentScore >= minScoreToStop) → HALT "目標達成 🎉"
  7. else → 繼續下一輪
```

HALT 時輸出：
```markdown
# 🛑 Agentic Loop Halted
Reason: [停滯/預算/上限/倒退/達標]
Rounds completed: 7/10
Final score: 8.2/10
Token usage: 32,400/50,000
Human action required: [檢查 history/ 決定是否重啟]
```

## 執行順序

1. ~~加 `__CAFE_STATE__` Test Seams~~ ✅ DONE
2. ~~寫 Playwright 截圖腳本~~ ✅ DONE
3. **下一步**: 寫 `run-visual-qa.js` 腳本 — 串接 Playwright → Vision API → next-task.md
   - 包含 smoke gate 邏輯
   - 包含 history/ 寫入
   - 包含 tried-and-rejected.md 更新
   - 包含熔斷檢查
4. **之後**: 改 Sculptor prompt 讓它讀 next-task.md + tried-and-rejected.md
5. **最後**: Hook 化 — commit 後自動觸發 Test Agent

## 成本估算

- Playwright 截圖: 免費（本地 headless）
- Smoke gate: 免費（本地斷言）
- Vision 評審: 每輪 ~5 張圖 × ~800 tokens = ~4000 tokens（含角色 prompt）
- 歷史追蹤: ~500 tokens/輪（讀前輪 JSON）
- 永動機成本: 每 15 分鐘一輪 ≈ 每小時 18K Sonnet tokens
- 10 輪上限 ≈ 45K tokens ≈ ~$0.14（Sonnet 價格）
