import { html } from "lit";

const TASK_STORE_KEY = "openclaw.tasks.v1";

type TaskItem = {
  id: string;
  title: string;
  lane: "client" | "notino" | "vectra";
  priority: "P0" | "P1" | "P2" | "P3";
  nextAction?: string;
  due?: string;
};

type TaskStore = {
  topOutcomes: string[];
  tasks: TaskItem[];
};

function loadStore(): TaskStore {
  if (typeof window === "undefined") {
    return { topOutcomes: [], tasks: [] };
  }
  try {
    const raw = window.localStorage.getItem(TASK_STORE_KEY);
    if (!raw) {
      return { topOutcomes: [], tasks: [] };
    }
    const parsed = JSON.parse(raw) as Partial<TaskStore>;
    return {
      topOutcomes: Array.isArray(parsed.topOutcomes)
        ? parsed.topOutcomes.filter((entry) => typeof entry === "string")
        : [],
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks.filter((task) => task && typeof task === "object") as TaskItem[]
        : [],
    };
  } catch {
    return { topOutcomes: [], tasks: [] };
  }
}

function laneLabel(lane: TaskItem["lane"]): string {
  if (lane === "client") {
    return "Client Delivery";
  }
  if (lane === "notino") {
    return "Notino";
  }
  return "Vectra / Algovectra";
}

function renderTaskList(tasks: TaskItem[]) {
  if (tasks.length === 0) {
    return html`<div class="muted">No tasks yet.</div>`;
  }
  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Priority</th>
            <th>Task</th>
            <th>Lane</th>
            <th>Next Action</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(
            (task) => html`
              <tr>
                <td><span class="mono">${task.priority}</span></td>
                <td>${task.title}</td>
                <td>${laneLabel(task.lane)}</td>
                <td>${task.nextAction || "—"}</td>
                <td>${task.due || "—"}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export function renderTasks() {
  const store = loadStore();
  const topOutcomes = store.topOutcomes.slice(0, 3);
  const prioritized = [...store.tasks].sort((a, b) => a.priority.localeCompare(b.priority));
  const byLane = {
    client: prioritized.filter((task) => task.lane === "client"),
    notino: prioritized.filter((task) => task.lane === "notino"),
    vectra: prioritized.filter((task) => task.lane === "vectra"),
  };

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">Weekly Top 3 Outcomes</div>
        <div class="card-sub">Locked outcomes for the current week.</div>
        <ol style="margin: 12px 0 0 18px; padding: 0;">
          ${topOutcomes.length > 0
            ? topOutcomes.map((outcome) => html`<li style="margin-bottom: 8px;">${outcome}</li>`)
            : html`<li class="muted">No outcomes saved yet.</li>`}
        </ol>
      </div>

      <div class="card">
        <div class="card-title">Task Intake Model</div>
        <div class="card-sub">Current sources this tab is designed for.</div>
        <ul style="margin: 12px 0 0 18px; padding: 0;">
          <li>GitHub issues</li>
          <li>Markdown task notes in repos</li>
          <li>Email-derived action items</li>
          <li>Google Drive shared docs</li>
        </ul>
        <div class="callout" style="margin-top: 14px;">
          This is v1 and currently reads from browser local storage key
          <span class="mono">${TASK_STORE_KEY}</span>. Next step is wiring this to a persistent
          gateway-backed task store.
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div class="card-title">Prioritized Backlog</div>
        <div class="card-sub">P0 highest priority → P3 lowest priority.</div>
        ${renderTaskList(prioritized)}
      </div>

      <div class="card">
        <div class="card-title">Client Delivery Lane</div>
        ${renderTaskList(byLane.client)}
      </div>

      <div class="card">
        <div class="card-title">Notino Lane</div>
        ${renderTaskList(byLane.notino)}
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div class="card-title">Vectra / Algovectra Lane</div>
        ${renderTaskList(byLane.vectra)}
      </div>
    </section>
  `;
}
