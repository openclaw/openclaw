import { html, nothing } from "lit";
import { formatAgo } from "../format.ts";
import type { TaskQueueSnapshot } from "../types.ts";

const DEFAULT_COLUMNS = [
  {
    title: "Proposed",
    hint: "Awaiting approval.",
  },
  {
    title: "Approved",
    hint: "Approved but not started.",
  },
  {
    title: "In Progress",
    hint: "Currently active work.",
  },
  {
    title: "Blocked",
    hint: "Waiting on dependencies.",
  },
  {
    title: "Done",
    hint: "Completed work.",
  },
];

export type TaskQueueProps = {
  loading: boolean;
  error: string | null;
  snapshot: TaskQueueSnapshot | null;
  onRefresh: () => void;
};

function resolveColumns(snapshot: TaskQueueSnapshot | null) {
  if (!snapshot) {
    return DEFAULT_COLUMNS.map((col) => ({ ...col, id: col.title, cards: [] }));
  }
  const listOrder = snapshot.lists.filter((list) => !list.closed);
  const cardsByList = new Map<string, TaskQueueSnapshot["cards"]>();
  for (const card of snapshot.cards) {
    const bucket = cardsByList.get(card.listId) ?? [];
    bucket.push(card);
    cardsByList.set(card.listId, bucket);
  }
  return listOrder.map((list) => ({
    id: list.id,
    title: list.name,
    hint: DEFAULT_COLUMNS.find((col) => col.title === list.name)?.hint ?? "",
    cards: cardsByList.get(list.id) ?? [],
  }));
}

export function renderTaskQueue(props: TaskQueueProps) {
  const snapshot = props.snapshot;
  const columns = resolveColumns(snapshot);
  const lastUpdated = snapshot?.fetchedAt ? formatAgo(snapshot.fetchedAt) : "n/a";
  const boardName = snapshot?.board?.name ?? "Trello Board";
  const boardUrl = snapshot?.board?.url ?? "https://trello.com";

  return html`
    <div class="card">
      <div class="card-title">Task Queue</div>
      <div class="card-sub">
        Trello remains the source of truth for approvals and work items. This view mirrors the
        Trello board and provides a read-only snapshot for now.
      </div>
      <div style="margin-top: 12px; display: flex; align-items: center; gap: 12px">
        <a class="session-link" href="${boardUrl}" target="_blank" rel="noreferrer"
          >${boardName}</a
        >
        <span class="muted">Updated ${lastUpdated}</span>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>Refresh</button>
      </div>
      ${
        props.error
          ? html`<div class="pill danger" style="margin-top: 12px">${props.error}</div>`
          : nothing
      }
    </div>

    <div
      style="margin-top: 16px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));"
    >
      ${columns.map(
        (column) => html`
          <div class="card">
            <div class="card-title">${column.title}</div>
            ${column.hint ? html`<div class="card-sub">${column.hint}</div>` : nothing}
            ${
              column.cards.length === 0
                ? html`
                    <div class="muted" style="margin-top: 12px">No items.</div>
                  `
                : html`
                  <div style="margin-top: 12px; display: grid; gap: 8px">
                    ${column.cards.map(
                      (card) => html`
                        <div>
                          ${
                            card.url
                              ? html`
                                <a class="session-link" href="${card.url}" target="_blank" rel="noreferrer"
                                  >${card.name}</a
                                >
                              `
                              : html`<span>${card.name}</span>`
                          }
                        </div>
                      `,
                    )}
                  </div>
                `
            }
          </div>
        `,
      )}
    </div>
  `;
}
