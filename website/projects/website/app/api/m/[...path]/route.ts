import { NextRequest, NextResponse } from 'next/server';

const MATOMO_ORIGIN = 'http://13.205.188.209';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const target = `${MATOMO_ORIGIN}/${path.join('/')}${request.nextUrl.search}`;
  const res = await fetch(target, { headers: { 'User-Agent': request.headers.get('user-agent') || '' } });
  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'cache-control': path[0] === 'matomo.js' ? 'public, max-age=86400' : 'no-store',
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const target = `${MATOMO_ORIGIN}/${path.join('/')}${request.nextUrl.search}`;
  const body = await request.text();
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') || 'application/x-www-form-urlencoded',
      'user-agent': request.headers.get('user-agent') || '',
    },
    body,
  });
  const resBody = await res.arrayBuffer();
  return new NextResponse(resBody, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' },
  });
}
