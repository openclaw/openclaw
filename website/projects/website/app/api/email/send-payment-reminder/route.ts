import { NextRequest, NextResponse } from 'next/server';
import { resend, FROM } from '@/lib/email/resend';
import PaymentReminderEmail from '@/lib/email/templates/PaymentReminder';
import { createClient } from '@/utils/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { notifyAdminNewOrder } from '@/lib/line/admin-notify';

export async function POST(request: NextRequest) {
  try {
    const { orderId } = await request.json();

    if (!orderId) {
      return NextResponse.json(
        { success: false, message: 'Missing orderId' },
        { status: 400 }
      );
    }

    // 安全性檢查：驗證 API 調用來源
    const referer = request.headers.get('referer');
    const origin = request.headers.get('origin');
    const isValidOrigin =
      referer?.includes('thinker.cafe') ||
      origin?.includes('thinker.cafe') ||
      referer?.includes('localhost') ||
      origin?.includes('localhost');

    if (!isValidOrigin) {
      console.error('🚫 Unauthorized API call from:', { referer, origin });
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 查詢訂單資料（使用 admin 權限確保能找到訂單）
    const supabaseAdmin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // 1. 查詢訂單（僅查詢最近 24 小時的訂單）
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('order_id', orderId)
      .gte('created_at', twentyFourHoursAgo)
      .single();

    if (orderError || !order) {
      console.error('Order not found:', orderError);
      return NextResponse.json(
        { success: false, message: 'Order not found' },
        { status: 404 }
      );
    }

    // 2. 查詢用戶資料（從 profiles，使用 admin 權限）
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('*, line_user_id, full_name')
      .eq('user_id', order.user_id)
      .single();

    if (profileError || !profile) {
      console.error('Profile not found:', profileError);
      return NextResponse.json(
        { success: false, message: 'Profile not found' },
        { status: 404 }
      );
    }

    // 3. 取得用戶 Email（從 auth.users，使用已創建的 admin client）
    // 重用上面創建的 supabaseAdmin

    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(order.user_id);

    if (userError || !user || !user.email) {
      console.error('User email not found:', userError);
      return NextResponse.json(
        { success: false, message: 'User email not found' },
        { status: 404 }
      );
    }

    // 4. 查詢課程資料（從 Notion API）
    const { getProducts } = await import('@/lib/notion');
    const courses = await getProducts();
    const course = courses.find((c: any) => c.course_id === order.course_id);

    if (!course) {
      console.error('Course not found');
      return NextResponse.json(
        { success: false, message: 'Course not found' },
        { status: 404 }
      );
    }

    // 計算繳費期限
    const createdAt = new Date(order.created_at);
    const expiresAt = createdAt.getTime() + 24 * 60 * 60 * 1000;

    // 5. 格式化課程名稱
    const { parseCourseName } = await import('@/utils/course');
    const formattedCourseName = parseCourseName(course);

    // 6. 檢查是否為 LINE 假 email，決定是否發送 email
    const isLineUser = user.email.includes('@line.thinker.cafe');
    let emailSent = false;
    let emailError = null;

    if (!isLineUser) {
      // 只有真實 email 用戶才發送 email
      try {
        const { data, error } = await resend.emails.send({
          from: FROM,
          to: user.email,
          subject: `【思考者咖啡】您的報名序號 #${orderId}，請完成繳費`,
          react: PaymentReminderEmail({
            studentName: profile.full_name || '學員',
            orderID: String(orderId),
            courseName: formattedCourseName,
            amount: order.total,
            expiresAt: expiresAt,
            paymentURL: `${(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe').trim()}/order/${orderId}`,
          }),
        });

        if (error) {
          throw error;
        }

        console.log('✅ Payment reminder email sent:', data);
        emailSent = true;
      } catch (error) {
        console.error('Failed to send email:', error);
        emailError = {
          message: error.message,
          code: error.code,
        };
        // 不 return，繼續嘗試發送 LINE 通知
      }
    } else {
      console.log('⚠️  Skipping email for LINE user:', user.email);
    }

    // 如果用戶有 LINE ID，同時發送 LINE 通知
    let lineNotificationSent = false;
    let lineNotificationError = null;

    if (profile.line_user_id) {
      try {
        const { sendPaymentReminder } = await import('@/lib/line/notify');
        await sendPaymentReminder(profile.line_user_id, {
          studentName: profile.full_name || '學員',
          orderID: String(orderId),
          courseName: formattedCourseName,
          amount: order.total,
          expiresAt: expiresAt,
          paymentURL: `${(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe').trim()}/order/${orderId}`,
        });
        console.log('✅ Payment reminder LINE notification sent');
        lineNotificationSent = true;
      } catch (lineError) {
        console.error('⚠️  Failed to send LINE notification (email still sent):', lineError);
        console.error('LINE Error Details:', {
          error: lineError.message,
          stack: lineError.stack,
          statusCode: lineError.statusCode,
          statusMessage: lineError.statusMessage,
          originalError: lineError.originalError,
          lineUserId: profile.line_user_id,
          env: process.env.NODE_ENV,
          // 增加額外的調試信息
          errorName: lineError.name,
          errorCode: lineError.code,
          response: lineError.response?.data || null,
        });

        // 如果是好友檢查失敗，試著跳過檢查
        if (lineError.statusCode === 404 || lineError.message?.includes('not friend')) {
          console.log('🔄 Retrying LINE notification without friend check...');
          try {
            const { sendPaymentReminder } = await import('@/lib/line/notify');
            await sendPaymentReminder(profile.line_user_id, {
              studentName: profile.full_name || '學員',
              orderID: String(orderId),
              courseName: formattedCourseName,
              amount: order.total,
              expiresAt: expiresAt,
              paymentURL: `${(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe').trim()}/order/${orderId}`,
            }, { checkFriendStatus: false });
            console.log('✅ Payment reminder LINE notification sent (retry without friend check)');
            lineNotificationSent = true;
            lineNotificationError = null; // 清除錯誤
          } catch (retryError) {
            console.error('❌ Retry also failed:', retryError);
            lineNotificationError = {
              message: retryError.message,
              statusCode: retryError.statusCode,
              statusMessage: retryError.statusMessage,
              retryFailed: true,
            };
          }
        } else {
          lineNotificationError = {
            message: lineError.message,
            statusCode: lineError.statusCode,
            statusMessage: lineError.statusMessage,
          };
        }
        // 不影響 email 發送的成功，只記錄錯誤
      }
    }

    // 7. 發送管理員通知（新訂單）
    try {
      await notifyAdminNewOrder({
        studentName: profile.full_name || '學員',
        orderID: String(orderId),
        courseName: formattedCourseName,
        amount: order.total,
        courseVariant: order.course_variant,
        orderURL: `${(process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://thinker.cafe').trim()}/order/${orderId}`,
      });
      console.log('✅ Admin notification sent for new order');
    } catch (adminError) {
      console.error('⚠️  Failed to send admin notification:', adminError);
      // 不影響主要流程，只記錄錯誤
    }

    return NextResponse.json({
      success: true,
      message: emailSent ? 'Email and LINE notification processed' : 'LINE notification processed (email skipped for LINE user)',
      emailSent,
      emailError,
      lineNotificationSent,
      lineNotificationError,
      debug: {
        isLineUser,
        hasLineUserId: !!profile.line_user_id,
        lineUserId: profile.line_user_id ? 'present' : 'missing',
        userEmail: user.email,
        env: process.env.NODE_ENV,
      }
    });
  } catch (error) {
    console.error('Error sending payment reminder:', error);
    return NextResponse.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}
