-- ============================================
-- 資料庫 Migration - 2025-11-02
-- 目的: 支援轉帳資訊記錄與 Email 通知系統
-- ============================================

-- 新增轉帳帳號後五碼欄位
-- 用途: 學員填寫轉帳帳號後五碼，方便後台核對
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS transfer_account_last5 VARCHAR(5);

COMMENT ON COLUMN orders.transfer_account_last5 IS '學員轉帳帳號後五碼（選填）';

-- 新增轉帳時間欄位
-- 用途: 學員填寫轉帳時間，協助後台查找款項
ALTER TABLE orders
ADD COLUMN IF NOT EXISTS transfer_time TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN orders.transfer_time IS '學員填寫的轉帳時間（選填）';

-- ============================================
-- 驗證欄位是否新增成功
-- ============================================

-- 查詢 orders 資料表結構
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'orders'
  AND column_name IN ('transfer_account_last5', 'transfer_time')
ORDER BY ordinal_position;

-- ============================================
-- 測試資料（可選）
-- ============================================

-- 查看現有訂單（確認不會影響既有資料）
SELECT
  order_id,
  state,
  created_at,
  transfer_account_last5,
  transfer_time
FROM orders
ORDER BY created_at DESC
LIMIT 10;

-- ============================================
-- Rollback（如需還原）
-- ============================================

-- 如果需要移除這些欄位，執行以下 SQL:
-- ALTER TABLE orders DROP COLUMN IF EXISTS transfer_account_last5;
-- ALTER TABLE orders DROP COLUMN IF EXISTS transfer_time;
