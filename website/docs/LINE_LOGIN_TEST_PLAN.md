# 🧪 LINE Login 測試計劃

**建立日期**: 2025-11-05
**測試範圍**: LINE Login (LIFF) 整合功能

---

## 📋 測試總覽

### 測試層級

| 層級 | 類型 | 工具 | 數量 |
|------|------|------|------|
| 1️⃣ | 單元測試 (Unit Tests) | Jest | ~15 個 |
| 2️⃣ | 整合測試 (Integration Tests) | Jest + Supabase Test | ~8 個 |
| 3️⃣ | E2E 測試 (End-to-End Tests) | Playwright | ~5 個 |
| 4️⃣ | 手動測試 (Manual Tests) | 實際裝置 | ~6 個場景 |

**總計**: 約 34 個測試案例

---

## 1️⃣ 單元測試 (Unit Tests)

### 1.1 前端組件測試

#### `/app/line-login/page.jsx`

```javascript
describe('LineLoginPage', () => {
  test('應該顯示初始化狀態', () => {
    // 驗證載入畫面顯示
  });

  test('開發模式應該跳過 LIFF 初始化', () => {
    // process.env.NEXT_PUBLIC_DEV_MODE = 'true'
    // 驗證直接導向 /products
  });

  test('LIFF 初始化失敗應該顯示錯誤訊息', () => {
    // Mock liff.init() 拋出錯誤
    // 驗證錯誤訊息顯示
  });

  test('未登入應該導向 LINE 登入頁', () => {
    // Mock liff.isLoggedIn() = false
    // 驗證 liff.login() 被呼叫
  });

  test('已登入應該取得 Profile 並呼叫 API', async () => {
    // Mock liff.isLoggedIn() = true
    // Mock liff.getProfile()
    // 驗證 fetch('/api/line/login') 被呼叫
  });

  test('登入成功應該導向 /products', async () => {
    // Mock 整個登入流程
    // 驗證最後導向 /products
  });

  test('登入失敗應該顯示錯誤和重試按鈕', async () => {
    // Mock API 返回錯誤
    // 驗證錯誤訊息和重試按鈕
  });
});
```

#### `lib/hooks/useApi.js`

```javascript
describe('useApi Hook', () => {
  test('開發模式應該返回 mock 資料', async () => {
    // NEXT_PUBLIC_DEV_MODE = 'true'
    // 呼叫 callApi()
    // 驗證返回 mock 資料
  });

  test('正式模式應該附加 Authorization header', async () => {
    // Mock liff.getAccessToken()
    // 呼叫 callApi()
    // 驗證 fetch 帶有 Authorization header
  });

  test('應該正確處理 loading 狀態', async () => {
    // 呼叫 callApi()
    // 驗證 loading = true → false
  });

  test('應該正確處理錯誤', async () => {
    // Mock fetch 拋出錯誤
    // 驗證 error 狀態被設定
  });
});
```

#### `lib/analytics.js`

```javascript
describe('Analytics', () => {
  test('trackEvent 應該使用 sendBeacon 發送資料', () => {
    // Mock navigator.sendBeacon
    // 呼叫 trackEvent()
    // 驗證 sendBeacon 被呼叫且資料正確
  });

  test('應該正確偵測裝置類型', () => {
    // 測試 getDeviceType() 在不同 userAgent 下的回傳值
  });

  test('應該正確偵測瀏覽器', () => {
    // 測試 getBrowser() 在不同 userAgent 下的回傳值
  });

  test('analytics.course.view 應該正確追蹤', () => {
    // 呼叫 analytics.course.view()
    // 驗證 trackEvent 參數正確
  });
});
```

---

### 1.2 後端 API 測試

#### `/api/line/verify-token/route.js`

```javascript
describe('POST /api/line/verify-token', () => {
  test('應該拒絕缺少 accessToken 的請求', async () => {
    const response = await POST({ json: async () => ({}) });
    expect(response.status).toBe(400);
  });

  test('應該驗證有效的 LINE Access Token', async () => {
    // Mock fetch 到 LINE API
    // 返回有效的 token 資訊
    const response = await POST({
      json: async () => ({ accessToken: 'valid_token' })
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.valid).toBe(true);
  });

  test('應該拒絕無效的 Access Token', async () => {
    // Mock LINE API 返回 401
    const response = await POST({
      json: async () => ({ accessToken: 'invalid_token' })
    });
    expect(response.status).toBe(401);
  });

  test('應該拒絕不屬於此 Channel 的 Token', async () => {
    // Mock LINE API 返回不同的 client_id
    const response = await POST({
      json: async () => ({ accessToken: 'wrong_channel_token' })
    });
    expect(response.status).toBe(401);
  });
});
```

#### `/api/line/login/route.js`

```javascript
describe('POST /api/line/login', () => {
  beforeEach(() => {
    // 清空測試資料庫
  });

  test('應該拒絕缺少必要欄位的請求', async () => {
    const response = await POST({
      json: async () => ({ lineUserId: 'U123' })
    });
    expect(response.status).toBe(400);
  });

  test('應該拒絕無效的 Access Token', async () => {
    // Mock verify-token API 返回 401
    const response = await POST({
      json: async () => ({
        lineUserId: 'U123',
        accessToken: 'invalid',
        displayName: 'Test',
      })
    });
    expect(response.status).toBe(401);
  });

  test('新用戶應該建立 auth.users 和 profiles', async () => {
    // Mock verify-token API 成功
    const response = await POST({
      json: async () => ({
        lineUserId: 'U_NEW_USER',
        accessToken: 'valid_token',
        displayName: 'New User',
        pictureUrl: 'https://example.com/pic.jpg',
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isNewUser).toBe(true);
    expect(data.userId).toBeDefined();

    // 驗證 profiles 資料正確
    const profile = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', 'U_NEW_USER')
      .single();

    expect(profile.data.line_display_name).toBe('New User');
    expect(profile.data.auth_provider).toBe('line');
  });

  test('現有用戶應該直接登入', async () => {
    // 先建立測試用戶
    await createTestLineUser('U_EXISTING');

    const response = await POST({
      json: async () => ({
        lineUserId: 'U_EXISTING',
        accessToken: 'valid_token',
        displayName: 'Existing User',
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.isNewUser).toBe(false);
  });

  test('應該更新現有用戶的 displayName 和 pictureUrl', async () => {
    // 建立測試用戶
    await createTestLineUser('U_UPDATE', 'Old Name', 'old_pic.jpg');

    await POST({
      json: async () => ({
        lineUserId: 'U_UPDATE',
        accessToken: 'valid_token',
        displayName: 'New Name',
        pictureUrl: 'new_pic.jpg',
      })
    });

    const profile = await supabase
      .from('profiles')
      .select('*')
      .eq('line_user_id', 'U_UPDATE')
      .single();

    expect(profile.data.line_display_name).toBe('New Name');
    expect(profile.data.line_picture_url).toBe('new_pic.jpg');
  });

  test('如果 profile 建立失敗，應該回滾 auth.users', async () => {
    // Mock profiles.insert() 失敗
    // 驗證 auth.users 也被刪除
  });
});
```

---

## 2️⃣ 整合測試 (Integration Tests)

### 2.1 完整登入流程測試

```javascript
describe('LINE Login 完整流程', () => {
  test('新用戶註冊 → 建立 profile → 登入成功', async () => {
    // 1. 呼叫 /api/line/login (新用戶)
    // 2. 驗證 auth.users 建立
    // 3. 驗證 profiles 建立
    // 4. 驗證所有欄位正確
  });

  test('現有用戶登入 → 更新資料 → 返回 session', async () => {
    // 1. 建立測試用戶
    // 2. 呼叫 /api/line/login
    // 3. 驗證資料被更新
    // 4. 驗證 session 有效
  });
});
```

### 2.2 資料庫 Trigger 測試

```javascript
describe('Database Trigger', () => {
  test('建立 auth.users 應該自動建立 profiles', async () => {
    // 直接插入 auth.users（模擬 Supabase Auth）
    // 驗證 profiles 自動建立
  });

  test('LINE 用戶應該正確填入 LINE 欄位', async () => {
    // 插入帶有 LINE metadata 的 auth.users
    // 驗證 profiles 的 line_* 欄位被填入
  });

  test('Email 用戶應該正確填入 Email 欄位', async () => {
    // 插入帶有 Email metadata 的 auth.users
    // 驗證 profiles 的 full_name, phone_number 欄位被填入
  });
});
```

### 2.3 RLS (Row Level Security) 測試

```javascript
describe('RLS Policies', () => {
  test('用戶只能讀取自己的 profile', async () => {
    // 建立兩個測試用戶
    // 用戶 A 嘗試讀取用戶 B 的 profile
    // 驗證返回空結果
  });

  test('用戶只能更新自己的 profile', async () => {
    // 建立兩個測試用戶
    // 用戶 A 嘗試更新用戶 B 的 profile
    // 驗證失敗
  });

  test('LINE 用戶應該能正常存取 profiles', async () => {
    // 建立 LINE 用戶
    // 驗證可以讀取和更新自己的 profile
  });
});
```

---

## 3️⃣ E2E 測試 (End-to-End Tests)

使用 Playwright 模擬真實用戶操作

### 3.1 LINE Login 流程

```javascript
test('完整 LINE Login 流程 (開發模式)', async ({ page }) => {
  // 1. 前往 /line-login?dev=true
  await page.goto('http://localhost:3007/line-login?dev=true');

  // 2. 驗證顯示 "初始化中..."
  await expect(page.locator('text=初始化中')).toBeVisible();

  // 3. 驗證自動導向 /products
  await page.waitForURL('**/products');

  // 4. 驗證用戶已登入（檢查 UI）
  await expect(page.locator('text=我的課程')).toBeVisible();
});
```

### 3.2 錯誤處理

```javascript
test('無效 Token 應該顯示錯誤', async ({ page }) => {
  // Mock API 返回錯誤
  await page.route('**/api/line/login', (route) =>
    route.fulfill({
      status: 401,
      body: JSON.stringify({ error: 'Invalid token' }),
    })
  );

  await page.goto('http://localhost:3007/line-login');

  // 驗證錯誤訊息顯示
  await expect(page.locator('text=登入失敗')).toBeVisible();
  await expect(page.locator('text=Invalid token')).toBeVisible();
});
```

### 3.3 用戶流程

```javascript
test('新用戶註冊 → 瀏覽課程 → 報名', async ({ page }) => {
  // 1. LINE Login
  // 2. 導向課程列表
  // 3. 點擊課程
  // 4. 報名
  // 5. 驗證訂單建立
});

test('現有用戶登入 → 查看我的課程', async ({ page }) => {
  // 1. 先建立測試用戶和訂單
  // 2. LINE Login
  // 3. 前往我的課程
  // 4. 驗證訂單顯示
});
```

---

## 4️⃣ 手動測試 (Manual Tests)

### 4.1 LINE App 內測試

| # | 測試項目 | 步驟 | 預期結果 |
|---|----------|------|----------|
| M1 | LIFF 開啟 | 在 LINE App 中開啟 LIFF URL | 正常載入頁面 |
| M2 | 首次登入 | 新用戶第一次開啟 LIFF | 建立帳號並登入 |
| M3 | 再次登入 | 已存在用戶開啟 LIFF | 直接登入，不重複建立帳號 |
| M4 | Profile 更新 | 修改 LINE 顯示名稱後登入 | 名稱同步更新到 profiles |
| M5 | 課程報名 | 登入後報名課程 | 訂單正確建立 |
| M6 | 查看訂單 | 查看我的課程頁面 | 顯示已報名的課程 |

### 4.2 外部瀏覽器測試

| # | 測試項目 | 步驟 | 預期結果 |
|---|----------|------|----------|
| M7 | 外部瀏覽器開啟 | 在 Chrome/Safari 開啟 LIFF URL | 導向 LINE 授權頁 |
| M8 | 授權後登入 | 完成授權後 | 返回網站並登入成功 |

---

## 🛠️ 測試工具設定

### Jest 設定 (`jest.config.js`)

```javascript
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@line/liff$': '<rootDir>/__mocks__/@line/liff.js',
  },
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/?(*.)+(spec|test).js',
  ],
};
```

### Mock LIFF SDK (`__mocks__/@line/liff.js`)

```javascript
export default {
  init: jest.fn(() => Promise.resolve()),
  isLoggedIn: jest.fn(() => true),
  login: jest.fn(),
  getProfile: jest.fn(() => Promise.resolve({
    userId: 'U_TEST_USER',
    displayName: 'Test User',
    pictureUrl: 'https://example.com/pic.jpg',
  })),
  getAccessToken: jest.fn(() => 'mock_access_token'),
  getIDToken: jest.fn(() => 'mock_id_token'),
};
```

### Playwright 設定 (`playwright.config.js`)

```javascript
export default {
  testDir: './e2e',
  use: {
    baseURL: 'http://localhost:3007',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    port: 3007,
    reuseExistingServer: true,
  },
};
```

---

## 📊 測試覆蓋率目標

| 項目 | 目標覆蓋率 |
|------|-----------|
| 前端組件 | > 80% |
| API Routes | > 90% |
| Hooks/Utils | > 85% |
| 整體 | > 80% |

---

## 🔄 CI/CD 整合

### GitHub Actions Workflow

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run test:unit
      - run: npm run test:integration
      - run: npx playwright install
      - run: npm run test:e2e
```

---

## ✅ 測試執行指令

```bash
# 所有測試
npm test

# 單元測試
npm run test:unit

# 整合測試
npm run test:integration

# E2E 測試
npm run test:e2e

# 測試覆蓋率
npm run test:coverage

# Watch mode（開發時）
npm run test:watch
```

---

## 📝 測試撰寫順序

1. ✅ **單元測試** - API Routes（最關鍵）
2. ✅ **整合測試** - 完整登入流程
3. ✅ **單元測試** - 前端組件
4. ✅ **E2E 測試** - 關鍵用戶流程
5. ✅ **手動測試** - LINE App 實際驗證

---

**下一步**: 開始撰寫測試檔案？
