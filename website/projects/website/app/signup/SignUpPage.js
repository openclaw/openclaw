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
import { Checkbox } from '@/components/ui/checkbox';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import Subtitle from '@/components/core/Subtitle.js';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import sanitizeRedirectPath from '@/utils/sanitizeRedirectPath.js';

export default function SignUpPage() {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectPath = sanitizeRedirectPath(searchParams.get('redirect'));
  const signInPath = {
    pathname: '/signin',
    query: redirectPath ? { redirect: redirectPath } : {},
  };

  const formSchema = z.object({
    email: z
      .string({ required_error: '請填寫電子信箱' })
      .min(1, '請填寫電子信箱')
      .email('電子信箱格式不正確'),

    password: z
      .string({ required_error: '請輸入密碼' })
      .min(1, '請輸入密碼')
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{8,32}$/,
        '密碼格式不正確'
      ),

    passwordConfirm: z
      .string({ required_error: '請再次輸入密碼' })
      .min(1, '請再次輸入密碼'),

    fullName: z
      .string({ required_error: '請填寫姓名' })
      .min(1, '請填寫姓名')
      .max(100, '姓名長度不可超過 100 個字元'),

    phoneNumber: z
      .string({ required_error: '請填寫手機/市話' })
      .min(1, '請填寫手機/市話')
      .max(100, '手機/市話長度不可超過 100 個字元'),

    agreeTos: z.literal(true, {
      errorMap: () => ({ message: '請勾選以表示您已閱讀並同意學生權益書條款' }),
    }),
  })
  .superRefine(({ password, passwordConfirm }, ctx) => {
    if (password !== passwordConfirm) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwordConfirm'],
        message: '兩次輸入的密碼不一致',
      });
    }
  });

  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: '',
      password: '',
      passwordConfirm: '',
      fullName: '',
      phoneNumber: '',
      agreeTos: false,
    },
  });

  async function onSubmit(values) {
    setErrorMessage('');
    setLoading(true);

    const {
      email,
      password,
      fullName,
      phoneNumber,
      agreeTos,
    } = values;
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          fullName,
          phoneNumber,
          agreeTos,
        }
      }
    });

    if (error) {
      const { code, message } = error;
      if (code === 'user_already_exists') {
        setErrorMessage('此信箱已被註冊，請改用其他信箱或直接登入。');
      } else {
        setErrorMessage(`[${code}] ${message}`);
      }
      setLoading(false);
      return;
    }

    router.replace(redirectPath ?? '/signup-success');
    router.refresh();
  }

  return (
    <Page>
      <Cover>
        <Title>學員註冊</Title>
        <Subtitle>
          已經是學員了嗎？<Link href={signInPath} className="text-orange-400">前往登入</Link>。
        </Subtitle>
      </Cover>
      <Form {...form}>
        <form
          className="max-w-3xl mx-auto space-y-5"
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <FormCard title="帳號密碼">
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
                <FormItem className="md:row-start-2">
                  <FormLabel>
                    密碼
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormDescription className="-mt-1 text-xs">
                    請輸入 8 至 32 碼半形英數字，並至少包含一個大寫英文、一個小寫英文、一個數字
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="passwordConfirm"
              render={({ field }) => (
                <FormItem className="md:row-start-2">
                  <FormLabel>
                    再次輸入密碼
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
          <FormCard title="基本資料">
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    姓名
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="text" {...field} />
                  </FormControl>
                  <FormDescription className="-mt-1 text-xs">
                    此姓名將被印製於研習證書上，請務必填寫真實姓名
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phoneNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    手機/市話
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="text" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </FormCard>
          <FormCard title="學生權益" singleColumn>
            <p>
              為保障雙方權益，請您於提交表單前閱讀並同意 <a href="/files/terms-of-service.pdf" target="_blank" rel="noopener noreferrer" className="text-orange-400">學生權益書</a> 條款，方可註冊並使用本服務。
            </p>
            <FormField
              control={form.control}
              name="agreeTos"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <FormLabel>
                      我已閱讀並同意學生權益書條款
                      <span className="-ml-1 text-red-700">*</span>
                    </FormLabel>
                  </div>
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
              確認送出
            </FormButton>
            <FormButton
              type="button"
              onClick={() => router.back()}
              disabled={loading}
            >
              回上一頁
            </FormButton>
          </FormFooter>
        </form>
      </Form>
    </Page>
  );
}
