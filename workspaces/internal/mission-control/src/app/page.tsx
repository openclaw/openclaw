'use client';

import React from 'react';
import type { TaskWithDerived, TaskStatus, Priority } from '@/lib/types';

type TasksPayload = { ok: boolean; tasks: TaskWithDerived[] };

function cls(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

const statusOrder: TaskStatus[] = ['queued', 'running', 'review', 'blocked', 'done'];

const statusLabel: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
};

const priorityClass: Record<Priority, string> = {
  P1: 'border-red-500/30 bg-red-500/10 text-red-200',
  P2: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  P3: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
};

const riskDot: Record<TaskWithDerived['slaRisk'], string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-400',
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function useTasksStream() {
  const [tasks, setTasks] = React.useState<TaskWithDerived[]>([]);
  const [connected, setConnected] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    const es = new EventSource('/api/stream');

    es.addEventListener('open', () => {
      setConnected(true);
      setErr(null);
    });

    const onTasks = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as TasksPayload;
        if (payload?.ok && Array.isArray(payload.tasks)) setTasks(payload.tasks);
      } catch {
        // ignore
      }
    };

    es.addEventListener('snapshot', onTasks);
    es.addEventListener('tasks', onTasks);

    es.addEventListener('error', () => {
      setConnected(false);
      setErr('stream error (will retry)');
    });

    return () => es.close();
  }, []);

  return { tasks, connected, err };
}

type OpsMetrics = Record<string, { cpuPct?: number; memUsedPct?: number }>;

function useOpsMetrics() {
  const [metrics, setMetrics] = React.useState<OpsMetrics | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const res = await fetch('/api/ops', { cache: 'no-store' });
        const data = await res.json();
        if (!alive) return;
        setMetrics(data?.metrics ?? null);
        setErr(res.ok ? null : data?.error ?? `HTTP ${res.status}`);
      } catch (e: unknown) {
        if (!alive) return;
        setErr(e instanceof Error ? e.message : 'ops fetch failed');
      }
    }

    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return { metrics, err };
}

export default function Page() {
  const { tasks, connected, err } = useTasksStream();
  const { metrics, err: opsErr } = useOpsMetrics();

  const [title, setTitle] = React.useState('');
  const [project, setProject] = React.useState('');
  const [priority, setPriority] = React.useState<Priority>('P2');
  const [status, setStatus] = React.useState<TaskStatus>('queued');
  const [ownerAgent, setOwnerAgent] = React.useState('');
  const [node, setNode] = React.useState('');
  const [dueAt, setDueAt] = React.useState('');
  const [etaMinutes, setEtaMinutes] = React.useState('');
  const [nextAction, setNextAction] = React.useState('');

  const [actionErr, setActionErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const alerts = tasks.filter((t) => t.slaRisk !== 'green' || t.status === 'blocked');

  const byStatus = React.useMemo(() => {
    const m = new Map<TaskStatus, TaskWithDerived[]>();
    for (const s of statusOrder) m.set(s, []);
    for (const t of tasks) m.get(t.status)?.push(t);
    for (const s of statusOrder) {
      m.get(s)?.sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0));
    }
    return m;
  }, [tasks]);

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionErr(null);
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title,
          project: project || undefined,
          priority,
          status,
          ownerAgent: ownerAgent || undefined,
          node: node || undefined,
          dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
          etaMinutes: etaMinutes ? Number(etaMinutes) : undefined,
          nextAction: nextAction || undefined,
          sourceChannel: 'mission-control',
        }),
      });
      setTitle('');
      setNextAction('');
    } catch (e: unknown) {
      setActionErr(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(false);
    }
  }

  async function quickUpdate(id: string, patch: Record<string, unknown>) {
    setBusy(true);
    setActionErr(null);
    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } catch (e: unknown) {
      setActionErr(e instanceof Error ? e.message : 'update failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
        <header className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Mission Control</div>
              <h1 className="text-2xl font-semibold">Realtime Work Tasks (SSE stream)</h1>
              <div className="mt-2 text-xs text-slate-400">
                Stream: <span className={connected ? 'text-emerald-300' : 'text-amber-300'}>{connected ? 'CONNECTED' : 'DISCONNECTED'}</span>
                {err ? <span className="ml-2 text-red-300">{err}</span> : null}
              </div>
              {opsErr ? <div className="mt-1 text-xs text-red-300">Metrics error: {opsErr}</div> : null}
              {actionErr ? <div className="mt-2 text-xs text-red-300">Action error: {actionErr}</div> : null}
            </div>
            <div className="text-xs text-slate-400 space-y-1">
              <div>Tasks: {tasks.length} • Alerts: {alerts.length}</div>
              <div className="flex flex-wrap gap-2">
                {['MACMINI', 'DEV-PC-I9'].map((name) => {
                  const m = metrics?.[name];
                  const cpu = typeof m?.cpuPct === 'number' ? m.cpuPct : null;
                  const mem = typeof m?.memUsedPct === 'number' ? m.memUsedPct : null;
                  return (
                    <span key={name} className="rounded border border-slate-700 bg-slate-950 px-2 py-1">
                      <span className="text-slate-300 font-semibold">{name}</span>
                      <span className="text-slate-500"> • </span>
                      <span className="text-slate-300">CPU {cpu !== null ? cpu.toFixed(0) + '%' : '—'}</span>
                      <span className="text-slate-500"> • </span>
                      <span className="text-slate-300">MEM {mem !== null ? mem.toFixed(0) + '%' : '—'}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Actionable Alerts</h2>
            <div className="mt-3 space-y-2">
              {alerts.length ? (
                alerts.slice(0, 8).map((t) => (
                  <div key={t.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className={cls('h-2 w-2 rounded-full', riskDot[t.slaRisk])} />
                        <span className="font-semibold">{t.title}</span>
                      </div>
                      <span className={cls('rounded border px-2 py-0.5', priorityClass[t.priority])}>{t.priority}</span>
                    </div>
                    <div className="mt-1 text-slate-400">
                      {t.project ? `${t.project} • ` : ''}{statusLabel[t.status]} • {t.ownerAgent ?? 'unowned'}{t.node ? ` • ${t.node}` : ''}
                    </div>
                    {t.blocker ? <div className="mt-1 text-red-300">Blocker: {t.blocker}</div> : null}
                    {t.isOverdue ? <div className="mt-1 text-red-300">OVERDUE</div> : null}
                  </div>
                ))
              ) : (
                <div className="text-xs text-slate-500">No alerts.</div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Create Task</h2>
            <form onSubmit={createTask} className="mt-3 space-y-3 text-sm">
              <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
              <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="Project (optional)" value={project} onChange={(e) => setProject(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <select className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                  <option value="P3">P3</option>
                </select>
                <select className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                  {statusOrder.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="Owner agent (e.g. dev)" value={ownerAgent} onChange={(e) => setOwnerAgent(e.target.value)} />
                <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="Node (e.g. DEV-PC-I9)" value={node} onChange={(e) => setNode(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
                <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="ETA minutes" value={etaMinutes} onChange={(e) => setEtaMinutes(e.target.value)} />
              </div>
              <input className="w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2" placeholder="Next action (optional)" value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
              <button disabled={busy} className="w-full rounded-md bg-slate-100 px-3 py-2 text-slate-900 font-semibold disabled:opacity-50">
                {busy ? 'Working…' : 'Add task'}
              </button>
              <div className="text-xs text-slate-500">Stored locally in <code className="text-slate-300">mission-control/data/tasks.json</code></div>
            </form>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Kanban</h2>
          <div className="grid gap-4 xl:grid-cols-5">
            {statusOrder.map((s) => (
              <div key={s} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{statusLabel[s]}</div>
                  <div className="text-xs text-slate-400">{byStatus.get(s)?.length ?? 0}</div>
                </div>
                <div className="mt-3 space-y-2">
                  {(byStatus.get(s) ?? []).map((t) => (
                    <div key={t.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold">{t.title}</span>
                        <span className={cls('rounded border px-2 py-0.5', priorityClass[t.priority])}>{t.priority}</span>
                      </div>
                      <div className="text-slate-400">
                        {t.project ? `${t.project} • ` : ''}{t.ownerAgent ?? 'unowned'}{t.node ? ` • ${t.node}` : ''}
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-slate-300">
                          <span className={cls('h-2 w-2 rounded-full', riskDot[t.slaRisk])} />
                          <span>{t.slaRisk.toUpperCase()}</span>
                          {t.isOverdue ? <span className="text-red-300">OVERDUE</span> : null}
                        </div>
                        <div className="flex gap-1">
                          {t.status !== 'running' ? (
                            <button className="rounded border border-slate-700 px-2 py-1 text-slate-200" onClick={() => quickUpdate(t.id, { status: 'running' })}>
                              Start
                            </button>
                          ) : null}
                          {t.status !== 'done' ? (
                            <button className="rounded border border-slate-700 px-2 py-1 text-slate-200" onClick={() => quickUpdate(t.id, { status: 'done' })}>
                              Done
                            </button>
                          ) : null}
                          {t.status !== 'blocked' ? (
                            <button className="rounded border border-slate-700 px-2 py-1 text-slate-200" onClick={() => quickUpdate(t.id, { status: 'blocked' })}>
                              Block
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {t.nextAction ? <div className="text-slate-300"><span className="text-slate-500">Next:</span> {t.nextAction}</div> : null}
                      {t.blocker ? <div className="text-red-300">Blocker: {t.blocker}</div> : null}
                    </div>
                  ))}
                  {(byStatus.get(s) ?? []).length === 0 ? <div className="text-xs text-slate-600">—</div> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
    </div>
  );
}

