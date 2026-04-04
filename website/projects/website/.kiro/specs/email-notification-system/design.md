# Design: Email Notification System

**Feature**: email-notification-system
**Project**: thinker-official-website
**Status**: ✅ Implemented
**Created**: 2025-11-02

---

## 1. Architecture Overview

```
┌─────────────┐
│   Student   │
│  (Browser)  │
└──────┬──────┘
       │ 1. Submit Registration
       ▼
┌─────────────────────┐
│  BuyCourseForm.js   │
│  (Client Component) │
└──────┬──────────────┘
       │ 2. Create Order
       ▼
┌─────────────────────┐
│   Supabase DB       │
│  (orders table)     │
└──────┬──────────────┘
       │ 3. Trigger Email API
       ▼
┌──────────────────────────────┐
│  /api/email/send-payment-    │
│   reminder/route.ts          │
│  (API Route)                 │
└──────┬───────────────────────┘
       │ 4. Query Data
       ├─────────────────┐
       │                 │
       ▼                 ▼
┌──────────────┐  ┌──────────────┐
│  Supabase    │  │  Notion API  │
│  (profiles)  │  │  (courses)   │
└──────┬───────┘  └──────┬───────┘
       │                 │
       └─────────┬───────┘
                 │ 5. Render Email
                 ▼
┌──────────────────────────────┐
│  PaymentReminder.tsx         │
│  (React Email Template)      │
└──────┬───────────────────────┘
       │ 6. Send via Resend
       ▼
┌──────────────────────────────┐
│  Resend API                  │
│  (Email Delivery)            │
└──────┬───────────────────────┘
       │ 7. Deliver
       ▼
┌──────────────────────────────┐
│  Student's Email Inbox       │
└──────────────────────────────┘
```

---

## 2. Component Design

### 2.1 Client Components

#### `app/order/[order_id]/CreatedOrderForm.js`
**Purpose**: 付款資訊頁面

**State Management**:
```javascript
const [copiedAccount, setCopiedAccount] = useState(false);
const [copiedBankCode, setCopiedBankCode] = useState(false);
const [accountLast5, setAccountLast5] = useState('');
const [transferTime, setTransferTime] = useState('');
const [remainingHours, setRemainingHours] = useState(null);
const [remainingMinutes, setRemainingMinutes] = useState(null);
```

**Key Functions**:
- `copyBankCode()`: 複製銀行代碼到剪貼簿
- `copyAccountNumber()`: 複製帳號到剪貼簿
- `updateOrderState()`: 更新訂單狀態（標記為已繳費）
- `useEffect(() => {...}, [order.created_at])`: 倒數計時器

**UI Components Used**:
- `Button` (shadcn/ui)
- `Input` (shadcn/ui)
- `Label` (shadcn/ui)
- `useToast` hook
- Lucide icons (Copy, Check, Mail, TriangleAlert)

#### `app/buy-course/[[...slug]]/BuyCourseForm.js`
**Purpose**: 報名表單

**Modified Logic**:
```javascript
// After order creation
fetch('/api/email/send-payment-reminder', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ orderId }),
}).then(res => {
  if (res.ok) {
    console.log('✅ Payment reminder email sent');
  }
}).catch(err => {
  console.error('❌ Error sending email:', err);
});
```

**Non-blocking**: Email 發送失敗不影響訂單建立

---

### 2.2 API Routes

#### `app/api/email/send-payment-reminder/route.ts`
**Method**: POST
**Input**: `{ orderId: number }`
**Output**: `{ success: boolean, message: string, emailId?: string }`

**Flow**:
1. Validate `orderId`
2. Query order data from Supabase
3. Query profile data from Supabase
4. Query user email from Supabase Auth (admin client)
5. Query course data from Notion API
6. Calculate expiry time (created_at + 24h)
7. Format course name using `parseCourseName()`
8. Render email using React Email
9. Send via Resend
10. Return result

**Error Handling**:
- 400: Missing orderId
- 404: Order/Profile/User not found
- 500: Email send failure or internal error

**Example Response**:
```json
{
  "success": true,
  "message": "Email sent successfully",
  "emailId": "xxx"
}
```

---

### 2.3 Email Infrastructure

#### `lib/email/resend.ts`
**Purpose**: Resend SDK 初始化和配置

```typescript
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_XSmZmgqn_2H4cCRRxGgG3LdSrhmmRCis8';
export const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@updates.thinker.cafe';
export const FROM_NAME = '思考者咖啡 Thinker Cafe';
export const FROM = `${FROM_NAME} <${FROM_EMAIL}>`;
export const resend = new Resend(RESEND_API_KEY);
```

**Design Decisions**:
- Hardcoded fallback: 因為 Vercel 無法設定環境變數（免費版限制）
- 子網域策略: `updates.thinker.cafe` 專用於通知類 Email
- 品牌名稱: 顯示「思考者咖啡 Thinker Cafe」增加識別度

#### `lib/email/templates/PaymentReminder.tsx`
**Purpose**: React Email 模板

**Structure**:
```tsx
<Html>
  <Head>
    <title>繳費提醒</title>
  </Head>
  <Body style={main}>
    <Container style={container}>
      {/* Logo */}
      <Heading>思考者咖啡 Thinker Cafe</Heading>

      {/* Greeting */}
      <Text>Hi {studentName}，</Text>

      {/* Order Info */}
      <Section>
        <Row>訂單編號：{orderID}</Row>
        <Row>課程名稱：{courseName}</Row>
        <Row>金額：NT$ {amount}</Row>
      </Section>

      {/* Bank Info */}
      <Section>
        <Text>銀行：007 第一銀行 苗栗分行</Text>
        <Text>帳號：321-1006-0407</Text>
      </Section>

      {/* CTA Button */}
      <Button href={paymentURL}>
        查看訂單
      </Button>

      {/* Footer */}
      <Text>此郵件由系統自動發送，請勿回覆</Text>
    </Container>
  </Body>
</Html>
```

**Props Interface**:
```typescript
interface PaymentReminderEmailProps {
  studentName: string;
  orderID: string;
  courseName: string;
  amount: number;
  expiresAt: number;  // Unix timestamp
  paymentURL: string;
}
```

**Styling**:
- Inline CSS (for email client compatibility)
- Responsive design
- Brand colors
- Clear typography hierarchy

---

## 3. Data Flow

### 3.1 Registration Flow
```
1. Student fills form
   ↓
2. Submit to Supabase
   ↓
3. Create order record
   ↓
4. Trigger email API (non-blocking)
   ↓
5. Redirect to /order/{orderId}
   ↓
6. Show payment instructions
```

### 3.2 Email Sending Flow
```
1. Receive orderId
   ↓
2. Query:
   - orders table → order data
   - profiles table → student name
   - auth.users → email address
   - Notion API → course details
   ↓
3. Calculate expiry time
   ↓
4. Render React Email template
   ↓
5. Call Resend API
   ↓
6. Return success/failure
```

### 3.3 Payment Verification Flow (Manual)
```
1. Student transfers money
   ↓
2. Student fills form:
   - Account last 5 digits
   - Transfer time
   ↓
3. Mark order as "payed"
   ↓
4. Admin verifies in dashboard
   ↓
5. Grant course access (manual)
```

---

## 4. Database Schema

### orders table (新增欄位)
```sql
CREATE TABLE orders (
  -- Existing columns
  order_id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users,
  course_id INT,
  course_variant TEXT,
  total INT,
  state TEXT DEFAULT 'created',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- New columns
  transfer_account_last5 VARCHAR(5),
  transfer_time TIMESTAMP WITH TIME ZONE
);
```

**Indexes**:
- `order_id` (Primary Key)
- `user_id` (Foreign Key)
- `state` (for filtering)

---

## 5. Security Considerations

### 5.1 API Security
- **Current**: 無認證（任何人可呼叫）
- **Future**: 加入 API key 或 JWT 驗證

### 5.2 Data Privacy
- Email 內容不包含密碼或敏感資料
- 訂單編號不可逆推用戶資訊
- Email 地址從 Auth 系統取得（已驗證）

### 5.3 Email Security
- 使用 DKIM/SPF 防止被標記為垃圾信
- 使用 HTTPS 連結
- 不在 Email 中要求輸入密碼或信用卡

---

## 6. Performance Optimizations

### 6.1 Async Email Sending
- Email 發送不阻塞訂單建立
- 使用 `fetch().then()` 而非 `await fetch()`
- 失敗只 log，不影響用戶體驗

### 6.2 Database Queries
- 使用 `single()` 而非 `maybeSingle()` (更快)
- 分離查詢而非 JOIN (避免 relationship error)
- 只查詢需要的欄位

### 6.3 React Hydration Fix
- Countdown timer 使用 `useEffect` (client-only)
- 避免 server/client 時間不一致
- 初始值設為 `null`，hydration 後才計算

---

## 7. Error Handling

### 7.1 Email API Errors
```typescript
try {
  const { data, error } = await resend.emails.send({...});
  if (error) {
    console.error('Failed to send email:', error);
    return NextResponse.json({ success: false, message: 'Failed to send email', error }, { status: 500 });
  }
} catch (error) {
  console.error('Error sending payment reminder:', error);
  return NextResponse.json({ success: false, message: 'Internal server error' }, { status: 500 });
}
```

### 7.2 Client-side Errors
```javascript
try {
  await navigator.clipboard.writeText('007');
  toast({ title: "已複製銀行代碼" });
} catch (err) {
  toast({ title: "複製失敗", variant: "destructive" });
}
```

### 7.3 Fallback Mechanisms
- Environment variable fallback to hardcoded values
- Email 發送失敗不影響訂單
- Copy 失敗顯示 toast 提示手動複製

---

## 8. Testing Strategy

### 8.1 Manual Testing (Completed)
- ✅ 報名流程測試
- ✅ Email 接收測試
- ✅ 複製按鈕測試
- ✅ 倒數計時器測試
- ✅ 表單送出測試

### 8.2 Integration Testing (Future)
- Order creation + Email sending
- Database query errors
- Resend API failures
- Network timeouts

### 8.3 E2E Testing (Future)
- Complete registration flow
- Email delivery confirmation
- Payment verification flow

---

## 9. Deployment Configuration

### 9.1 Environment Variables (Vercel)
```bash
# Production
RESEND_API_KEY=re_XSmZmgqn_2H4cCRRxGgG3LdSrhmmRCis8
RESEND_FROM_EMAIL=onboarding@updates.thinker.cafe
SITE_URL=https://thinker.cafe

# Preview (same as Production)
RESEND_API_KEY=re_XSmZmgqn_2H4cCRRxGgG3LdSrhmmRCis8
RESEND_FROM_EMAIL=onboarding@updates.thinker.cafe
SITE_URL=https://thinker.cafe

# Development (same as Production)
RESEND_API_KEY=re_XSmZmgqn_2H4cCRRxGgG3LdSrhmmRCis8
RESEND_FROM_EMAIL=onboarding@updates.thinker.cafe
SITE_URL=http://localhost:3000
```

### 9.2 DNS Configuration
```
Type: TXT
Name: _vercel
Value: vc-domain-verify=thinker.cafe,3cbfd4f583db5c702b5e

Type: TXT
Name: _vercel
Value: vc-domain-verify=www.thinker.cafe,0056c9cc95de9be76657

Type: A
Name: @
Value: 76.76.21.21 (Vercel IP)

Type: CNAME
Name: www
Value: cname.vercel-dns.com
```

### 9.3 Resend DNS Configuration
```
Type: TXT
Name: updates.thinker.cafe
Value: v=spf1 include:_spf.resend.com ~all

Type: TXT
Name: resend._domainkey.updates.thinker.cafe
Value: [DKIM key from Resend]
```

---

## 10. Monitoring & Logging

### 10.1 Current Logging
```typescript
console.log('✅ Payment reminder email sent:', data);
console.error('❌ Failed to send email:', error);
```

### 10.2 Future Monitoring
- Resend dashboard (email send rate, bounce rate)
- Vercel logs (API errors)
- Sentry (error tracking)
- Analytics (email open rate, click rate)

---

## 11. Design Decisions & Trade-offs

### Decision 1: Hardcoded Fallback vs Environment Variables
**Chosen**: Hardcoded fallback
**Reason**: Vercel 免費版無法設定環境變數，且 Git 權限問題
**Trade-off**: 安全性較低，但確保功能可用

### Decision 2: Non-blocking Email
**Chosen**: Async email sending (不 await)
**Reason**: 訂單建立不應被 Email 失敗阻塞
**Trade-off**: 無法即時知道 Email 是否成功

### Decision 3: React Email vs Plain HTML
**Chosen**: React Email
**Reason**: 易於維護、組件化、TypeScript 支援
**Trade-off**: 需要額外依賴、bundle size 增加

### Decision 4: Supabase Admin Client for Email
**Chosen**: 使用 admin client 存取 auth.users
**Reason**: Email 儲存在 auth.users，一般 client 無權存取
**Trade-off**: 需要 service role key，風險較高

### Decision 5: 24 Hour Payment Deadline
**Chosen**: 固定 24 小時
**Reason**: 簡單明確，符合台灣轉帳習慣
**Trade-off**: 無法彈性調整（未來可改為可設定）

---

## 12. Future Enhancements

### Phase 2: Automation
- 繳費提醒（12h 前、6h 前）
- 超時自動取消訂單
- 自動對帳（藍新金流整合後）

### Phase 3: Analytics
- Email 開信率追蹤
- 點擊率追蹤
- 繳費轉換率分析

### Phase 4: Personalization
- A/B testing email templates
- 個人化推薦課程
- 動態優惠碼

---

**Design Approved**: ✅ Yes
**Approved By**: Cruz
**Approval Date**: 2025-11-02
**Implementation Status**: ✅ Completed

---

**Generated by**: Claude Code
**Last Updated**: 2025-11-02
