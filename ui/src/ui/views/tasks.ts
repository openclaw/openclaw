import { html, nothing, type TemplateResult } from "lit";
import type { OpenClawApp } from "../app.js";
import { normalizeBasePath } from "../navigation.ts";

type TasksHost = OpenClawApp & { tasksState?: TasksState };

type TaskStatus = "upcoming" | "in_progress" | "done";
type TaskPriority = "P0" | "P1" | "P2" | "P3";

type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  doneAt?: string | null;
  notes?: string | null;
};

type TaskStore = {
  updatedAt: string | null;
  tasks: Task[];
};

type TasksState = {
  loading: boolean;
  error: string | null;
  store: TaskStore | null;
  q: string;
  priority: "" | TaskPriority;
  // new task form
  newTitle: string;
  newStatus: TaskStatus;
  newPriority: "" | TaskPriority;
  newTags: string;
  newDueAt: string;
  newNotes: string;
  busy: boolean;
  editId: string | null;
  editTitle: string;
  editStatus: TaskStatus;
  editPriority: "" | TaskPriority;
  editTags: string;
  editDueAt: string;
  editNotes: string;
};

const DEFAULT_STATE: TasksState = {
  loading: false,
  error: null,
  store: null,
  q: "",
  priority: "",
  newTitle: "",
  newStatus: "upcoming",
  newPriority: "P1",
  newTags: "",
  newDueAt: "",
  newNotes: "",
  busy: false,
  editId: null,
  editTitle: "",
  editStatus: "upcoming",
  editPriority: "",
  editTags: "",
  editDueAt: "",
  editNotes: "",
};

function resolveGatewayHttpAuthHeader(host: OpenClawApp): string | null {
  const deviceToken = host.hello?.auth?.deviceToken?.trim();
  if (deviceToken) {
    return `Bearer ${deviceToken}`;
  }
  const token = host.settings.token.trim();
  if (token) {
    return `Bearer ${token}`;
  }
  const password = host.password.trim();
  if (password) {
    return `Bearer ${password}`;
  }
  return null;
}

function buildGatewayHttpHeaders(host: OpenClawApp): Record<string, string> {
  const authorization = resolveGatewayHttpAuthHeader(host);
  return authorization ? { Authorization: authorization } : {};
}

function apiPath(host: TasksHost, path: string): string {
  const base = normalizeBasePath(host.basePath ?? "");
  return base ? `${base}${path}` : path;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function tagsToString(tags: string[] | undefined) {
  return Array.isArray(tags) ? tags.join(", ") : "";
}

function filterTask(t: Task, q: string, prio: string) {
  if (prio && (t.priority ?? "") !== prio) {
    return false;
  }
  if (!q) {
    return true;
  }
  const hay = [t.title, tagsToString(t.tags), t.notes ?? ""].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

function pill(text: string, cls = "") {
  return html`<span class="pill ${cls}">${text}</span>`;
}

function taskCard(props: {
  t: Task;
  onEdit: () => void;
  onDelete: () => void;
  onSetStatus: (s: TaskStatus) => void;
}) {
  const { t, onEdit, onDelete, onSetStatus } = props;
  const prioCls = t.priority ? `p${t.priority}` : "";
  return html`
    <div class="task">
      <div class="task__top">
        <div class="task__title">${t.title}</div>
        <div class="task__meta">
          ${t.priority ? pill(t.priority, prioCls) : nothing}
          ${pill(t.status)}
        </div>
      </div>
      <div class="task__sub">
        ${t.tags?.length ? pill(`tags:${t.tags.join(",")}`) : nothing}
        ${t.dueAt ? pill(`due:${t.dueAt}`) : nothing}
      </div>
      ${
        t.notes
          ? html`<details class="task__notes"><summary>Notes</summary><pre>${t.notes}</pre></details>`
          : nothing
      }
      <div class="task__actions">
        <button class="btn" @click=${() => onSetStatus("upcoming")}>Upcoming</button>
        <button class="btn" @click=${() => onSetStatus("in_progress")}>In progress</button>
        <button class="btn" @click=${() => onSetStatus("done")}>Done</button>
        <span class="spacer"></span>
        <button class="btn" @click=${onEdit}>Edit</button>
        <button class="btn btn--danger" @click=${onDelete}>Delete</button>
      </div>
    </div>
  `;
}

async function loadTasks(host: TasksHost) {
  const st: TasksState = host.tasksState ?? structuredClone(DEFAULT_STATE);
  st.loading = true;
  st.error = null;
  host.tasksState = st;
  host.requestUpdate();

  try {
    const res = await fetch(apiPath(host, "/api/tasks"), {
      method: "GET",
      headers: {
        ...buildGatewayHttpHeaders(host),
      },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as TaskStore | null;
    if (!res.ok || !data) {
      throw new Error(`Failed to load tasks (${res.status})`);
    }
    st.store = data;
  } catch (e: unknown) {
    st.error = e instanceof Error ? e.message : String(e);
  } finally {
    st.loading = false;
    host.tasksState = st;
    host.requestUpdate();
  }
}

async function createTask(host: TasksHost) {
  const st = host.tasksState;
  if (!st || st.busy) {
    return;
  }
  const title = st.newTitle.trim();
  if (!title) {
    st.error = "Title required";
    host.requestUpdate();
    return;
  }
  st.busy = true;
  st.error = null;
  host.requestUpdate();
  try {
    const res = await fetch(apiPath(host, "/api/tasks"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify({
        title,
        status: st.newStatus,
        priority: st.newPriority || undefined,
        tags: parseTags(st.newTags),
        dueAt: st.newDueAt.trim() || undefined,
        notes: st.newNotes.trim() || undefined,
      }),
    });
    const dataUnknown: unknown = await res.json().catch(() => null);
    const data = dataUnknown as { ok?: boolean; error?: string; store?: TaskStore } | null;
    if (!res.ok || !data || data.ok !== true || !data.store) {
      throw new Error(data?.error ?? `Create failed (${res.status})`);
    }
    st.newTitle = "";
    st.newTags = "";
    st.newDueAt = "";
    st.newNotes = "";
    st.store = data.store;
  } catch (e: unknown) {
    st.error = e instanceof Error ? e.message : String(e);
  } finally {
    st.busy = false;
    host.requestUpdate();
  }
}

function startEdit(host: TasksHost, t: Task) {
  const st = host.tasksState;
  if (!st) {
    return;
  }
  st.editId = t.id;
  st.editTitle = t.title;
  st.editStatus = t.status;
  st.editPriority = t.priority ?? "";
  st.editTags = tagsToString(t.tags);
  st.editDueAt = t.dueAt ?? "";
  st.editNotes = t.notes ?? "";
  host.requestUpdate();
}

function cancelEdit(host: TasksHost) {
  const st = host.tasksState;
  if (!st) {
    return;
  }
  st.editId = null;
  host.requestUpdate();
}

async function patchTask(host: TasksHost, id: string, patch: Partial<Task>) {
  const st = host.tasksState;
  if (!st || st.busy) {
    return;
  }
  st.busy = true;
  st.error = null;
  host.requestUpdate();
  try {
    const res = await fetch(apiPath(host, `/api/tasks/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...buildGatewayHttpHeaders(host),
      },
      body: JSON.stringify(patch),
    });
    const dataUnknown: unknown = await res.json().catch(() => null);
    const data = dataUnknown as { ok?: boolean; error?: string; store?: TaskStore } | null;
    if (!res.ok || !data || data.ok !== true || !data.store) {
      throw new Error(data?.error ?? `Update failed (${res.status})`);
    }
    st.store = data.store;
  } catch (e: unknown) {
    st.error = e instanceof Error ? e.message : String(e);
  } finally {
    st.busy = false;
    host.requestUpdate();
  }
}

async function deleteTask(host: TasksHost, id: string) {
  const st = host.tasksState;
  if (!st || st.busy) {
    return;
  }
  st.busy = true;
  st.error = null;
  host.requestUpdate();
  try {
    const res = await fetch(apiPath(host, `/api/tasks/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: {
        ...buildGatewayHttpHeaders(host),
      },
    });
    const dataUnknown: unknown = await res.json().catch(() => null);
    const data = dataUnknown as { ok?: boolean; error?: string; store?: TaskStore } | null;
    if (!res.ok || !data || data.ok !== true || !data.store) {
      throw new Error(data?.error ?? `Delete failed (${res.status})`);
    }
    st.store = data.store;
    if (st.editId === id) {
      st.editId = null;
    }
  } catch (e: unknown) {
    st.error = e instanceof Error ? e.message : String(e);
  } finally {
    st.busy = false;
    host.requestUpdate();
  }
}

export function ensureTasksState(host: TasksHost) {
  if (!host.tasksState) {
    host.tasksState = structuredClone(DEFAULT_STATE);
    void loadTasks(host);
  }
}

export function renderTasksTab(host: TasksHost): TemplateResult {
  ensureTasksState(host);
  const st = host.tasksState!;
  const tasks = st.store?.tasks ?? [];
  const filtered = tasks.filter((t) => filterTask(t, st.q.trim(), st.priority));

  const upcoming = filtered.filter((t) => t.status === "upcoming");
  const progress = filtered.filter((t) => t.status === "in_progress");
  const done = filtered.filter((t) => t.status === "done");

  const editTaskObj = st.editId ? (tasks.find((t) => t.id === st.editId) ?? null) : null;

  return html`
    <style>
      .tasks {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      input, select, textarea {
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
        color: inherit;
        padding: 10px 12px;
        border-radius: 10px;
        outline: none;
        min-width: 220px;
      }
      textarea { min-width: 420px; min-height: 70px; }
      .btn {
        background: rgba(122,162,255,0.15);
        border: 1px solid rgba(122,162,255,0.35);
        color: inherit;
        padding: 8px 10px;
        border-radius: 10px;
        cursor: pointer;
      }
      .btn--danger {
        background: rgba(255,107,107,0.12);
        border-color: rgba(255,107,107,0.35);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
      }
      @media (max-width: 980px) {
        .grid { grid-template-columns: 1fr; }
        textarea { min-width: 100%; }
      }
      .col {
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 14px;
        overflow: hidden;
      }
      .col h3 {
        margin: 0;
        padding: 12px 12px 10px;
        font-size: 12px;
        opacity: 0.9;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        display: flex;
        justify-content: space-between;
      }
      .list { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
      .task {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 10px;
      }
      .task__top { display:flex; justify-content: space-between; gap: 10px; }
      .task__title { font-weight: 650; }
      .task__meta { display:flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .task__sub { margin-top: 6px; display:flex; gap: 6px; flex-wrap: wrap; opacity: 0.9; }
      .task__actions { margin-top: 8px; display:flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .spacer { flex: 1; }
      .pill {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
      }
      .pP0 { border-color: rgba(255,107,107,0.55); }
      .pP1 { border-color: rgba(255,204,102,0.55); }
      .pP2 { border-color: rgba(122,162,255,0.55); }
      .pP3 { border-color: rgba(65,209,139,0.55); }
      pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; margin: 6px 0 0; }
      .danger { color: #ffd2d2; }
    </style>

    <div class="tasks">
      <div class="row">
        <button class="btn" @click=${() => loadTasks(host)}>${st.loading ? "Loading…" : "Refresh"}</button>
        <div>${st.store?.updatedAt ? `Updated: ${st.store.updatedAt}` : ""}</div>
        <div>${st.busy ? "Saving…" : ""}</div>
        ${st.error ? html`<div class="danger">${st.error}</div>` : nothing}
      </div>

      <div class="row">
        <input
          placeholder="Search title/tags/notes…"
          .value=${st.q}
          @input=${(e: Event) => {
            st.q = (e.target as HTMLInputElement | null)?.value ?? "";
            host.requestUpdate();
          }}
        />
        <select
          .value=${st.priority}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement | null)?.value ?? "";
            st.priority = v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
            host.requestUpdate();
          }}
        >
          <option value="">All priorities</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
      </div>

      <div class="col">
        <h3>Create task <span></span></h3>
        <div class="list">
          <div class="row">
            <input
              placeholder="Title"
              .value=${st.newTitle}
              @input=${(e: Event) => (st.newTitle = (e.target as HTMLInputElement | null)?.value ?? "")}
            />
            <select
              .value=${st.newStatus}
              @change=${(e: Event) =>
                (st.newStatus =
                  (e.target as HTMLSelectElement | null)?.value === "in_progress"
                    ? "in_progress"
                    : (e.target as HTMLSelectElement | null)?.value === "done"
                      ? "done"
                      : "upcoming")}
            >
              <option value="upcoming">upcoming</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
            </select>
            <select
              .value=${st.newPriority}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement | null)?.value ?? "";
                st.newPriority = v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
              }}
            >
              <option value="">(no priority)</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </div>
          <div class="row">
            <input
              placeholder="Tags (comma-separated)"
              .value=${st.newTags}
              @input=${(e: Event) => (st.newTags = (e.target as HTMLInputElement | null)?.value ?? "")}
            />
            <input
              placeholder="Due ISO (optional)"
              .value=${st.newDueAt}
              @input=${(e: Event) => (st.newDueAt = (e.target as HTMLInputElement | null)?.value ?? "")}
            />
          </div>
          <div class="row">
            <textarea
              placeholder="Notes"
              .value=${st.newNotes}
              @input=${(e: Event) => (st.newNotes = (e.target as HTMLTextAreaElement | null)?.value ?? "")}
            ></textarea>
          </div>
          <div class="row">
            <button class="btn" @click=${() => createTask(host)}>Add</button>
          </div>
        </div>
      </div>

      ${
        editTaskObj
          ? html`
            <div class="col">
              <h3>Edit task <span>${editTaskObj.id}</span></h3>
              <div class="list">
                <div class="row">
                  <input
                    placeholder="Title"
                    .value=${st.editTitle}
                    @input=${(e: Event) => (st.editTitle = (e.target as HTMLInputElement | null)?.value ?? "")}
                  />
                  <select
                    .value=${st.editStatus}
                    @change=${(e: Event) =>
                      (st.editStatus =
                        (e.target as HTMLSelectElement | null)?.value === "in_progress"
                          ? "in_progress"
                          : (e.target as HTMLSelectElement | null)?.value === "done"
                            ? "done"
                            : "upcoming")}
                  >
                    <option value="upcoming">upcoming</option>
                    <option value="in_progress">in_progress</option>
                    <option value="done">done</option>
                  </select>
                  <select
                    .value=${st.editPriority}
                    @change=${(e: Event) => {
                      const v = (e.target as HTMLSelectElement | null)?.value ?? "";
                      st.editPriority =
                        v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
                    }}
                  >
                    <option value="">(no priority)</option>
                    <option value="P0">P0</option>
                    <option value="P1">P1</option>
                    <option value="P2">P2</option>
                    <option value="P3">P3</option>
                  </select>
                </div>
                <div class="row">
                  <input
                    placeholder="Tags (comma-separated)"
                    .value=${st.editTags}
                    @input=${(e: Event) => (st.editTags = (e.target as HTMLInputElement | null)?.value ?? "")}
                  />
                  <input
                    placeholder="Due ISO (optional)"
                    .value=${st.editDueAt}
                    @input=${(e: Event) => (st.editDueAt = (e.target as HTMLInputElement | null)?.value ?? "")}
                  />
                </div>
                <div class="row">
                  <textarea
                    placeholder="Notes"
                    .value=${st.editNotes}
                    @input=${(e: Event) => (st.editNotes = (e.target as HTMLTextAreaElement | null)?.value ?? "")}
                  ></textarea>
                </div>
                <div class="row">
                  <button
                    class="btn"
                    @click=${() =>
                      patchTask(host, editTaskObj.id, {
                        title: st.editTitle,
                        status: st.editStatus,
                        priority: st.editPriority || undefined,
                        tags: parseTags(st.editTags),
                        dueAt: st.editDueAt.trim() || null,
                        notes: st.editNotes.trim() || null,
                      })}
                  >
                    Save
                  </button>
                  <button class="btn" @click=${() => cancelEdit(host)}>Cancel</button>
                </div>
              </div>
            </div>
          `
          : nothing
      }

      <div class="grid">
        <section class="col">
          <h3>Upcoming <span>${upcoming.length}</span></h3>
          <div class="list">
            ${upcoming.map((t) =>
              taskCard({
                t,
                onEdit: () => startEdit(host, t),
                onDelete: () => deleteTask(host, t.id),
                onSetStatus: (s) => patchTask(host, t.id, { status: s }),
              }),
            )}
          </div>
        </section>
        <section class="col">
          <h3>In Progress <span>${progress.length}</span></h3>
          <div class="list">
            ${progress.map((t) =>
              taskCard({
                t,
                onEdit: () => startEdit(host, t),
                onDelete: () => deleteTask(host, t.id),
                onSetStatus: (s) => patchTask(host, t.id, { status: s }),
              }),
            )}
          </div>
        </section>
        <section class="col">
          <h3>Done <span>${done.length}</span></h3>
          <div class="list">
            ${done.map((t) =>
              taskCard({
                t,
                onEdit: () => startEdit(host, t),
                onDelete: () => deleteTask(host, t.id),
                onSetStatus: (s) => patchTask(host, t.id, { status: s }),
              }),
            )}
          </div>
        </section>
      </div>
    </div>
  `;
}
