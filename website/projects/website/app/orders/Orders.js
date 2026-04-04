'use client';
import { useRouter } from 'next/navigation';
import FormFooter from '@/components/core/FormFooter.js';
import FormButton from '@/components/core/FormButton.js';
import OrderCard from './OrderCard.js';

export default function Orders({ orders, courses }) {
  const router = useRouter();

  return orders.length === 0 ? (
    <>
      <p className="text-center">
        您尚未報名任何課程，快來探索 Thinker Cafe 的眾多精彩課程吧！
      </p>
      <FormFooter>
        <FormButton
          primary
          type="button"
          onClick={() => router.push('/products')}
        >
          探索課程
        </FormButton>
      </FormFooter>
    </>
  ) : (
    <div className="space-y-5">
      {orders.map(order => (
        <OrderCard
          key={order.order_id}
          order={order}
          course={courses.find(course => course.course_id === order.course_id)}
        />
      ))}
    </div>
  );
}
