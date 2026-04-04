import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export async function POST(request) {
  try {
    const { lineUserId, displayName, pictureUrl, accessToken } = await request.json();

    // 1. 驗證必要參數
    if (!lineUserId || !displayName) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // 驗證 LINE User ID 格式
    if (!lineUserId.startsWith('U')) {
      return NextResponse.json(
        { error: 'Invalid LINE User ID format' },
        { status: 400 }
      );
    }

    // 注意：不驗證 Access Token，LIFF SDK 已在前端完成驗證

    // 3. 取得當前登入用戶
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'User not authenticated' },
        { status: 401 }
      );
    }

    // 4. 檢查當前用戶的 profile
    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('auth_provider, line_user_id, full_name')
      .eq('user_id', user.id)
      .single();

    if (profileError) {
      return NextResponse.json(
        { error: 'Profile not found' },
        { status: 404 }
      );
    }

    // 5. 檢查是否已經綁定 LINE
    if (currentProfile.auth_provider === 'line' && currentProfile.line_user_id) {
      return NextResponse.json(
        {
          success: true,
          message: 'Already migrated to LINE',
          alreadyMigrated: true
        },
        { status: 200 }
      );
    }

    // 6. 檢查這個 LINE 帳號是否已經被其他用戶使用
    const { data: existingLineUser } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('line_user_id', lineUserId)
      .single();

    if (existingLineUser && existingLineUser.user_id !== user.id) {
      return NextResponse.json(
        { error: 'This LINE account is already linked to another user' },
        { status: 409 }
      );
    }

    // 7. 更新 profile，綁定 LINE
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        line_user_id: lineUserId,
        line_display_name: displayName,
        line_picture_url: pictureUrl,
        auth_provider: 'line',
        migrated_from_email: true,
      })
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Update profile error:', updateError);
      return NextResponse.json(
        { error: 'Failed to update profile' },
        { status: 500 }
      );
    }

    // 8. 更新 auth.users 的 user_metadata
    const { error: metadataError } = await supabase.auth.updateUser({
      data: {
        authProvider: 'line',
        lineUserId,
        displayName,
        pictureUrl,
        migratedAt: new Date().toISOString(),
      }
    });

    if (metadataError) {
      console.error('Update metadata error:', metadataError);
      // 不返回錯誤，因為 profile 已經更新成功
    }

    return NextResponse.json({
      success: true,
      message: 'Successfully migrated to LINE',
      user: {
        id: user.id,
        lineUserId,
        displayName,
      }
    });

  } catch (error) {
    console.error('Migration API error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
