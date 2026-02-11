import { html } from "lit";
import {
  TASK_STORE_KEY,
  laneLabel,
  loadTaskStore,
  saveTaskStore,
  sortByPriority,
  type TaskItem,
  type TaskLane,
  type TaskPriority,
} from "../tasks-store.ts";

function renderTaskList(tasks: TaskItem[]) {
  if (tasks.length === 0) {
    return html`<div class="muted">No tasks yet.</div>`;
  }

  return html`
    <div
      style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 8px;"
    >
      ${tasks.map(
        (task) => html`
          <article class="card" style="margin: 0; padding: 12px;">
            <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span class="pill"><span>Priority</span><span class="mono">${task.priority}</span></span>
              <span class="pill"><span>Lane</span><span class="mono">${laneLabel(task.lane)}</span></span>
            </div>
            <div style="font-weight: 600; margin-bottom: 6px;">${task.title}</div>
            <div class="muted" style="margin-bottom: 8px;">Project: ${task.project || "General"}</div>
            <div style="font-size: 13px; margin-bottom: 6px;"><strong>Agent:</strong> ${task.assignedAgent || "unassigned"}</div>
            <div style="font-size: 13px; margin-bottom: 6px;"><strong>Next:</strong> ${task.nextAction || "—"}</div>
            <div style="font-size: 13px;"><strong>Due:</strong> ${task.due || "—"}</div>
          </article>
        `,
      )}
    </div>
  `;
}

function promptNewTask(): TaskItem | null {
  const title = (window.prompt("Task title") || "").trim();
  if (!title) {
    return null;
  }
  const project = (window.prompt("Project (e.g. Mentem / ISOTRA / Pooltechnika / Notino / Vectra)") || "").trim();
  const laneRaw = (window.prompt("Lane: client | notino | vectra", "client") || "client").trim();
  const lane: TaskLane =
    laneRaw === "notino" || laneRaw === "vectra" || laneRaw === "client" ? laneRaw : "client";
  const priorityRaw =
    (window.prompt("Priority: P0 | P1 | P2 | P3", "P2") || "P2").trim().toUpperCase();
  const priority: TaskPriority =
    priorityRaw === "P0" || priorityRaw === "P1" || priorityRaw === "P2" || priorityRaw === "P3"
      ? priorityRaw
      : "P2";
  const assignedAgent = (window.prompt("Assigned agent (optional)") || "").trim();
  const nextAction = (window.prompt("Next action (optional)") || "").trim();
  const due = (window.prompt("Due date/time (optional)") || "").trim();
  const showInChat =
    (window.prompt("Show in Active Tasks on chat? yes/no", "yes") || "yes").trim().toLowerCase() ===
    "yes";

  return {
    id: `task-${Date.now()}`,
    title,
    project: project || undefined,
    lane,
    priority,
    assignedAgent: assignedAgent || undefined,
    nextAction: nextAction || undefined,
    due: due || undefined,
    activeOnChat: showInChat,
  };
}

export function renderTasks() {
  const store = loadTaskStore();
  const topOutcomes = store.topOutcomes.slice(0, 3);
  const prioritized = sortByPriority(store.tasks);
  const byLane = {
    client: prioritized.filter((task) => task.lane === "client"),
    notino: prioritized.filter((task) => task.lane === "notino"),
    vectra: prioritized.filter((task) => task.lane === "vectra"),
  };

  return html`
    <section class="grid grid-cols-2">
      <div class="card" style="grid-column: 1 / -1;">
        <div class="row" style="justify-content: space-between; align-items: center;">
          <div>
            <div class="card-title">Current Endeavor</div>
            <div class="card-sub">Your main active mission right now.</div>
          </div>
          <button
            class="btn btn--sm"
            @click=${() => {
              const next = (window.prompt("Set current endeavor", store.currentEndeavor || "") || "").trim();
              const status =
                (window.prompt("Set endeavor status (e.g. In Progress / Blocked / Review)", store.currentEndeavorStatus || "") || "").trim();
              const eta =
                (window.prompt("Set estimated delivery (e.g. 2d / Friday EOD / 2026-02-14)", store.currentEndeavorEta || "") || "").trim();
              const updated = {
                ...store,
                currentEndeavor: next,
                currentEndeavorStatus: status,
                currentEndeavorEta: eta,
              };
              saveTaskStore(updated);
              window.location.reload();
            }}
          >
            Set Endeavor
          </button>
        </div>

        <div class="callout" style="margin-top: 12px;">
          <div style="font-weight: 600; margin-bottom: 6px;">Main Activity</div>
          ${store.currentEndeavor
            ? html`<div style="margin-bottom: 8px;"><strong>${store.currentEndeavor}</strong></div>`
            : html`<div class="muted" style="margin-bottom: 8px;">No current endeavor set. Suggestion: "Rook + Martin: AI-first task system"</div>`}
          <div class="row" style="gap: 10px; flex-wrap: wrap;">
            <span class="pill"><span>Status</span><span class="mono">${store.currentEndeavorStatus || "n/a"}</span></span>
            <span class="pill"><span>ETA</span><span class="mono">${store.currentEndeavorEta || "n/a"}</span></span>
          </div>
        </div>
      </div>

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
        <div class="row" style="justify-content: space-between; align-items: center;">
          <div>
            <div class="card-title">Task Intake Model</div>
            <div class="card-sub">Create and visualize all tasks quickly.</div>
          </div>
          <button
            class="btn btn--sm"
            @click=${() => {
              const task = promptNewTask();
              if (!task) {
                return;
              }
              const updated = {
                ...store,
                tasks: [task, ...store.tasks],
              };
              saveTaskStore(updated);
              window.location.reload();
            }}
          >
            + New Task
          </button>
        </div>
        <ul style="margin: 12px 0 0 18px; padding: 0;">
          <li>GitHub issues</li>
          <li>Markdown task notes in repos</li>
          <li>Email-derived action items</li>
          <li>Google Drive shared docs</li>
        </ul>
        <div class="callout" style="margin-top: 14px;">
          Current local key: <span class="mono">${TASK_STORE_KEY}</span>
        </div>
      </div>

      <div class="card" style="grid-column: 1 / -1;">
        <div class="card-title">All Tasks</div>
        <div class="card-sub">Everything currently tracked.</div>
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
