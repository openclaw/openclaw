'use client';

import { useRouter } from 'next/navigation';
import FormCard from '@/components/core/FormCard.js';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import { parseStudentIdString, parseStudentName } from '@/utils/profile.js';
import { parseOrderIdString } from '@/utils/order.js';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';

export default function ConfirmedOrderForm({ order, profile, course }) {
  const router = useRouter();

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <FormCard singleColumn title="您已報名成功！">
        <div className="space-y-4">
          <p>
            感謝您對本課程的支持，以下是您的報名資訊：
          </p>
          <p>
            學員編號：<span className="font-mono">{parseStudentIdString(profile)}</span><br />
            學員姓名：{parseStudentName(profile)}<br />
            報名序號：{parseOrderIdString(order)}<br />
            報名課程：{parseCourseName(course)}<br />
            上課方式：{parseCourseVariantName(order.course_variant)}<br />
            課程費用：新台幣 <span className="font-mono">{parsePriceString(order.total)}</span> 元<br />
          </p>
        </div>
      </FormCard>
      <FormFooter>
        <FormButton
          primary
          type="button"
          onClick={() => router.push('/products')}
        >
          探索更多精彩課程
        </FormButton>
      </FormFooter>
    </div>
  );
}
