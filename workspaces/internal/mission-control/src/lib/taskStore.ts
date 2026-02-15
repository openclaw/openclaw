import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { Task, TaskStatus, TaskWithDerived, SlaRisk, Priority } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const TASKS_PATH = path.join(DATA_DIR, 'tasks.json');

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function computeDerived(task: Task): TaskWithDerived {
  const now = Date.now();
  const dueMs = task.dueAt ? Date.parse(task.dueAt) : undefined;
  const isOverdue = typeof dueMs === 'number' ? now > dueMs : false;

  let blockedMinutes: number | undefined;
  if (task.status === 'blocked' && task.lastUpdateAt) {
    const last = Date.parse(task.lastUpdateAt);
    if (!Number.isNaN(last)) blockedMinutes = Math.max(0, Math.round((now - last) / 60000));
  }

  let slaRisk: SlaRisk = 'green';
  if (isOverdue) slaRisk = 'red';
  else if (task.status === 'blocked' && (blockedMinutes ?? 0) > 30) slaRisk = 'red';
  else if (typeof task.etaMinutes === 'number' && task.startedAt) {
    const started = Date.parse(task.startedAt);
    if (!Number.isNaN(started)) {
      const elapsedMin = (now - started) / 60000;
      if (elapsedMin > task.etaMinutes * 1.2) slaRisk = 'amber';
    }
  }

  return { ...task, slaRisk, isOverdue, blockedMinutes };
}

export class TaskStore {
  private emitter = new EventEmitter();
  private tasks: Task[] = [];

  constructor() {
    ensureDataDir();
    if (fs.existsSync(TASKS_PATH)) {
      const raw = fs.readFileSync(TASKS_PATH, 'utf-8');
      this.tasks = safeParseJson<Task[]>(raw, []);
    } else {
      this.persist();
    }
  }

  private persist() {
    ensureDataDir();
    fs.writeFileSync(TASKS_PATH, JSON.stringify(this.tasks, null, 2));
  }

  private publish() {
    this.emitter.emit('change');
  }

  onChange(fn: () => void) {
    this.emitter.on('change', fn);
    return () => this.emitter.off('change', fn);
  }

  list(): TaskWithDerived[] {
    return this.tasks
      .slice()
      .sort((a, b) => (a.priority < b.priority ? -1 : a.priority > b.priority ? 1 : 0))
      .map(computeDerived);
  }

  get(id: string): TaskWithDerived | undefined {
    const t = this.tasks.find((x) => x.id === id);
    return t ? computeDerived(t) : undefined;
  }

  create(input: {
    title: string;
    project?: string;
    priority?: Priority;
    status?: TaskStatus;
    ownerAgent?: string;
    ownerSubAgent?: string;
    node?: string;
    dueAt?: string;
    etaMinutes?: number;
    blocker?: string;
    nextAction?: string;
    sourceChannel?: string;
  }): TaskWithDerived {
    const task: Task = {
      id: crypto.randomUUID(),
      title: input.title,
      project: input.project,
      priority: input.priority ?? 'P2',
      status: input.status ?? 'queued',
      ownerAgent: input.ownerAgent,
      ownerSubAgent: input.ownerSubAgent,
      node: input.node,
      dueAt: input.dueAt,
      etaMinutes: input.etaMinutes,
      blocker: input.blocker,
      nextAction: input.nextAction,
      sourceChannel: input.sourceChannel,
      createdAt: nowIso(),
      startedAt: input.status === 'running' ? nowIso() : undefined,
      lastUpdateAt: nowIso(),
    };

    this.tasks.unshift(task);
    this.persist();
    this.publish();
    return computeDerived(task);
  }

  update(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): TaskWithDerived {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) throw new Error('Task not found');

    const prev = this.tasks[idx];
    const next: Task = {
      ...prev,
      ...patch,
      startedAt:
        patch.status === 'running' && !prev.startedAt
          ? nowIso()
          : patch.startedAt ?? prev.startedAt,
      lastUpdateAt: nowIso(),
    };

    this.tasks[idx] = next;
    this.persist();
    this.publish();
    return computeDerived(next);
  }
}

// Hot-reload safe singleton (Next dev server reloads modules)
const g = globalThis as unknown as { __missionControlTaskStore?: TaskStore };
export const taskStore = g.__missionControlTaskStore ?? new TaskStore();
if (!g.__missionControlTaskStore) g.__missionControlTaskStore = taskStore;
