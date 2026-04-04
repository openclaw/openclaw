'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import liff from '@line/liff';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import Subtitle from '@/components/core/Subtitle.js';
import FormCard from '@/components/core/FormCard.js';
import FormButton from '@/components/core/FormButton.js';
import { LoaderCircle, CheckCircle2, AlertCircle } from 'lucide-react';
import { createClient } from '@/utils/supabase/client.ts';

export default function MigrateToLinePage() {
  const [status, setStatus] = useState('checking'); // checking, not_logged_in, email_user, migrated, migrating, error
  const [errorMessage, setErrorMessage] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const router = useRouter();

  useEffect(() => {
    checkUserStatus();
  }, []);

  async function checkUserStatus() {
    try {
      const supabase = createClient();
      const { data: { user }, error } = await supabase.auth.getUser();

      if (error || !user) {
        setStatus('not_logged_in');
        return;
      }

      setCurrentUser(user);

      // 檢查是否已經是 LINE 用戶
      const { data: profile } = await supabase
        .from('profiles')
        .select('auth_provider, line_user_id')
        .eq('user_id', user.id)
        .single();

      if (profile?.auth_provider === 'line' && profile?.line_user_id) {
        setStatus('migrated');
      } else {
        setStatus('email_user');
      }
    } catch (error) {
      console.error('Check user status error:', error);
      setErrorMessage(error.message);
      setStatus('error');
    }
  }

  async function startMigration() {
    setStatus('migrating');
    setErrorMessage('');

    try {
      // 開發模式跳過
      if (process.env.NEXT_PUBLIC_DEV_MODE === 'true') {
        alert('開發模式：跳過 LIFF 初始化');
        router.push('/products');
        return;
      }

      // 初始化 LIFF
      await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID });

      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      // 取得 LINE Profile
      const lineProfile = await liff.getProfile();
      const accessToken = liff.getAccessToken();

      // 呼叫遷移 API
      const response = await fetch('/api/line/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lineUserId: lineProfile.userId,
          displayName: lineProfile.displayName,
          pictureUrl: lineProfile.pictureUrl,
          accessToken,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || '遷移失敗');
      }

      // 遷移成功
      setStatus('migrated');

      // 3 秒後導向產品頁
      setTimeout(() => {
        router.push('/products');
      }, 3000);

    } catch (error) {
      console.error('Migration error:', error);
      setErrorMessage(error.message);
      setStatus('error');
    }
  }

  if (status === 'checking') {
    return (
      <Page>
        <Cover>
          <Title>檢查帳號狀態</Title>
        </Cover>
        <div className="max-w-md mx-auto text-center py-12">
          <LoaderCircle size={48} className="mx-auto animate-spin text-orange-500 mb-4" />
          <p className="text-gray-600">正在檢查您的帳號...</p>
        </div>
      </Page>
    );
  }

  if (status === 'not_logged_in') {
    return (
      <Page>
        <Cover>
          <Title>請先登入</Title>
          <Subtitle>您需要先登入才能進行帳號遷移</Subtitle>
        </Cover>
        <div className="max-w-md mx-auto text-center py-8">
          <FormButton primary onClick={() => router.push('/signin')}>
            前往登入
          </FormButton>
        </div>
      </Page>
    );
  }

  if (status === 'migrated') {
    return (
      <Page>
        <Cover>
          <Title>帳號已綁定 LINE</Title>
          <Subtitle>您的帳號已經完成 LINE 綁定</Subtitle>
        </Cover>
        <div className="max-w-md mx-auto text-center py-12">
          <CheckCircle2 size={64} className="mx-auto text-green-500 mb-4" />
          <p className="text-gray-600 mb-4">您現在可以使用 LINE 登入</p>
          <FormButton primary onClick={() => router.push('/products')}>
            前往課程
          </FormButton>
        </div>
      </Page>
    );
  }

  if (status === 'error') {
    return (
      <Page>
        <Cover>
          <Title>遷移失敗</Title>
        </Cover>
        <FormCard error singleColumn>
          <div className="flex items-start gap-3">
            <AlertCircle size={24} className="flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-2">發生錯誤</p>
              <p className="text-sm">{errorMessage}</p>
            </div>
          </div>
        </FormCard>
        <div className="max-w-md mx-auto text-center py-8 space-x-4">
          <FormButton onClick={() => checkUserStatus()}>
            重新檢查
          </FormButton>
          <FormButton primary onClick={startMigration}>
            重試
          </FormButton>
        </div>
      </Page>
    );
  }

  // status === 'email_user' or 'migrating'
  return (
    <Page>
      <Cover>
        <Title>綁定 LINE 帳號</Title>
        <Subtitle>請將您的帳號綁定 LINE，以便未來快速登入</Subtitle>
      </Cover>

      {status === 'migrating' ? (
        <div className="max-w-md mx-auto text-center py-12">
          <LoaderCircle size={48} className="mx-auto animate-spin text-orange-500 mb-4" />
          <p className="text-gray-600">正在綁定 LINE 帳號...</p>
        </div>
      ) : (
        <div className="max-w-md mx-auto space-y-6">
          <FormCard singleColumn>
            <div className="space-y-4">
              <div>
                <p className="font-semibold text-white mb-2">為什麼要綁定 LINE？</p>
                <ul className="text-sm text-gray-200 space-y-2 list-disc list-inside">
                  <li>一鍵快速登入，無需記住密碼</li>
                  <li>接收課程通知與重要訊息</li>
                  <li>更安全的帳號保護</li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-white mb-2">綁定後會發生什麼？</p>
                <ul className="text-sm text-gray-200 space-y-2 list-disc list-inside">
                  <li>您的 Email 帳號將與 LINE 帳號綁定</li>
                  <li>未來可以使用 LINE 登入</li>
                  <li>原有的課程與資料完全保留</li>
                </ul>
              </div>
            </div>
          </FormCard>

          <div className="flex gap-4">
            <FormButton onClick={() => router.back()}>
              稍後再說
            </FormButton>
            <FormButton primary onClick={startMigration}>
              開始綁定 LINE
            </FormButton>
          </div>
        </div>
      )}
    </Page>
  );
}
