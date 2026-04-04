import { NextResponse } from 'next/server';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

/**
 * LINE Login API
 *
 * 流程：
 * 1. 驗證 LINE Access Token
 * 2. 檢查 line_user_id 是否已存在於 profiles
 * 3. 如果存在 → 登入現有用戶
 * 4. 如果不存在 → 建立新用戶（auth.users + profiles）
 */
export async function POST(request) {
  try {
    const { lineUserId, displayName, pictureUrl, accessToken } = await request.json();

    // 驗證必要欄位
    if (!lineUserId) {
      return NextResponse.json(
        { error: 'lineUserId is required' },
        { status: 400 }
      );
    }

    // 驗證 LINE User ID 格式（應該以 'U' 開頭）
    if (!lineUserId.startsWith('U')) {
      console.error('Invalid LINE User ID format:', lineUserId);
      return NextResponse.json(
        { error: 'Invalid LINE User ID format' },
        { status: 400 }
      );
    }

    // 注意：我們不驗證 Access Token，因為：
    // 1. LIFF SDK 在前端已經驗證過用戶身份
    // 2. LIFF App 只能在特定的 Endpoint URL 運行（www.thinker.cafe/line-login）
    // 3. LINE 平台已經確保 LIFF ID 與 Endpoint URL 的綁定關係

    // 使用 Admin Client 執行需要提升權限的操作
    // 直接在這裡建立 admin client，避免 webpack bundling 問題
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    console.log('🔧 VERSION: v20251105_1730_USE_SIGNIN');
    console.log('✅ Admin client created');
    console.log('✅ Has auth:', !!supabase.auth);
    console.log('✅ Has auth.admin:', !!supabase.auth.admin);
    console.log('✅ Has createUser:', typeof supabase.auth.admin?.createUser);
    console.log('✅ Has createSession:', typeof supabase.auth.admin?.createSession);

    // 2. 檢查 line_user_id 是否已存在
    const { data: existingProfile, error: profileError } = await supabase
      .from('profiles')
      .select('user_id, line_user_id, full_name, auth_provider')
      .eq('line_user_id', lineUserId)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      // PGRST116 = 查無資料，這是正常的（新用戶）
      console.error('查詢 profile 錯誤:', profileError);
      return NextResponse.json(
        { error: 'Database error', details: profileError.message },
        { status: 500 }
      );
    }

    // 3. 已存在用戶 → 直接登入
    if (existingProfile) {
      console.log('LINE 用戶已存在，執行登入:', existingProfile.user_id);

      // 更新 profile 資料（可能用戶改了 LINE 顯示名稱或大頭貼）
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          line_display_name: displayName,
          line_picture_url: pictureUrl,
        })
        .eq('user_id', existingProfile.user_id);

      if (updateError) {
        console.warn('更新 profile 失敗:', updateError);
      }

      // 為現有用戶建立 Session
      // 使用虛擬 email 登入（因為我們知道這個用戶是 LINE 登入的）
      const virtualEmail = `${lineUserId}@line.thinker.cafe`;

      // 使用 Admin API 更新用戶密碼（這樣才能用密碼登入）
      const tempPassword = Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12);
      await supabase.auth.admin.updateUserById(existingProfile.user_id, {
        password: tempPassword
      });

      // 使用密碼登入來建立 session
      const { data: sessionData, error: sessionError } = await supabase.auth.signInWithPassword({
        email: virtualEmail,
        password: tempPassword,
      });

      if (sessionError) {
        console.error('建立 session 錯誤:', sessionError);
        return NextResponse.json(
          { error: 'Failed to create session', details: sessionError.message },
          { status: 500 }
        );
      }

      return NextResponse.json({
        success: true,
        isNewUser: false,
        userId: existingProfile.user_id,
        session: sessionData.session, // 返回 session 給前端
        profile: {
          fullName: existingProfile.full_name,
          displayName,
          pictureUrl,
        },
      });
    }

    // 4. 新用戶 → 建立 auth.users + profiles
    console.log('新 LINE 用戶，開始註冊:', lineUserId);

    // 使用虛擬 email（因為 LINE 登入不一定有 email）
    const virtualEmail = `${lineUserId}@line.thinker.cafe`;
    const randomPassword = Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12);

    console.log('🚀 VERSION_CHECK_20251105_1730_USE_SIGNIN: 準備建立用戶');
    console.log('準備建立用戶:', {
      email: virtualEmail,
      lineUserId,
      displayName,
    });

    // 使用 Supabase Admin API 建立用戶（跳過 email 驗證）
    const { data: newUser, error: signUpError } = await supabase.auth.admin.createUser({
      email: virtualEmail,
      password: randomPassword,
      email_confirm: true, // 自動確認 email（虛擬的）
      user_metadata: {
        lineUserId,
        displayName,
        pictureUrl,
        authProvider: 'line',
      },
    });

    if (signUpError) {
      console.error('建立 auth.users 錯誤:', signUpError);
      console.error('錯誤詳情:', JSON.stringify(signUpError, null, 2));
      return NextResponse.json(
        {
          success: false,
          error: 'Failed to create user',
          details: signUpError.message,
          code: signUpError.code,
          supabaseError: signUpError,  // 返回完整的 Supabase 錯誤
          version: 'v20251105_1730_USE_SIGNIN'
        },
        { status: 500 }
      );
    }

    console.log('auth.users 建立成功:', newUser.user.id);

    // ✅ 不需要手動建立 profile！
    // Database trigger (handle_new_user) 會自動建立 profile
    // Trigger 會自動處理 LINE 用戶的 phone_number = NULL
    console.log('✅ Database trigger 會自動建立 profile');

    // 為新用戶建立 Session
    // 使用剛才建立用戶時的密碼登入
    const { data: sessionData, error: sessionError } = await supabase.auth.signInWithPassword({
      email: virtualEmail,
      password: randomPassword,
    });

    if (sessionError) {
      console.error('建立 session 錯誤:', sessionError);
      // 不返回錯誤，因為用戶已經建立成功，只是沒有 session
    }

    return NextResponse.json({
      success: true,
      isNewUser: true,
      userId: newUser.user.id,
      session: sessionData?.session, // 返回 session 給前端
      profile: {
        fullName: displayName,
        displayName,
        pictureUrl,
      },
    });

  } catch (error) {
    console.error('❌ LINE Login API 錯誤:', error);
    console.error('❌ 錯誤堆疊:', error.stack);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        details: error.message,
        stack: error.stack
      },
      { status: 500 }
    );
  }
}
