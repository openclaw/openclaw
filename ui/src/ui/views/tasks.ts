import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { normalizeBasePath } from "../navigation.ts";

type TasksHost = AppViewState & {
  requestUpdate: () => void;
  tasksState?: TasksState;
};

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

function resolveGatewayHttpAuthHeader(host: TasksHost): string | null {
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

function buildGatewayHttpHeaders(host: TasksHost): Record<string, string> {
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

async function saveEdit(host: TasksHost) {
  const st = host.tasksState;
  if (!st || !st.editId) {
    return;
  }
  const id = st.editId;
  await patchTask(host, id, {
    title: st.editTitle.trim(),
    status: st.editStatus,
    priority: st.editPriority || undefined,
    tags: parseTags(st.editTags),
    dueAt: st.editDueAt.trim() || null,
    notes: st.editNotes.trim() || null,
  });
  st.editId = null;
  host.requestUpdate();
}

export function ensureTasksState(host: AppViewState) {
  const h = host as TasksHost;
  if (!h.tasksState) {
    h.tasksState = structuredClone(DEFAULT_STATE);
    void loadTasks(h);
  }
}

export function renderTasksTab(host: AppViewState): TemplateResult {
  const h = host as TasksHost;
  ensureTasksState(host);
  const st = h.tasksState!;
  const tasks = st.store?.tasks ?? [];
  const filtered = tasks.filter((t) => filterTask(t, st.q.trim(), st.priority));

  const upcoming = filtered.filter((t) => t.status === "upcoming");
  const inProgress = filtered.filter((t) => t.status === "in_progress");
  const done = filtered.filter((t) => t.status === "done");

  const editing = st.editId ? tasks.find((t) => t.id === st.editId) ?? null : null;

  return html`
    <style>
      .tasks {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .col {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .split {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 1100px) {
        .split {
          grid-template-columns: 1fr;
        }
      }
      .task {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        background: var(--panel);
      }
      .task__top {
        display: flex;
        justify-content: space-between;
        gap: 10px;
      }
      .task__title {
        font-weight: 600;
      }
      .task__meta {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }
      .task__sub {
        margin-top: 6px;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        color: var(--muted);
      }
      .task__actions {
        margin-top: 10px;
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .task__notes pre {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 8px;
        background: var(--panel2);
        border-radius: 8px;
        border: 1px solid var(--border);
      }
      .pill.pP0,
      .pill.pP1,
      .pill.pP2,
      .pill.pP3 {
        font-weight: 700;
      }
      .pill.pP0 {
        background: #ff3b30;
        color: white;
      }
      .pill.pP1 {
        background: #ff9500;
        color: #111;
      }
      .pill.pP2 {
        background: #34c759;
        color: #111;
      }
      .pill.pP3 {
        background: #0a84ff;
        color: white;
      }
      .panel {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        background: var(--panel);
      }
      .panel h3 {
        margin: 0 0 10px 0;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field label {
        color: var(--muted);
        font-size: 12px;
      }
      input,
      select,
      textarea {
        padding: 8px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--panel2);
        color: var(--text);
      }
      textarea {
        min-height: 120px;
      }
      .spacer {
        flex: 1;
      }
      .danger {
        color: var(--danger);
      }
    </style>

    <div class="tasks">
      <div class="row">
        <button class="btn" @click=${() => loadTasks(h)}>${st.loading ? "Loading…" : "Refresh"}</button>
        <div>${st.store?.updatedAt ? `Updated: ${st.store.updatedAt}` : ""}</div>
        <div>${st.busy ? "Saving…" : ""}</div>
        ${st.error ? html`<div class="danger">${st.error}</div>` : nothing}
      </div>

      <div class="row">
        <input
          placeholder="Search"
          .value=${st.q}
          @input=${(e: Event) => {
            st.q = (e.target as HTMLInputElement | null)?.value ?? "";
            h.requestUpdate();
          }}
        />
        <select
          .value=${st.priority}
          @change=${(e: Event) => {
            const v = (e.target as HTMLSelectElement | null)?.value ?? "";
            st.priority = v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
            h.requestUpdate();
          }}
        >
          <option value="">All priorities</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
        <div>${filtered.length} shown / ${tasks.length} total</div>
      </div>

      <div class="panel">
        <h3>New task</h3>
        <div class="row">
          <div class="field" style="flex: 2; min-width: 260px;">
            <label>Title</label>
            <input
              placeholder="Ship tasks tab"
              .value=${st.newTitle}
              @input=${(e: Event) => {
                st.newTitle = (e.target as HTMLInputElement | null)?.value ?? "";
                h.requestUpdate();
              }}
            />
          </div>
          <div class="field">
            <label>Status</label>
            <select
              .value=${st.newStatus}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement | null)?.value ?? "upcoming";
                st.newStatus = v === "in_progress" || v === "done" ? v : "upcoming";
                h.requestUpdate();
              }}
            >
              <option value="upcoming">upcoming</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
            </select>
          </div>
          <div class="field">
            <label>Priority</label>
            <select
              .value=${st.newPriority}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement | null)?.value ?? "";
                st.newPriority = v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
                h.requestUpdate();
              }}
            >
              <option value="">(none)</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field" style="flex: 2; min-width: 260px;">
            <label>Tags (comma-separated)</label>
            <input
              placeholder="ui, gateway"
              .value=${st.newTags}
              @input=${(e: Event) => {
                st.newTags = (e.target as HTMLInputElement | null)?.value ?? "";
                h.requestUpdate();
              }}
            />
          </div>
          <div class="field" style="flex: 1; min-width: 200px;">
            <label>Due (ISO)</label>
            <input
              placeholder="2026-03-10T00:00:00Z"
              .value=${st.newDueAt}
              @input=${(e: Event) => {
                st.newDueAt = (e.target as HTMLInputElement | null)?.value ?? "";
                h.requestUpdate();
              }}
            />
          </div>
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea
            .value=${st.newNotes}
            @input=${(e: Event) => {
              st.newNotes = (e.target as HTMLTextAreaElement | null)?.value ?? "";
              h.requestUpdate();
            }}
          ></textarea>
        </div>
        <div class="row" style="margin-top: 10px;">
          <button class="btn" ?disabled=${st.busy} @click=${() => createTask(h)}>
            ${st.busy ? "Saving…" : "Create"}
          </button>
        </div>
      </div>

      ${
        editing
          ? html`
              <div class="panel">
                <h3>Edit task</h3>
                <div class="row">
                  <div class="field" style="flex: 2; min-width: 260px;">
                    <label>Title</label>
                    <input
                      .value=${st.editTitle}
                      @input=${(e: Event) => {
                        st.editTitle = (e.target as HTMLInputElement | null)?.value ?? "";
                        h.requestUpdate();
                      }}
                    />
                  </div>
                  <div class="field">
                    <label>Status</label>
                    <select
                      .value=${st.editStatus}
                      @change=${(e: Event) => {
                        const v = (e.target as HTMLSelectElement | null)?.value ?? "upcoming";
                        st.editStatus = v === "in_progress" || v === "done" ? v : "upcoming";
                        h.requestUpdate();
                      }}
                    >
                      <option value="upcoming">upcoming</option>
                      <option value="in_progress">in_progress</option>
                      <option value="done">done</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Priority</label>
                    <select
                      .value=${st.editPriority}
                      @change=${(e: Event) => {
                        const v = (e.target as HTMLSelectElement | null)?.value ?? "";
                        st.editPriority = v === "P0" || v === "P1" || v === "P2" || v === "P3" ? v : "";
                        h.requestUpdate();
                      }}
                    >
                      <option value="">(none)</option>
                      <option value="P0">P0</option>
                      <option value="P1">P1</option>
                      <option value="P2">P2</option>
                      <option value="P3">P3</option>
                    </select>
                  </div>
                </div>
                <div class="row">
                  <div class="field" style="flex: 2; min-width: 260px;">
                    <label>Tags</label>
                    <input
                      .value=${st.editTags}
                      @input=${(e: Event) => {
                        st.editTags = (e.target as HTMLInputElement | null)?.value ?? "";
                        h.requestUpdate();
                      }}
                    />
                  </div>
                  <div class="field" style="flex: 1; min-width: 200px;">
                    <label>Due (ISO)</label>
                    <input
                      .value=${st.editDueAt}
                      @input=${(e: Event) => {
                        st.editDueAt = (e.target as HTMLInputElement | null)?.value ?? "";
                        h.requestUpdate();
                      }}
                    />
                  </div>
                </div>
                <div class="field">
                  <label>Notes</label>
                  <textarea
                    .value=${st.editNotes}
                    @input=${(e: Event) => {
                      st.editNotes = (e.target as HTMLTextAreaElement | null)?.value ?? "";
                      h.requestUpdate();
                    }}
                  ></textarea>
                </div>
                <div class="row" style="margin-top: 10px;">
                  <button class="btn" ?disabled=${st.busy} @click=${() => saveEdit(h)}>
                    ${st.busy ? "Saving…" : "Save"}
                  </button>
                  <button class="btn" ?disabled=${st.busy} @click=${() => cancelEdit(h)}>Cancel</button>
                </div>
              </div>
            `
          : nothing
      }

      <div class="split">
        <div class="col">
          <div class="panel"><h3>Upcoming (${upcoming.length})</h3></div>
          ${upcoming.map((t) =>
            taskCard({
              t,
              onEdit: () => startEdit(h, t),
              onDelete: () => deleteTask(h, t.id),
              onSetStatus: (s) => patchTask(h, t.id, { status: s }),
            }),
          )}
        </div>
        <div class="col">
          <div class="panel"><h3>In progress (${inProgress.length})</h3></div>
          ${inProgress.map((t) =>
            taskCard({
              t,
              onEdit: () => startEdit(h, t),
              onDelete: () => deleteTask(h, t.id),
              onSetStatus: (s) => patchTask(h, t.id, { status: s }),
            }),
          )}
        </div>
        <div class="col">
          <div class="panel"><h3>Done (${done.length})</h3></div>
          ${done.map((t) =>
            taskCard({
              t,
              onEdit: () => startEdit(h, t),
              onDelete: () => deleteTask(h, t.id),
              onSetStatus: (s) => patchTask(h, t.id, { status: s }),
            }),
          )}
        </div>
      </div>
    </div>
  `;
}
