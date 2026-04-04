'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TriangleAlert, LoaderCircle } from 'lucide-react';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { createClient } from '@/utils/supabase/client.ts';
import { parseStudentIdString, parseStudentName } from '@/utils/profile.js';
import { parseOrderIdString } from '@/utils/order.js';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';

export default function CreatedOrderForm({ order, profile, course }) {
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const router = useRouter();

  async function updateOrderState() {
    setErrorMessage('');
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase
      .from('orders')
      .update({ state: 'payed' })
      .eq('order_id', order.order_id);

    if (error) {
      const { code, message } = error;
      setErrorMessage(`[${code}] ${message}`);
      setLoading(false);
      return;
    }

    router.replace(`/order/${order.order_id}`);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <FormCard singleColumn title="步驟 3. 轉帳繳費">
        <div className="space-y-4">
          <p>
            學員編號：<span className="font-mono">{parseStudentIdString(profile)}</span><br />
            學員姓名：{parseStudentName(profile)}<br />
            報名序號：{parseOrderIdString(order)}<br />
            報名課程：{parseCourseName(course)}<br />
            上課方式：{parseCourseVariantName(order.course_variant)}<br />
            課程費用：新台幣 <span className="font-mono">{parsePriceString(order.total)}</span> 元<br />
          </p>
          <hr className="border-foreground/33" />
          <p>
            繳費方式：轉帳繳費<br />
            應繳金額：新台幣 <span className="font-mono">{parsePriceString(order.total)}</span> 元<br />
            收款帳戶：思考者咖啡有限公司<br />
            收款銀行：<span className="font-mono">007</span> 第一銀行 苗栗分行<br />
            收款帳號：<span className="font-mono">321-10-060407</span><br />
          </p>
        </div>
      </FormCard>
      <FormCard singleColumn>
        <ul className="ml-4 list-disc font-bold text-red-600">
          <li>請務必於 24 小時內完成付款。若超過 24 小時，此報名將自動取消。</li>
          <li>在完成付款前，請將此分頁維持開啟或存成書籤，以免遺失繳費資訊。</li>
        </ul>
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
          type="button"
          onClick={() => updateOrderState()}
          disabled={loading}
        >
          {loading && <LoaderCircle size={20} className="mr-1 animate-spin" />}
          已完成繳費，前往驗證
        </FormButton>
      </FormFooter>
    </div>
  );
}
