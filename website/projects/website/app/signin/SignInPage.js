'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import Link from 'next/link';
import { TriangleAlert, LoaderCircle } from 'lucide-react';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import Subtitle from '@/components/core/Subtitle.js';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import sanitizeRedirectPath from '@/utils/sanitizeRedirectPath.js';

export default function SignInPage() {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = sanitizeRedirectPath(searchParams.get('redirect'));
  const signUpPath = {
    pathname: '/signup',
    query: redirectPath ? { redirect: redirectPath } : {},
  };

  const formSchema = z.object({
    email: z
      .string({ required_error: '請輸入電子信箱' })
      .min(1, '請輸入電子信箱'),

    password: z
      .string({ required_error: '請輸入密碼' })
      .min(1, '請輸入密碼'),
  });

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  async function onSubmit(values) {
    setErrorMessage('');
    setLoading(true);

    const { email, password } = values;
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      const { code, message } = error;
      if (code === 'invalid_credentials') {
        setErrorMessage('帳號或密碼錯誤。');
      } else {
        setErrorMessage(`[${code}] ${message}`);
      }
      setLoading(false);
      return;
    }

    // 檢查是否需要遷移到 LINE
    const { data: profile } = await supabase
      .from('profiles')
      .select('auth_provider, line_user_id')
      .eq('user_id', data.user.id)
      .single();

    // 如果是 Email 用戶且尚未綁定 LINE，強制導向遷移頁面
    if (profile && profile.auth_provider === 'email' && !profile.line_user_id) {
      router.replace('/migrate-to-line');
      return;
    }

    router.replace(redirectPath ?? '/');
    router.refresh();
  }

  return (
    <Page>
      <Cover>
        <Title>學員登入</Title>
        <Subtitle>
          還不是學員嗎？<Link href={signUpPath} className="text-orange-400">前往註冊</Link>。
        </Subtitle>
      </Cover>

      {/* LINE Login 按鈕 */}
      <div className="max-w-md mx-auto mb-8">
        <button
          type="button"
          onClick={() => router.push('/line-login')}
          className="w-full flex items-center justify-center gap-3 px-6 py-3 bg-[#06C755] hover:bg-[#05B34A] text-white font-semibold rounded-lg transition-colors shadow-md"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314"/>
          </svg>
          使用 LINE 登入
        </button>
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300"></div>
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-4 bg-white text-gray-500">或使用電子信箱登入</span>
          </div>
        </div>
      </div>

      <Form {...form}>
        <form
          className="max-w-md mx-auto space-y-5"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FormCard singleColumn>
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    電子信箱
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="text" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    密碼
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FormCard>
          {errorMessage && (
            <FormCard error singleColumn>
              <p className="flex items-center gap-2">
                <TriangleAlert size={18} />
                {errorMessage}
              </p>
            </FormCard>
          )}
          <FormFooter>
            <FormButton
              primary
              type="submit"
              disabled={loading}
            >
              {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
              登入
            </FormButton>
            <FormButton
              type="button"
              onClick={() => router.back()}
              disabled={loading}
            >
              返回
            </FormButton>
          </FormFooter>
        </form>
      </Form>
    </Page>
  );
}
