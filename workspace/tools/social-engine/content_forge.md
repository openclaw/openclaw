# Content Forge — 帖文鍛造流程

每一篇帖文至少經過以下節點。跳過任何一個都會降低品質。

## 10 個節點

```
素材 → 蒸餾 → 白話 → 人格 → 視角 → 共振 → 增強 → 壓縮 → 圓桌 → 交付
```

### 1. 素材輸入 (Raw Input)

- Cruz 丟關鍵詞、連結、靈感、或一句話
- AI 負責擴展：搜論文、讀資料、抓數據
- 產出：結構化素材包

### 2. 技術蒸餾 (Distill)

- 把素材壓成每個概念一句話
- 去掉術語，留骨架
- 產出：5-10 句精華

### 3. 白話翻譯 (Simplify)

- 「如果我媽看不懂就重寫」
- 每句話不超過 20 個字
- 產出：任何人都秒懂的版本

### 4. 人格注入 (Voice)

- 用 Cruz 的聲音重寫
- 冷調、短句、系統架構師視角
- 禁止：emoji、勵志、「希望這對你有幫助」
- 檢查：Cruz 會這樣說嗎？

### 5. 視角切換 (Perspective)

- 至少嘗試三個視角：第一人稱 / 上帝視角 / 讀者視角
- 選最有力量的那個
- 問：這篇帖文的主角是誰？

### 6. 共振檢測 (Resonance Check)

- `wuji media resonance "文字"`
- 目標：≥ 65 分
- 如果 < 65：進入節點 7
- 如果 ≥ 65：跳到節點 8

### 7. 頻率增強 (Amplify)

- 檢查缺失頻段（taiwan_defense / ai_automation / asymmetric_warfare / memory_evolution）
- Opus 改寫：自然注入缺失頻段，不硬貼
- 重新跑共振檢測，直到 ≥ 65
- 規則：增強不能破壞節點 4 的人格

### 8. 字數壓縮 (Compress)

- Threads：≤ 500 字
- FB：不限
- 砍的順序：重複概念 > 過渡句 > 形容詞
- 絕不砍：開頭第一句、結尾最後一句、數據

### 9. 圓桌審核 (Council Review)

- 佛陀：方向對嗎？
- 薩古魯：能量對嗎？CTA 準備好了嗎？
- 孫子：這篇在跟誰打仗？有沒有在錯誤的戰場上？
- 武藏：能不能再砍一句？
- 至少一位提出修改意見才算審完

### 10. 交付 (Ship)

- `wuji media schedule "文字" <date> <time>`
- 記錄到 content_pipeline（source_text, category, score, scheduled_at）
- 發出後進入 FeedbackLoop 追蹤

## CLI 對應

| 節點 | 指令                                       |
| ---- | ------------------------------------------ |
| 1    | WebSearch / WebFetch                       |
| 2-5  | Opus 對話（session 內）                    |
| 6    | `wuji media resonance "text"`              |
| 7    | `wuji media amplify "text"` 或 Opus 改寫   |
| 8    | 手動 + `wuji media score "text"` 驗證      |
| 9    | 圓桌對話（session 內）                     |
| 10   | `wuji media schedule "text" <date> <time>` |

## 品質標準

| 指標           | 最低          | 目標              |
| -------------- | ------------- | ----------------- |
| 共振分數       | 65            | 80+               |
| 字數 (Threads) | —             | ≤ 500             |
| 人格一致性     | Cruz 不會皺眉 | Cruz 說「我喜歡」 |
| 頻段覆蓋       | ≥ 2           | ≥ 3               |
