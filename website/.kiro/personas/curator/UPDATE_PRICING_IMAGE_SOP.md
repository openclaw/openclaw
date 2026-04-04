# 更新定價圖 SOP（SVG 內嵌版）

## 概述

使用 SVG 內嵌渲染取代 PNG 圖片上傳，徹底解決圖片尺寸、裁切、適配問題。

## 為什麼用 SVG？

- ✅ 完美適應 16:9 容器（aspect-video）
- ✅ 無損縮放，任何解析度都清晰
- ✅ 不受 qlmanage 限制（不會被強制轉成正方形）
- ✅ 改價格只需改代碼中的數字
- ✅ 不用上傳檔案到 Notion

## 前置條件

`HighlightCard.js` 已支援 SVG 內嵌渲染：
```javascript
const isSVG = image && image.trim().startsWith('<svg');
// 使用 dangerouslySetInnerHTML 渲染 SVG
```

## 完整流程

### 步驟 1：更新 Notion 價格欄位

```bash
cat > /tmp/update-pricing.ts << 'EOF'
import { readFile } from 'fs/promises';
import { join } from 'path';

async function loadEnv() {
  const envContent = await readFile(join(process.cwd(), '.env'), 'utf-8');
  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      process.env[key.trim()] = values.join('=').trim();
    }
  });
}

async function updatePricing() {
  await loadEnv();

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const PAGE_ID = "課程的 notion_page_id";

  const response = await fetch(`https://api.notion.com/v1/pages/${PAGE_ID}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        "single_price_early": { number: 新的一對一價格 },
        "group_price_early": { number: 新的小班制價格 }
      }
    }),
  });

  if (!response.ok) {
    console.error(`❌ 更新失敗: ${await response.text()}`);
    process.exit(1);
  }

  console.log("✅ Notion 價格已更新");
}

updatePricing();
EOF

pnpm tsx /tmp/update-pricing.ts
```

### 步驟 2：更新 SVG 定價圖

直接在 `HighlightCard.js` 修改 SVG 內容：

**標準模板**（極限填滿版 1600x900）：

```javascript
const testSVG = index === 0 ? `<svg viewBox="0 0 1600 900" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
  <rect width="1600" height="900" fill="#f8f9fa"/>
  <rect x="20" y="20" width="1560" height="200" fill="#FF6B6B" rx="20"/>
  <text x="800" y="150" font-family="Arial, sans-serif" font-size="130" font-weight="bold" fill="white" text-anchor="middle">早鳥優惠</text>

  <!-- 左側卡片 - 小團班 -->
  <rect x="30" y="250" width="760" height="630" fill="white" stroke="#dee2e6" stroke-width="4" rx="24"/>
  <text x="410" y="380" font-family="Arial, sans-serif" font-size="85" font-weight="bold" fill="#495057" text-anchor="middle">小團班</text>
  <text x="410" y="590" font-family="Arial, sans-serif" font-size="200" font-weight="bold" fill="#FF6B6B" text-anchor="middle">590</text>
  <text x="410" y="670" font-family="Arial, sans-serif" font-size="60" fill="#FF6B6B" text-anchor="middle">TWD</text>
  <rect x="210" y="760" width="400" height="95" fill="#28a745" rx="12"/>
  <text x="410" y="820" font-family="Arial, sans-serif" font-size="54" font-weight="bold" fill="white" text-anchor="middle">省 890 元</text>

  <!-- 右側卡片 - 一對一 -->
  <rect x="810" y="250" width="760" height="630" fill="white" stroke="#dee2e6" stroke-width="4" rx="24"/>
  <text x="1190" y="380" font-family="Arial, sans-serif" font-size="85" font-weight="bold" fill="#495057" text-anchor="middle">一對一</text>
  <text x="1190" y="590" font-family="Arial, sans-serif" font-size="200" font-weight="bold" fill="#FF6B6B" text-anchor="middle">990</text>
  <text x="1190" y="670" font-family="Arial, sans-serif" font-size="60" fill="#FF6B6B" text-anchor="middle">TWD</text>
  <rect x="970" y="760" width="440" height="95" fill="#28a745" rx="12"/>
  <text x="1190" y="820" font-family="Arial, sans-serif" font-size="54" font-weight="bold" fill="white" text-anchor="middle">省 1,510 元</text>
</svg>` : null;
```

**需要修改的部分**：
1. 價格數字（兩處）
2. 節省金額（兩處）
3. `index === 0` 改成對應的課程 index

### 步驟 3：本機測試

```bash
pnpm dev
# 開啟 http://localhost:3000/products/[課程ID]
```

檢查：
- ✅ 價格正確
- ✅ 節省金額正確
- ✅ 填滿容器無裁切
- ✅ 字體大小清晰

### 步驟 4：上線

```bash
git add .
git commit -m "update: 課程X定價圖更新為 小班制Y元/一對一Z元"
git push

# Vercel 自動部署，等 60 秒 revalidate
```

## 設計規範

### 尺寸比例
- **viewBox**: `0 0 1600 900` (16:9 標準比例)
- **邊距**: 上下左右 20-30px（極限填滿）

### 顏色
- 背景：`#f8f9fa`（淺灰）
- 標題背景：`#FF6B6B`（紅）
- 卡片背景：`white`
- 卡片邊框：`#dee2e6`
- 價格文字：`#FF6B6B`（紅）
- 標題文字：`#495057`（深灰）
- 節省標籤：`#28a745`（綠）

### 字體大小（極限填滿版）
- 標題：130px
- 方案名稱：85px
- 價格數字：200px（超大！）
- TWD：60px
- 節省金額：54px

### 元素尺寸
- 標題高度：200px
- 卡片寬度：760px（各佔一半）
- 卡片高度：630px（幾乎填滿）
- 節省標籤高度：95px

## 計算節省金額

假設原價：
- 小班制原價：1480 元
- 一對一原價：2500 元

節省金額 = 原價 - 早鳥價

範例：
- 小班制 590 → 省 890 元 (1480 - 590)
- 一對一 990 → 省 1,510 元 (2500 - 990)

## 常見問題

### Q: 為什麼不用 PNG？
A: PNG 會被 qlmanage 強制轉成正方形，在 16:9 容器中會被 object-cover 裁切。

### Q: 可以調整字體大小嗎？
A: 可以！直接改 font-size 數值，SVG 會自動適應。

### Q: 如何應用到其他課程？
A: 複製 SVG 模板，修改價格數字和 index，完全可複製。

### Q: 未來能從 Notion 讀取 SVG 嗎？
A: 可以！把 SVG 存到 `content_highlight1` (rich_text) 欄位，前端自動讀取渲染。

## 版本紀錄

- **v1.0** (2025-11-02): 建立 SVG 內嵌渲染方案，取代 PNG 上傳
- 解決問題：圖片裁切、尺寸適配、qlmanage 限制
- 課程 5 首次應用成功
