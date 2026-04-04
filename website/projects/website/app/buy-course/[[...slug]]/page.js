import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import Page from '@/components/core/Page.js';
import Cover from '@/components/core/Cover.js';
import Title from '@/components/core/Title.js';
import BuyCourseForm from './BuyCourseForm.js';
import parseMetadataTitle from '@/utils/parseMetadataTitle.js';

export const metadata = {
  title: parseMetadataTitle('報名課程'),
};

export default async function BuyCoursePage({ params }) {
  const { slug } = await params;
  const courseId = slug ? slug[0] : null;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const currentPath = courseId ? `/buy-course/${courseId}` : '/buy-course';
    redirect(`/signin?redirect=${encodeURIComponent(currentPath)}`);
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
        <Title>報名課程</Title>
      </Cover>
      <BuyCourseForm
        courses={courses}
        defaultCourseId={courseId ? Number(courseId) : ''}
      />
    </Page>
  );
}
