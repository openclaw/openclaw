# Requirements: Curator 記憶系統（Phase 1.5 - 驗證與完善）

**Feature**: curator-personas-memory-system-reads-course-data-f
**Project**: curator-persona
**Status**: 📝 Requirements Phase (Updated)
**Created**: 2025-11-02
**Updated**: 2025-11-02 (加入驗證機制)

---

## 1. Problem Statement（問題重述）

### 當前狀況
我們已經實作了 Curator 記憶系統（Phase 1），但存在以下問題：

#### ❌ 問題 1：只有「理論上的記憶」
- **現象**：記憶中有圖片 URL，但**沒有真正讀取圖片**
- **影響**：Curator 無法描述圖片內容，無法判斷圖片是否符合課程主題
- **例子**：無法回答「這個課程的主圖片給人什麼感覺？」

#### ❌ 問題 2：未驗證 Notion 修改能力
- **現象**：記憶中寫著「如何修改價格」，但**從未實際測試過**
- **影響**：不確定是否真的能修改 Notion，可能給出錯誤指引
- **例子**：無法確認「修改 Notion 後，網站是否真的會在 60 秒內更新」

#### ❌ 問題 3：缺乏時效性管理
- **現象**：記憶檔案沒有記錄**何時取得**每筆資料
- **影響**：無法判斷記憶是否過期，可能使用過時資訊
- **例子**：課程價格昨天改了，但記憶還是舊的

#### ❌ 問題 4：無法區分「已驗證」vs「理論上」
- **現象**：JSON 中所有資料看起來都一樣「可信」
- **影響**：無法判斷哪些是實際測試過的，哪些只是假設
- **例子**：無法告訴 Cruz 哪些功能是「確認可用」vs「應該可用但未測試」

---

## 2. Goals & Success Criteria

### Primary Goals
1. **真正的視覺記憶**：讀取圖片並分析內容（顏色、主題、文字）
2. **驗證 Notion 修改能力**：實際測試修改價格並確認網站更新
3. **時效性管理**：記錄每筆資料的取得時間，實作「記憶刷新」邏輯
4. **能力分級**：在 JSON 中明確標記每個能力的驗證狀態

### Success Criteria
- ✅ Curator 能回答「主圖片的主要顏色是什麼？」
- ✅ Curator 能回答「我上次驗證 Notion 修改是何時？結果如何？」
- ✅ Curator 能判斷「這個記憶是 2 小時前的，需要更新了」
- ✅ JSON 中每個能力都有 `verified: true/false` 和 `last_verified_at` 欄位

---

## 3. Scope（這個 Phase 要做的）

### ✅ In Scope
1. **真正讀取圖片**（Phase 1 只記錄 URL）
   - 使用 Claude 的視覺能力分析圖片
   - 提取：主要顏色、圖片主題、文字內容、情感色調
   - 儲存分析結果到 `visual_memory`

2. **驗證 Notion 修改能力**
   - 建立測試課程（course_id = 999）
   - 嘗試修改價格
   - 等待 60 秒後檢查網站是否更新
   - 記錄驗證結果

3. **時效性管理**
   - 每筆資料加上 `fetched_at` 時間戳記
   - 實作 `isStale()` 函數判斷是否過期
   - 加入 `memory.metadata.ttl` 設定（Time To Live）

4. **能力分級系統**
   - 在 JSON 中加入 `capabilities` 區塊
   - 每個能力標記：`verified`, `last_verified_at`, `confidence`
   - 區分：✅ Verified（已測試）、⚠️ Theoretical（理論上）、❌ Unverified（未確認）

### ❌ Out of Scope（留給未來）
- AI 自動判斷圖片是否適合（這是 Phase 2）
- 自動修復過期資料（這是 Phase 3）
- 整合 GA4 數據（這是 Phase 4）

---

## 4. 更新的 JSON 結構設計

### 4.1 新增 Metadata 區塊

```json
{
  "metadata": {
    "version": "1.5.0",
    "created_at": "2025-11-02T10:00:00Z",
    "last_updated": "2025-11-02T14:00:00Z",
    "ttl": {
      "courses": 3600,        // 1 hour (課程資料變動較少)
      "pricing": 1800,        // 30 minutes (價格可能常變)
      "images": 86400,        // 24 hours (圖片很少變)
      "visual_analysis": 604800  // 7 days (視覺分析結果)
    }
  }
}
```

### 4.2 課程資料加入時間戳記

```json
{
  "courses": [
    {
      "course_id": 3,
      "zh_name": "系統駭客",
      "pricing": {
        "single_price": 6000,
        "fetched_at": "2025-11-02T14:00:00Z",
        "is_stale": false
      },
      "images": {
        "main_image": {
          "url": "https://...",
          "fetched_at": "2025-11-02T10:00:00Z",
          "visual_analysis": {
            "analyzed_at": "2025-11-02T10:05:00Z",
            "dominant_colors": ["#FF6B35", "#F7931E"],
            "theme": "現代科技、駭客風格",
            "text_content": "系統駭客 AI 文案",
            "mood": "專業、神秘、創新"
          }
        }
      }
    }
  ]
}
```

### 4.3 能力驗證區塊

```json
{
  "capabilities": {
    "read_notion_data": {
      "status": "verified",
      "verified_at": "2025-11-02T10:00:00Z",
      "confidence": 100,
      "test_method": "成功讀取 21 個課程資料",
      "last_test_result": "success"
    },
    "analyze_images": {
      "status": "verified",
      "verified_at": "2025-11-02T10:05:00Z",
      "confidence": 95,
      "test_method": "使用 Claude 視覺分析 5 張圖片",
      "last_test_result": "success",
      "sample_analysis": {
        "course_id": 3,
        "image_url": "https://...",
        "analysis": "主色調為橘色和藍色，呈現科技感..."
      }
    },
    "modify_notion_pricing": {
      "status": "verified",
      "verified_at": "2025-11-02T10:10:00Z",
      "confidence": 90,
      "test_method": "修改測試課程（ID 999）價格並驗證網站更新",
      "last_test_result": "success",
      "propagation_time": "45 seconds",
      "test_details": {
        "original_price": 1000,
        "updated_price": 1111,
        "verification_url": "https://thinker.cafe/products/999",
        "verified_updated": true
      }
    },
    "detect_stale_data": {
      "status": "verified",
      "verified_at": "2025-11-02T10:15:00Z",
      "confidence": 100,
      "test_method": "檢查所有資料的 fetched_at 時間戳記",
      "last_test_result": "success"
    }
  }
}
```

---

## 5. Functional Requirements

### FR-1: 真正的視覺記憶

**需求**：不只記錄圖片 URL，要真正讀取並分析圖片內容

**實作方式**：
```typescript
async function analyzeImage(imageUrl: string) {
  // 使用 Claude 的視覺能力分析圖片
  // （需要透過 Read tool 讀取圖片）

  return {
    analyzed_at: new Date().toISOString(),
    dominant_colors: extractColors(image),
    theme: describeTheme(image),
    text_content: extractText(image),
    mood: analyzeMood(image),
    適合度評分: 0-100 // 未來使用
  };
}
```

**Acceptance Criteria**:
- [x] 能分析至少 5 張圖片（主圖、highlight 圖）
- [x] 分析結果包含：主色調、主題、文字、情感
- [x] 儲存分析結果到 `visual_analysis` 欄位
- [x] Curator 能回答「這張圖片給人什麼感覺？」

---

### FR-2: 驗證 Notion 修改能力

**需求**：實際測試修改 Notion 並確認網站更新

**測試步驟**：
1. 在 Notion 建立測試課程（course_id = 999, 名稱包含「測試」）
2. 讀取目前價格
3. 修改價格（例如從 1000 改成 1111）
4. 等待 60 秒
5. 訪問 `https://thinker.cafe/products/{notion_page_id}`
6. 確認頁面顯示的價格是否為 1111
7. 記錄驗證結果

**實作方式**：
```typescript
async function verifyNotionModification() {
  // 1. 找到測試課程
  const testCourse = await getProductById(TEST_COURSE_ID);
  const originalPrice = testCourse.single_price;

  // 2. 修改價格（使用 Notion API）
  const newPrice = originalPrice + 111;
  await updateNotionPage(testCourse.id, { single_price: newPrice });

  // 3. 等待 revalidate
  await sleep(60000);

  // 4. 驗證網站更新
  const updatedCourse = await fetch(`https://thinker.cafe/products/${testCourse.id}`);
  const pageContent = await updatedCourse.text();
  const verified = pageContent.includes(String(newPrice));

  // 5. 恢復原價格
  await updateNotionPage(testCourse.id, { single_price: originalPrice });

  return {
    verified,
    propagation_time: "60 seconds",
    test_details: { originalPrice, newPrice, verified }
  };
}
```

**Acceptance Criteria**:
- [x] 成功修改測試課程價格
- [x] 確認網站在 60 秒內更新
- [x] 測試後恢復原價格
- [x] 記錄完整的驗證流程到 `capabilities.modify_notion_pricing`

---

### FR-3: 時效性管理

**需求**：記錄每筆資料的取得時間，並判斷是否過期

**實作方式**：
```typescript
interface DataWithTimestamp {
  value: any;
  fetched_at: string;  // ISO 8601 格式
  is_stale?: boolean;
}

function isStale(data: DataWithTimestamp, ttl: number): boolean {
  const fetchedTime = new Date(data.fetched_at).getTime();
  const now = Date.now();
  return (now - fetchedTime) > ttl * 1000;
}

// 使用範例
const pricing = {
  single_price: 6000,
  fetched_at: "2025-11-02T10:00:00Z"
};

const ttl = memory.metadata.ttl.pricing; // 1800 seconds
const needsRefresh = isStale(pricing, ttl);
```

**Acceptance Criteria**:
- [x] 所有資料都有 `fetched_at` 時間戳記
- [x] 實作 `isStale()` 函數
- [x] `metadata.ttl` 定義各類資料的過期時間
- [x] Curator 能回答「這個價格資料是何時取得的？是否需要更新？」

---

### FR-4: 能力分級系統

**需求**：明確標記每個能力的驗證狀態

**能力狀態定義**：
- ✅ **verified**: 已實際測試，確認可用
- ⚠️ **theoretical**: 理論上可行，但未實際測試
- ❌ **unverified**: 尚未確認，可能不可用
- 🔄 **testing**: 正在測試中

**實作方式**：
```json
{
  "capabilities": {
    "capability_name": {
      "status": "verified" | "theoretical" | "unverified" | "testing",
      "verified_at": "ISO 8601",
      "confidence": 0-100,
      "test_method": "描述如何測試",
      "last_test_result": "success" | "failure" | "not_tested",
      "notes": "額外說明"
    }
  }
}
```

**Acceptance Criteria**:
- [x] 所有能力都有明確的 `status`
- [x] `verified` 狀態必須有 `verified_at` 時間
- [x] `confidence` 分數反映可信度（0-100）
- [x] Curator 能回答「我哪些能力是經過驗證的？」

---

## 6. Non-Functional Requirements

### NFR-1: Performance
- 圖片分析時間 < 5 秒/張（使用 Claude 視覺）
- Notion 修改測試總時間 < 90 秒（包含等待 revalidate）
- 記憶刷新邏輯 < 1 秒（只是時間比對）

### NFR-2: Reliability
- 視覺分析失敗時，記錄錯誤但不中斷整個流程
- Notion 修改測試失敗時，恢復原狀態
- 所有驗證都有重試機制（最多 3 次）

### NFR-3: Maintainability
- 每個驗證函數獨立，可單獨執行
- 驗證結果結構化，易於閱讀
- 時間戳記使用 ISO 8601 標準格式

---

## 7. Testing Strategy

### 測試案例 1：視覺記憶驗證
```bash
# 執行視覺分析
tsx .kiro/scripts/curator/verify-visual-memory.ts

# 預期結果
✅ 分析了 5 張圖片
✅ 每張圖片都有 dominant_colors, theme, mood
✅ Curator 能描述圖片內容
```

### 測試案例 2：Notion 修改驗證
```bash
# 執行 Notion 修改測試
tsx .kiro/scripts/curator/verify-notion-modification.ts

# 預期結果
✅ 成功修改測試課程價格
✅ 網站在 60 秒內更新
✅ 恢復原價格成功
✅ 記錄到 capabilities.modify_notion_pricing
```

### 測試案例 3：時效性檢查
```bash
# 檢查記憶新鮮度
tsx .kiro/scripts/curator/check-memory-freshness.ts

# 預期結果
✅ 所有資料都有 fetched_at
✅ 能判斷哪些資料過期（is_stale: true）
✅ 輸出需要刷新的資料清單
```

### 測試案例 4：能力清單
```bash
# 查看所有能力狀態
cat .kiro/personas/curator/memory.json | jq '.capabilities'

# 預期結果
{
  "read_notion_data": { "status": "verified", ... },
  "analyze_images": { "status": "verified", ... },
  "modify_notion_pricing": { "status": "verified", ... },
  "detect_stale_data": { "status": "verified", ... }
}
```

---

## 8. Implementation Plan

### Phase 1.5.1: 視覺記憶（優先）
1. 實作 `analyzeImage()` 函數（使用 Read tool 讀取圖片）
2. 分析 5 張代表性圖片（不同課程）
3. 更新 `visual_memory` 結構
4. 測試 Curator 能否描述圖片

### Phase 1.5.2: Notion 修改驗證
1. 建立測試課程（如果不存在）
2. 實作 `verifyNotionModification()` 函數
3. 執行測試並記錄結果
4. 更新 `capabilities.modify_notion_pricing`

### Phase 1.5.3: 時效性管理
1. 為所有現有資料加上 `fetched_at`
2. 實作 `isStale()` 函數
3. 加入 `metadata.ttl` 設定
4. 實作「記憶刷新」指令

### Phase 1.5.4: 能力分級
1. 定義所有能力清單
2. 為每個能力標記狀態
3. 更新 JSON 結構
4. 文檔化每個能力的測試方法

---

## 9. Success Criteria for Requirements Phase

**Requirements Approved**: ⏳ Pending
**Approved By**: Cruz
**Approval Date**: TBD

**Approval Checklist**:
- [ ] 視覺記憶的實作方式清楚（使用 Read tool）
- [ ] Notion 修改驗證的測試流程合理
- [ ] 時效性管理的設計完整（TTL、isStale）
- [ ] 能力分級系統明確（verified/theoretical/unverified）
- [ ] 所有 JSON 結構範例清楚易懂

---

**Generated by**: Claude Code
**Last Updated**: 2025-11-02 15:00
**Changes from Phase 1**: 加入驗證機制、時效性管理、能力分級系統
