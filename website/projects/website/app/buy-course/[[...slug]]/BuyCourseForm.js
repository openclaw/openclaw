'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';
import { useToast } from '@/hooks/use-toast';
import { trackBeginCheckout, trackPurchase } from '@/lib/analytics';
import { useMetaTracking } from '@/hooks/useMetaTracking';

const REWARD_STORAGE_KEY = 'explorer_discount';

export default function BuyCourseForm({ courses, defaultCourseId }) {
  const [state, setState] = useState('filling');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [explorerDiscount, setExplorerDiscount] = useState(0);
  const router = useRouter();
  const { toast } = useToast();
  const { trackPurchase: trackMetaPurchase } = useMetaTracking();

  // 只顯示已開放的課程（目前只有第六課）
  const availableCourses = courses.filter(course => course.course_id === 6);

  const formSchema = z.object({
    courseId: z.number({ message: '請選擇課程名稱' }).int().positive(),
    courseVariant: z.enum(['group', 'single'], { message: '請選擇上課方式' }),
  });
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      courseId: defaultCourseId,
      courseVariant: null,
    },
  });
  const selectedCourseId = form.watch('courseId');
  const selectedCourseVariant = form.watch('courseVariant');
  const selectedCourse = availableCourses.find(({ course_id }) => course_id === selectedCourseId);
  const total = selectedCourse ? {
    group: selectedCourse.group_price,
    single: selectedCourse.single_price,
  }[selectedCourseVariant] : 0;
  const totalEarly = selectedCourse ? {
    group: selectedCourse.group_price_early,
    single: selectedCourse.single_price_early,
  }[selectedCourseVariant] : 0;

  // 讀取探索者折扣
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REWARD_STORAGE_KEY);
      if (saved) {
        const reward = JSON.parse(saved);
        // 檢查是否是第六課的折扣
        if (reward.courseId === 6 && reward.amount) {
          setExplorerDiscount(reward.amount);
        }
      }
    } catch (e) {
      console.error('Failed to read explorer discount:', e);
    }
  }, []);

  // 計算最終價格（早鳥價或一般價 - 探索者折扣）
  const finalTotal = Math.max(0, (totalEarly || total) - explorerDiscount);

  async function onSubmit(values) {
    if (state === 'filling') {
      setState('verifying');
      return;
    }

    setErrorMessage('');
    setLoading(true);

    const { courseId, courseVariant } = values;
    const supabase = createClient();

    // 追蹤開始結帳
    trackBeginCheckout({
      id: courseId.toString(),
      name: selectedCourse?.zh_name || '課程',
      category: selectedCourse?.zh_category || '分類',
      variant: courseVariant,
      price: finalTotal
    });

    // 1. 建立訂單
    const { data, error } = await supabase
      .from('orders')
      .insert({
        course_id: courseId,
        course_variant: courseVariant,
        total: finalTotal,
      })
      .select();

    if (error) {
      const { code, message } = error;
      setErrorMessage(`[${code}] ${message}`);
      setLoading(false);
      return;
    }

    const orderId = data[0].order_id;

    // 追蹤訂單建立成功（等同於購買完成）
    // GA4 追蹤
    trackPurchase({
      orderId,
      courseId: courseId.toString(),
      courseName: selectedCourse?.zh_name || '課程',
      category: selectedCourse?.zh_category || '分類',
      variant: courseVariant,
      total: finalTotal
    });

    // Meta Pixel 雙層追蹤 - Purchase
    await trackMetaPurchase(
      finalTotal,
      'TWD',
      [{
        id: courseId.toString(),
        quantity: 1,
        item_price: finalTotal,
      }]
    );

    // 2. 發送繳費提醒通知（非同步處理）
    fetch('/api/email/send-payment-reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        console.log('✅ Payment reminder sent:', data);
        // 根據發送方式調整提示訊息
        const notificationMethod = data.emailSent ? 'EMAIL和LINE' : 'LINE';
        toast({
          title: "報名成功！",
          description: `繳費提醒已透過 ${notificationMethod} 通知您`,
        });
      } else {
        console.error('Failed to send payment reminder:', data);
        toast({
          title: "報名成功！",
          description: "請至訂單頁面查看繳費資訊",
        });
      }
    })
    .catch(err => {
      console.error('Failed to send payment reminder:', err);
      // 即使通知失敗，報名仍然成功
      toast({
        title: "報名成功！",
        description: "請至訂單頁面查看繳費資訊",
      });
    });

    // 3. 導向繳費頁面
    setLoading(false);
    router.push(`/order/${orderId}`);
  }

  return (
    <Form {...form}>
      <form
        className="max-w-3xl mx-auto space-y-5"
        onSubmit={form.handleSubmit(onSubmit)}
      >
        {state === 'filling' && (
        <FormCard title="步驟 1. 選擇欲報名課程">
          {explorerDiscount > 0 && (
            <div className="mb-4 p-3 bg-green-500/10 border border-green-400/30 rounded-lg">
              <p className="text-sm text-green-400 flex items-center gap-2">
                <span>🎉</span>
                <span>已套用探索者折扣：<span className="font-bold font-mono">-NT$ {parsePriceString(explorerDiscount)}</span></span>
              </p>
            </div>
          )}
          <div>
            <FormField
              control={form.control}
              name="courseId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    課程名稱
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <Select
                    value={String(field.value)}
                    onValueChange={value => {
                      field.onChange(Number(value));
                      form.setValue('courseVariant', null);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full min-w-0">
                        <SelectValue placeholder="請選擇" className="truncate" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {availableCourses.map(course => (
                        <SelectItem key={course.course_id} value={String(course.course_id)}>
                          {parseCourseName(course)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div>
            <FormField
              control={form.control}
              name="courseVariant"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    上課方式
                    <span className="-ml-1 text-red-700">*</span>
                  </FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="grid grid-cols-2 gap-x-2 mt-2"
                    >
                      {!selectedCourse && (
                        <span>--</span>
                      )}
                      {selectedCourse && selectedCourse.group_price !== 0 && (
                      <FormItem className="flex items-start">
                        <FormControl>
                          <RadioGroupItem value="group" />
                        </FormControl>
                        <FormLabel className="flex-col items-start">
                          <span>小班制</span>
                          {selectedCourse && selectedCourse.group_price_early === 0 && (
                            <span className="font-bold text-orange-400">定價 <span className="font-mono">{parsePriceString(selectedCourse.group_price)}</span> 元</span>
                          )}
                          {selectedCourse && selectedCourse.group_price_early !== 0 && (
                            <>
                              <span className="line-through text-gray-500">原價 <span className="font-mono">{parsePriceString(selectedCourse.group_price)}</span> 元</span>
                              <span className="font-bold text-orange-400">早鳥價 <span className="font-mono">{parsePriceString(selectedCourse.group_price_early)}</span> 元</span>
                            </>
                          )}
                        </FormLabel>
                      </FormItem>
                      )}
                      {selectedCourse && selectedCourse.single_price !== 0 && (
                      <FormItem className="flex items-start">
                        <FormControl>
                          <RadioGroupItem value="single" />
                        </FormControl>
                        <FormLabel className="flex-col items-start">
                          <span>一對一</span>
                          {selectedCourse && selectedCourse.single_price_early === 0 && (
                            <span className="font-bold text-orange-400">定價 <span className="font-mono">{parsePriceString(selectedCourse.single_price)}</span> 元</span>
                          )}
                          {selectedCourse && selectedCourse.single_price_early !== 0 && (
                            <>
                              <span className="line-through text-gray-500">原價 <span className="font-mono">{parsePriceString(selectedCourse.single_price)}</span> 元</span>
                              <span className="font-bold text-orange-400">早鳥價 <span className="font-mono">{parsePriceString(selectedCourse.single_price_early)}</span> 元</span>
                            </>
                          )}
                        </FormLabel>
                      </FormItem>
                      )}
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormCard>
        )}
        {state === 'verifying' && (
          <FormCard singleColumn title="步驟 2. 確認報名資訊">
            <p>
              課程名稱：{parseCourseName(selectedCourse)}<br />
              上課方式：{parseCourseVariantName(selectedCourseVariant)}<br />
              {explorerDiscount > 0 ? (
                <>
                  原價：新台幣 <span className="font-mono line-through text-gray-500">{parsePriceString(totalEarly || total)}</span> 元<br />
                  探索者折扣：<span className="font-mono text-green-600">-{parsePriceString(explorerDiscount)}</span> 元<br />
                  <span className="font-bold text-orange-400">
                    實付金額：新台幣 <span className="font-mono">{parsePriceString(finalTotal)}</span> 元
                  </span>
                </>
              ) : (
                <>
                  課程費用：新台幣 <span className="font-mono">{parsePriceString(totalEarly || total)}</span> 元<br />
                </>
              )}
            </p>
          </FormCard>
        )}
        {errorMessage && (
          <FormCard error singleColumn>
            <p className="flex items-center gap-2">
              <TriangleAlert size={18} />
              {errorMessage}
            </p>
          </FormCard>
        )}
        <FormFooter>
          {state === 'filling' && (
            <>
              <FormButton primary type="submit">
                繼續
              </FormButton>
              <FormButton type="button" onClick={() => router.back()}>
                返回
              </FormButton>
            </>
          )}
          {state === 'verifying' && (
            <>
              <FormButton
                primary
                type="submit"
                disabled={loading}
              >
                {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
                確認無誤，前往繳費
              </FormButton>
              <FormButton
                type="button"
                onClick={() => setState('filling')}
                disabled={loading}
              >
                我選錯了，返回修改
              </FormButton>
            </>
          )}
        </FormFooter>
      </form>
    </Form>
  );
}
