'use client';
import { useRouter } from 'next/navigation';
import FormCard from '@/components/core/FormCard.js';
import FormButton from '@/components/core/FormButton.js';
import { parseOrderIdString, parseOrderStateName } from '@/utils/order.js';
import { parseCourseName, parseCourseVariantName } from '@/utils/course.js';
import parsePriceString from '@/utils/parsePriceString.js';
import Image from 'next/image';

export default function OrderCard({ order, course }) {
  const router = useRouter();

  return (
    <FormCard singleColumn>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 md:items-start lg:grid-cols-4 lg:items-stretch">
        <div className="relative aspect-video rounded-md overflow-hidden md:row-span-2 lg:row-span-1">
          <Image
            src={course.image}
            alt={parseCourseName(course)}
            fill
            sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 25vw"
            className="object-cover"
            loading="lazy"
          />
        </div>
        <div className="space-y-3 lg:col-span-2 lg:space-y-4">
          <h2 className="text-2xl/[1.2] font-bold">
            {parseCourseName(course)}
          </h2>
          <p className="grid grid-cols-2 gap-1 text-center md:text-left lg:grid-cols-3">
            <span>
              {parseCourseVariantName(order.course_variant)}
            </span>
            <span>
              NT$ <span className="font-mono">{parsePriceString(order.total)}</span>
            </span>
            <span className="lg:row-start-2">
              序號 {parseOrderIdString(order)}
            </span>
            <span className="lg:row-start-2">
              {parseOrderStateName(order)}
            </span>
          </p>
        </div>
        <div className="lg:flex lg:items-center">
          <FormButton
            primary={['created', 'payed'].includes(order.state)}
            type="button"
            onClick={() => router.push(`/order/${order.order_id}`)}
          >
            {{
              created: '前往繳費',
              payed: '前往驗證',
              messaged: '查看詳情',
              confirmed: '查看詳情',
            }[order.state]}
          </FormButton>
        </div>
      </div>
    </FormCard>
  );
}
