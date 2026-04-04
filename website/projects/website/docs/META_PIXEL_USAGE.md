# Meta Pixel 使用指南

## 📊 概述

ThinkerCafe 網站已整合 **Meta Pixel 雙層追蹤系統**：
- **前端 Pixel**：瀏覽器端即時追蹤
- **Conversion API**：伺服器端強化追蹤（更準確、防 Ad Blocker）

---

## 🚀 快速開始

### 1. 環境變數設定

在 `.env.local` 或 Vercel 環境變數中設定：

```bash
# 前端 Pixel (公開可見)
NEXT_PUBLIC_META_PIXEL_ID=你的像素ID

# 後端 Conversion API (僅伺服器端)
META_PIXEL_ID=你的像素ID
META_CONVERSION_API_TOKEN=EAATQURqF9LMBP4f2gUE3ekALZ...
```

---

## 📝 使用範例

### 範例 1：追蹤課程頁面瀏覽

```typescript
'use client';

import { useEffect } from 'react';
import { metaEvent } from '@/lib/meta-events';

export default function CoursePage({ courseId, courseName }: Props) {
  useEffect(() => {
    // 追蹤查看課程內容
    metaEvent.viewContent(
      courseName,              // 內容名稱
      'course',                // 內容類別
      [courseId.toString()]    // 內容 ID
    );
  }, [courseId, courseName]);

  return <div>...</div>;
}
```

---

### 範例 2：追蹤開始結帳（進入報名頁）

```typescript
'use client';

import { useMetaTracking } from '@/hooks/useMetaTracking';

export default function BuyCourseButton({ course, userData }: Props) {
  const { trackInitiateCheckout } = useMetaTracking();

  const handleClick = async () => {
    // 雙層追蹤：前端 + 後端
    await trackInitiateCheckout(
      course.price,                    // 金額
      'TWD',                           // 幣別（台幣）
      [{ id: course.id, quantity: 1 }], // 商品內容
      {
        email: userData.email,          // 用戶資料（會自動加密）
        phone: userData.phone,
      }
    );

    // 導向報名頁
    router.push(`/buy-course/${course.id}`);
  };

  return <button onClick={handleClick}>立即報名</button>;
}
```

---

### 範例 3：追蹤購買完成（訂單成功頁）

```typescript
'use client';

import { useEffect } from 'react';
import { useMetaTracking } from '@/hooks/useMetaTracking';

export default function OrderSuccessPage({ order }: Props) {
  const { trackPurchase } = useMetaTracking();

  useEffect(() => {
    // 追蹤購買事件
    trackPurchase(
      order.total_price,               // 訂單金額
      'TWD',                           // 台幣
      [
        {
          id: order.course_id,
          quantity: 1,
          item_price: order.total_price,
        },
      ],
      {
        email: order.user_email,        // 訂單用戶資料
        phone: order.user_phone,
        firstName: order.user_first_name,
        lastName: order.user_last_name,
      }
    );
  }, [order]);

  return <div>感謝您的訂購！</div>;
}
```

---

### 範例 4：追蹤潛在客戶（表單提交）

```typescript
'use client';

import { useMetaTracking } from '@/hooks/useMetaTracking';

export default function ContactForm() {
  const { trackLead } = useMetaTracking();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    // 追蹤表單提交
    await trackLead(
      undefined,  // 沒有特定價值
      'TWD',
      {
        email: formData.get('email') as string,
        phone: formData.get('phone') as string,
      }
    );

    // 提交表單...
  };

  return <form onSubmit={handleSubmit}>...</form>;
}
```

---

## 🔧 API 參考

### `metaEvent` (前端 Pixel)

```typescript
import { metaEvent } from '@/lib/meta-events';

// 查看內容
metaEvent.viewContent(contentName, contentCategory, contentIds);

// 加入購物車
metaEvent.addToCart(value, currency, contentName, contentId);

// 搜尋
metaEvent.search(searchString);

// 自訂事件
metaEvent.custom('CustomEventName', { key: 'value' });
```

### `useMetaTracking()` Hook (雙層追蹤)

```typescript
const {
  trackViewContent,        // 查看內容（前端）
  trackInitiateCheckout,   // 開始結帳（雙層）
  trackPurchase,           // 購買完成（雙層）
  trackLead,               // 潛在客戶（雙層）
  trackAddToCart,          // 加入購物車（前端）
  trackCustomEvent,        // 自訂事件（雙層）
} = useMetaTracking();
```

---

## 🎯 重要事件對照

| 事件名稱 | 何時觸發 | 追蹤層級 |
|---------|---------|---------|
| `PageView` | 頁面載入 | 前端（自動） |
| `ViewContent` | 查看課程頁面 | 前端 |
| `InitiateCheckout` | 點擊「立即報名」 | **雙層** |
| `Purchase` | 訂單成功頁 | **雙層** |
| `Lead` | 提交聯絡表單 | **雙層** |
| `AddToCart` | 加入購物車 | 前端 |

---

## 🛡️ 安全性注意事項

### ✅ DO（應該做）
- ✅ 用戶資料會自動 SHA-256 加密（email, phone, name）
- ✅ `eventId` 自動生成，防止重複計數
- ✅ 使用 `NEXT_PUBLIC_` 前綴的變數在前端是公開的
- ✅ `META_CONVERSION_API_TOKEN` 只在伺服器端使用

### ❌ DON'T（不應該做）
- ❌ 不要在前端程式碼中暴露 `META_CONVERSION_API_TOKEN`
- ❌ 不要傳送原始的個人資料（系統會自動加密）
- ❌ 不要在同一事件中重複呼叫 `trackEvent`

---

## 📈 監控指標

進入 **Meta 事件管理工具** 查看：

1. **事件配對品質**：用戶資料配對成功率
2. **重複項目刪除比率**：前端+後端自動去重
3. **資料更新間隔**：事件即時性
4. **轉換 API 事件覆蓋率**：雙層追蹤覆蓋率

**目標**：
- 事件配對品質 > 70%
- 重複項目刪除比率 > 90%
- 資料更新間隔 < 5 分鐘

---

## 🧪 測試

### 本地測試

```bash
# 1. 設定環境變數
cp .env.example .env.local
# 填入測試用的 Pixel ID 和 Token

# 2. 啟動開發伺服器
pnpm dev

# 3. 打開 Meta 事件管理工具的「測試事件」
# 4. 在網站上觸發事件
# 5. 檢查事件是否出現在 Meta 後台
```

### Production 測試

使用 Meta Pixel Helper 瀏覽器擴充功能：
- Chrome: https://chrome.google.com/webstore/detail/meta-pixel-helper/...

---

## 🔍 除錯

### 檢查前端 Pixel

```javascript
// 在瀏覽器 Console 執行
if (window.fbq) {
  console.log('✅ Meta Pixel loaded');
} else {
  console.error('❌ Meta Pixel not loaded');
}
```

### 檢查後端 API

```bash
# 查看 Vercel 函數日誌
vercel logs
```

---

## 📚 相關資源

- [Meta Conversion API 文件](https://developers.facebook.com/docs/marketing-api/conversions-api)
- [Meta Pixel 文件](https://developers.facebook.com/docs/meta-pixel)
- [事件參數參考](https://developers.facebook.com/docs/meta-pixel/reference)
- [用戶資料參數](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)

---

**最後更新**：2025-11-08
**維護者**：ThinkerCafe Tech Team
