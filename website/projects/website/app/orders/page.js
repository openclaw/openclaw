import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import Orders from './Orders.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('我的課程'),
};

export default async function OrdersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const currentPath = '/orders';
    redirect(`/signin?redirect=${encodeURIComponent(currentPath)}`);
  }

  const { data: ordersData, error: ordersError } = await supabase
    .from('orders')
    .select()
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (ordersError) {
    const { code, message } = ordersError;
    throw new Error(`[${code}] ${message}`);
  } 

  const headersList = await headers();
  const host = headersList.get('x-forwarded-host') ?? headersList.get('host');
  const protocol = headersList.get('x-forwarded-proto') ?? (process.env.NODE_ENV === 'development' ? 'http' : 'https');
  const response = await fetch(`${protocol}://${host}/api/products`, { cache: 'no-store' });
  const result = await response.json();
  const courses = result.data.sort((a, b) => a.course_id - b.course_id);

  return (
    <Page>
      <Cover>
        <Title>我的課程</Title>
      </Cover>
      <Orders
        orders={ordersData}
        courses={courses}
      />
    </Page>
  );
}
