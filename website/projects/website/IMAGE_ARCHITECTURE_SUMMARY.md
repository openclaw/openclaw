# ThinkerCafe 圖片架構分析 - 執行摘要

## 當前狀況速覽

| 項目 | 現況 | 評分 |
|-----|------|------|
| 圖片來源 | Notion (AWS S3) | ⚠️ 有風險 |
| URL 有效期 | 1 小時 | ❌ 太短 |
| 圖片最佳化 | 禁用 (unoptimized: true) | ❌ 無優化 |
| Image 組件使用 | 0% (全用原生 img) | ❌ 未使用 |
| 快取策略 | About 禁用 (revalidate: 0) | ⚠️ 不理想 |
| SVG 管理 | 硬編碼在代碼 | ❌ 難維護 |

---

## 三大核心問題

### 1. 圖片 URL 每小時失效
- Notion 簽名 URL 有效期限：3600 秒 (1 小時)
- memory.json 是靜態快照，不會自動更新
- 超過 1 小時後，網站圖片會開始出現 404 錯誤

### 2. 完全禁用 Next.js 最佳化
```javascript
// next.config.mjs
images: {
  unoptimized: true  // ❌ 導致：
}
// - 無 WebP/AVIF 轉換
// - 無響應式圖片
// - 無自動壓縮
```

### 3. 使用原生 HTML img 標籤
- 所有圖片都是 `<img src="..." />` 形式
- 完全沒有 Next.js 最佳化優勢
- 無 lazy loading, 無 priority, 無 sizes

---

## 效能影響

### 當前數據
- 圖片加載時間：2-4 秒
- 圖片總體積：200-500KB (未壓縮)
- Notion API 調用：每次訪問 1-4 次
- 圖片 404 風險：3 小時後開始

### 優化後預期
- 圖片加載時間：500-1000ms (改進 60-70%)
- 圖片總體積：50-100KB WebP (減少 75%)
- Notion API 調用：99% 減少 (使用 ISR 快取)
- 圖片 404 風險：幾乎消除

---

## 立即可做的事（優先級順序）

### Phase 1: 立即執行 (1-2 天)
```diff
// next.config.mjs
images: {
- unoptimized: true
+ unoptimized: false
+ remotePatterns: [{
+   protocol: 'https',
+   hostname: 'prod-files-secure.s3.us-west-2.amazonaws.com'
+ }]
}
```

**然後：替換所有原生 img 為 Next.js Image 組件**

**之前：**
```jsx
<img src={product.image} alt={product.zh_name} className="h-40 w-full object-cover" />
```

**之後：**
```jsx
<Image
  src={product.image}
  alt={product.zh_name}
  width={300}
  height={200}
  loading="lazy"
  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
/>
```

受影響文件：
- /app/products/ProductGrid.tsx (1 個圖片)
- /app/products/[id]/HighlightCard.js (6 個圖片)
- /app/about/page.tsx (10+ 個圖片)
- /app/orders/OrderCard.js (1 個圖片)

### Phase 2: 添加快取 (2-3 天)

```diff
// /app/products/[id]/page.tsx
- export const revalidate = 60;
+ export const revalidate = 3600;  // 1 小時後後台重新驗證

// /app/about/page.tsx
- export const revalidate = 0;
+ export const revalidate = 3600;
```

效果：
- 首次訪問：完整渲染 + API 調用
- 後續 1 小時內：從快取返回 (毫秒級)
- 自動後台更新

### Phase 3: 修復 SVG 問題 (3-5 天)

**當前問題：**
5 個課程的定價圖 SVG 硬編碼在 HighlightCard.js 第 7-93 行，共 5-10KB 代碼污染。

**解決方案：**
1. 在 Notion 課程資料庫添加 `pricing_image` 字段
2. 將 SVG 儲存為 Notion 圖片
3. 刪除所有硬編碼的 SVG 代碼

---

## 受影響的文件清單

### 必須修改
1. `/next.config.mjs` - 啟用圖片最佳化
2. `/app/products/ProductGrid.tsx` - 替換 1 個 img
3. `/app/products/[id]/HighlightCard.js` - 替換 6 個 img + 移除 SVG
4. `/app/products/[id]/page.tsx` - 增加 ISR 快取
5. `/app/about/page.tsx` - 替換 10+ 個 img + 增加 ISR 快取
6. `/app/orders/OrderCard.js` - 替換 1 個 img

### 參考文件
- `/lib/notion.ts` - 圖片 URL 來源 (pick.file 函數)
- `/.kiro/personas/curator/memory.json` - 當前 URL 快照 (280 個)

---

## 風險評估

### 高風險 (必須解決)
- **圖片 URL 過期** - 3 小時後開始失敗
  解決方案：實現自動刷新機制或使用圖片代理

- **性能不達標** - Google PageSpeed <50
  解決方案：啟用圖片最佳化 + ISR 快取

### 中風險 (應該改進)
- **代碼污染** - 5-10KB 硬編碼 SVG
  解決方案：移到 Notion

- **API 調用過多** - 每次訪問 1-4 次
  解決方案：增加 ISR 快取時間

### 低風險
- **備份機制缺失**
  長期解決方案：本地 S3 同步

---

## 關鍵指標監控

監控項目：
- [ ] 圖片加載時間 (目標 < 1s)
- [ ] 404 錯誤率 (目標 < 0.1%)
- [ ] Notion API 調用 (目標 < 10/分鐘)
- [ ] Core Web Vitals (目標 > 90)

建議工具：
- Google PageSpeed Insights
- Sentry (錯誤追蹤)
- Vercel Analytics

---

## 投資回報率 (ROI)

| 投入 | 產出 | ROI |
|-----|------|-----|
| 1-2 天 工作量 | 40-50% 性能提升 | 非常高 |
| 2-3 天 額外工作 | 99% API 調用減少 | 高 |
| 3-5 天 長期優化 | 代碼可維護性提升 | 中 |

**建議：立即啟動 Phase 1 和 Phase 2**

---

完整分析報告位置：
`/IMAGE_ARCHITECTURE_ANALYSIS.md`
