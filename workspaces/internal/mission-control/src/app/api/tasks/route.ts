import { NextResponse } from 'next/server';
import { taskStore } from '@/lib/taskStore';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ ok: true, tasks: taskStore.list() });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.title || typeof body.title !== 'string') {
    return NextResponse.json({ ok: false, error: 'title is required' }, { status: 400 });
  }

  const task = taskStore.create({
    title: body.title,
    project: body.project,
    priority: body.priority,
    status: body.status,
    ownerAgent: body.ownerAgent,
    ownerSubAgent: body.ownerSubAgent,
    node: body.node,
    dueAt: body.dueAt,
    etaMinutes: body.etaMinutes,
    blocker: body.blocker,
    nextAction: body.nextAction,
    sourceChannel: body.sourceChannel,
  });

  return NextResponse.json({ ok: true, task });
}
