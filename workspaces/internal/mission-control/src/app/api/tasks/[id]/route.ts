import { NextResponse } from 'next/server';
import { taskStore } from '@/lib/taskStore';

export const runtime = 'nodejs';

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = taskStore.get(id);
  if (!task) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, task });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const task = taskStore.update(id, body);
    return NextResponse.json({ ok: true, task });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'update failed' },
      { status: 404 }
    );
  }
}
