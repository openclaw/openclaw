# 第六課改版計畫：AI 全能實戰營（實體課程）

## 📋 課程資訊

### 基本資訊
- **課程名稱**：AI 全能實戰營
- **原價顯示**：20,768 元（基於 7 門課計算）
- **優惠價**：10,000 元
- **課程類型**：實體課程

### 實體課程細節
- **日期**：2024/11/29, 12/6, 12/13 (六)
- **時間**：09:30-16:30（每天 7 小時，共 21 小時）
- **地點**：新北市板橋區民權路 83 號 1F
- **限額**：12 人
- **報名截止**：2024/11/24 (一)

### 交通資訊
- 捷運板南線「府中站」步行 5 分鐘
- 公車站牌「板橋區公所」旁

## 🔧 Notion 欄位規劃

### 需要新增的欄位

1. **course_type** (Select)
   - 選項：線上課程 | 實體課程 | 混合式
   - 第六課設定：實體課程

2. **physical_dates** (Rich Text)
   - 內容：2024/11/29, 12/6, 12/13 (六)

3. **physical_time** (Rich Text)
   - 內容：09:30-16:30

4. **physical_location** (Rich Text)
   - 內容：新北市板橋區民權路 83 號 1F

5. **physical_capacity** (Number)
   - 內容：12

6. **registration_deadline** (Date)
   - 內容：2024-11-24

7. **transportation** (Rich Text)
   - 內容：捷運板南線「府中站」步行 5 分鐘

8. **original_price_display** (Number)
   - 內容：20768
   - 用途：行銷頁面顯示的原價（與實際 single_price 分開）

## 🎨 前端改版規劃

### 1. Bar 區塊（4 個重點）

```typescript
bar_text_1: "📅 11/29, 12/6, 12/13"
bar_text_2: "📍 板橋區公所旁"
bar_text_3: "👥 限額 12 人"
bar_text_4: "⏰ 截止 11/24"
```

### 2. CourseInfo 組件（新建）

位置：`app/components/course/CourseInfo.tsx`

顯示內容：
- 📅 完整日期時間
- 📍 詳細地址
- 🚇 交通資訊
- ⏰ 報名截止
- 👥 人數限制

### 3. 價格顯示邏輯

```typescript
// 如果是實體課程且有 original_price_display
originalPrice = course.original_price_display || course.single_price
currentPrice = course.single_price_early || course.single_price

// 顯示：原價 20,768 → 優惠價 10,000
```

## 📝 執行步驟

1. ✓ 規劃欄位（當前）
2. ⏸️ 新增 Notion Database 欄位（使用 Notion API）
3. ⏸️ 更新第六課資料
4. ⏸️ 修改前端組件
5. ⏸️ 本地測試

## 🔄 替代方案（如果 Notion API 無法新增欄位）

使用現有的 rich_text 欄位儲存 JSON：

```typescript
// 使用 summery 或新的 rich_text 欄位儲存
{
  "physical_info": {
    "dates": ["2024-11-29", "2024-12-06", "2024-12-13"],
    "time": "09:30-16:30",
    "location": "新北市板橋區民權路 83 號 1F",
    "capacity": 12,
    "deadline": "2024-11-24",
    "transportation": "捷運板南線「府中站」步行 5 分鐘"
  }
}
```
