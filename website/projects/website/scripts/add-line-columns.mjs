const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('='.repeat(70));
console.log('🚀 使用 PostgreSQL Direct Connection 執行 Migration');
console.log('='.repeat(70));

// Extract connection details from Supabase URL
// Format: https://PROJECT_REF.supabase.co
const projectRef = supabaseUrl.replace('https://', '').split('.')[0];
const dbHost = `db.${projectRef}.supabase.co`;
const dbPort = 5432;
const dbName = 'postgres';
const dbUser = 'postgres';

console.log('\n📋 連線資訊：');
console.log(`  Host: ${dbHost}`);
console.log(`  Port: ${dbPort}`);
console.log(`  Database: ${dbName}`);
console.log(`  User: ${dbUser}`);

console.log('\n⚠️  需要資料庫密碼才能直接連線');
console.log('請從 Supabase Dashboard → Settings → Database → Database password 取得');
console.log('\n或者，請直接在 Supabase Dashboard → SQL Editor 執行以下 SQL：\n');

console.log('─'.repeat(70));
console.log(`
-- ========================================
-- 1. 新增 LINE 相關欄位
-- ========================================

ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(255) UNIQUE,
ADD COLUMN IF NOT EXISTS line_display_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS line_picture_url TEXT,
ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'email',
ADD COLUMN IF NOT EXISTS migrated_from_email BOOLEAN DEFAULT false;

-- ========================================
-- 2. 欄位註解
-- ========================================

COMMENT ON COLUMN profiles.line_user_id IS 'LINE User ID (唯一識別)';
COMMENT ON COLUMN profiles.line_display_name IS 'LINE 顯示名稱';
COMMENT ON COLUMN profiles.line_picture_url IS 'LINE 大頭貼 URL';
COMMENT ON COLUMN profiles.auth_provider IS '登入方式: email 或 line';
COMMENT ON COLUMN profiles.migrated_from_email IS '是否從 Email 帳號遷移而來';

-- ========================================
-- 3. 建立索引
-- ========================================

CREATE INDEX IF NOT EXISTS idx_profiles_line_user_id ON profiles(line_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_auth_provider ON profiles(auth_provider);

-- ========================================
-- 4. 更新現有用戶的 auth_provider
-- ========================================

UPDATE profiles
SET auth_provider = 'email'
WHERE auth_provider IS NULL;

-- ========================================
-- 5. 驗證結果
-- ========================================

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'profiles'
AND column_name IN ('line_user_id', 'line_display_name', 'line_picture_url', 'auth_provider', 'migrated_from_email')
ORDER BY ordinal_position;
`);
console.log('─'.repeat(70));

console.log('\n📝 執行步驟：');
console.log('1. 前往 https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
console.log('2. 複製上方 SQL 並貼上');
console.log('3. 點擊 "Run" 執行');
console.log('4. 確認看到 5 個新欄位（line_user_id, line_display_name, line_picture_url, auth_provider, migrated_from_email）');
console.log('\n執行完成後，請回到這裡繼續。');
