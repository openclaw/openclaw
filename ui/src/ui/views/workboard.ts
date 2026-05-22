import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  createWorkboardCard,
  deleteWorkboardCard,
  findWorkboardSession,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  startWorkboardCard,
  stopWorkboardCard,
  syncWorkboardLifecycle,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardLifecycle,
  type WorkboardPriority,
  type WorkboardStatus,
  type WorkboardUiState,
} from "../controllers/workboard.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { icons } from "../icons.ts";
import type { AgentsListResult, GatewaySessionRow } from "../types.ts";

type WorkboardProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  pluginEnabled: boolean;
  agentsList: AgentsListResult | null;
  sessions: GatewaySessionRow[];
  onOpenSession: (sessionKey: string) => void;
  onRequestUpdate?: () => void;
};

const STATUS_LABELS: Record<WorkboardStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  running: "Running",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

function formatTime(value: number | undefined): string {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function matchesFilter(
  card: WorkboardCard,
  options: { query: string; priority: "all" | WorkboardPriority },
): boolean {
  if (options.priority !== "all" && card.priority !== options.priority) {
    return false;
  }
  const query = options.query.trim().toLowerCase();
  if (!query) {
    return true;
  }
  return [card.title, card.notes, card.agentId, card.sessionKey, ...card.labels]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(query));
}

function nextPosition(cards: readonly WorkboardCard[], status: WorkboardStatus): number {
  const positions = cards.filter((card) => card.status === status).map((card) => card.position);
  return (positions.length ? Math.max(...positions) : 0) + 1000;
}

function renderDraft(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agents = props.agentsList?.agents ?? [];
  const sessions = props.sessions.filter((session) => !session.archived);
  if (!state.draftOpen) {
    return nothing;
  }
  return html`
    <form
      class="workboard-draft"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void createWorkboardCard({
          host: props.host,
          client: props.client,
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      <div class="workboard-draft__main">
        <input
          class="input workboard-draft__title"
          placeholder="Card title"
          .value=${state.draftTitle}
          @input=${(event: InputEvent) => {
            state.draftTitle = (event.currentTarget as HTMLInputElement).value;
            props.onRequestUpdate?.();
          }}
        />
        <textarea
          class="input workboard-draft__notes"
          placeholder="Notes, acceptance criteria, links"
          .value=${state.draftNotes}
          @input=${(event: InputEvent) => {
            state.draftNotes = (event.currentTarget as HTMLTextAreaElement).value;
            props.onRequestUpdate?.();
          }}
        ></textarea>
      </div>
      <div class="workboard-draft__meta">
        <select
          class="input"
          .value=${state.draftPriority}
          @change=${(event: Event) => {
            state.draftPriority = (event.currentTarget as HTMLSelectElement)
              .value as WorkboardPriority;
            props.onRequestUpdate?.();
          }}
        >
          ${WORKBOARD_PRIORITIES.map(
            (priority) => html`<option value=${priority}>${priority}</option>`,
          )}
        </select>
        <select
          class="input"
          .value=${state.draftAgentId}
          @change=${(event: Event) => {
            state.draftAgentId = (event.currentTarget as HTMLSelectElement).value;
            props.onRequestUpdate?.();
          }}
        >
          <option value="">Default agent</option>
          ${agents.map(
            (agent) =>
              html`<option value=${agent.id}>
                ${agent.name ?? agent.identity?.name ?? agent.id}
              </option>`,
          )}
        </select>
        <select
          class="input"
          .value=${state.draftSessionKey}
          @change=${(event: Event) => {
            state.draftSessionKey = (event.currentTarget as HTMLSelectElement).value;
            props.onRequestUpdate?.();
          }}
        >
          <option value="">${t("workboard.noLinkedSession")}</option>
          ${sessions.map(
            (session) =>
              html`<option value=${session.key}>
                ${session.displayName ?? session.label ?? session.key}
              </option>`,
          )}
        </select>
        <button class="btn primary" ?disabled=${state.loading || !state.draftTitle.trim()}>
          ${t("common.create")}
        </button>
        <button
          class="btn"
          type="button"
          @click=${() => {
            state.draftOpen = false;
            props.onRequestUpdate?.();
          }}
        >
          ${t("common.cancel")}
        </button>
      </div>
    </form>
  `;
}

function formatLifecycle(lifecycle: WorkboardLifecycle): {
  label: string;
  detail: string;
  tone: "blocked" | "done" | "idle" | "live";
} {
  switch (lifecycle.state) {
    case "running":
      return {
        label: t("workboard.lifecycleRunning"),
        detail: t("workboard.lifecycleRunningDetail"),
        tone: "live",
      };
    case "succeeded":
      return {
        label: t("workboard.lifecycleDone"),
        detail: t("workboard.lifecycleDoneDetail"),
        tone: "done",
      };
    case "failed":
      return {
        label: t("workboard.lifecycleNeedsReview"),
        detail: t("workboard.lifecycleNeedsReviewDetail"),
        tone: "blocked",
      };
    case "idle":
      return {
        label: t("workboard.lifecycleLinked"),
        detail: t("workboard.lifecycleIdleDetail"),
        tone: "idle",
      };
    case "missing":
      return {
        label: t("workboard.lifecycleMissing"),
        detail: t("workboard.lifecycleMissingDetail"),
        tone: "blocked",
      };
    case "unlinked":
      return {
        label: t("workboard.lifecycleUnlinked"),
        detail: t("workboard.lifecycleUnlinkedDetail"),
        tone: "idle",
      };
  }
  throw new Error("Unknown workboard lifecycle state.");
}

function renderLifecycle(card: WorkboardCard, sessions: readonly GatewaySessionRow[]) {
  const lifecycle = getWorkboardLifecycle(card, sessions);
  const formatted = formatLifecycle(lifecycle);
  const session = lifecycle.session;
  return html`
    <div class="workboard-card__lifecycle">
      <span class="workboard-lifecycle workboard-lifecycle--${formatted.tone}">
        ${formatted.label}
      </span>
      <span class="workboard-card__lifecycle-detail">
        ${session?.displayName ?? session?.label ?? formatted.detail}
      </span>
    </div>
  `;
}

function renderCard(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const session = findWorkboardSession(card, props.sessions);
  const busy = state.busyCardId === card.id;
  const syncing = state.syncingCardIds.has(card.id);
  const live = session?.hasActiveRun === true;
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy ? "workboard-card--busy" : ""}"
      draggable="true"
      @dragstart=${(event: DragEvent) => {
        state.draggedCardId = card.id;
        event.dataTransfer?.setData("text/plain", card.id);
        event.dataTransfer?.setDragImage(event.currentTarget as Element, 16, 16);
        props.onRequestUpdate?.();
      }}
      @dragend=${() => {
        state.draggedCardId = null;
        props.onRequestUpdate?.();
      }}
    >
      <div class="workboard-card__top">
        <span class="workboard-card__priority">${card.priority}</span>
        ${live ? html`<span class="workboard-live">live</span>` : nothing}
        ${syncing ? html`<span class="workboard-live">${t("common.saving")}</span>` : nothing}
      </div>
      <h3>${card.title}</h3>
      ${card.notes ? html`<p>${card.notes}</p>` : nothing} ${renderLifecycle(card, props.sessions)}
      ${card.labels.length
        ? html`<div class="workboard-labels">
            ${card.labels.map((label) => html`<span>${label}</span>`)}
          </div>`
        : nothing}
      <div class="workboard-card__meta">
        ${card.agentId ? html`<span>${card.agentId}</span>` : html`<span>default agent</span>`}
        <span>${formatTime(card.updatedAt)}</span>
      </div>
      <div class="workboard-card__actions">
        ${card.sessionKey
          ? html`
              <button
                class="icon-btn"
                title="Open session"
                @click=${() => props.onOpenSession(card.sessionKey!)}
              >
                ${icons.messageSquare}
              </button>
              ${live
                ? html`
                    <button
                      class="icon-btn"
                      title=${t("workboard.stopSession")}
                      ?disabled=${busy || !props.connected}
                      @click=${() =>
                        stopWorkboardCard({
                          host: props.host,
                          client: props.client,
                          card,
                          requestUpdate: props.onRequestUpdate,
                        })}
                    >
                      ${icons.stop}
                    </button>
                  `
                : nothing}
            `
          : html`
              <button
                class="icon-btn"
                title="Start session"
                ?disabled=${busy || !props.connected}
                @click=${async () => {
                  const key = await startWorkboardCard({
                    host: props.host,
                    client: props.client,
                    card,
                    requestUpdate: props.onRequestUpdate,
                  });
                  if (key) {
                    props.onOpenSession(key);
                  }
                }}
              >
                ${icons.play}
              </button>
            `}
        <button
          class="icon-btn"
          title="Delete card"
          ?disabled=${busy}
          @click=${() =>
            deleteWorkboardCard({
              host: props.host,
              client: props.client,
              cardId: card.id,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          ${icons.trash}
        </button>
      </div>
    </article>
  `;
}

function renderColumn(props: WorkboardProps, status: WorkboardStatus, cards: WorkboardCard[]) {
  const state = getWorkboardState(props.host);
  return html`
    <section
      class="workboard-column ${state.draggedCardId ? "workboard-column--drop" : ""}"
      @dragover=${(event: DragEvent) => {
        if (state.draggedCardId) {
          event.preventDefault();
        }
      }}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        const cardId = event.dataTransfer?.getData("text/plain") || state.draggedCardId;
        if (!cardId) {
          return;
        }
        void moveWorkboardCard({
          host: props.host,
          client: props.client,
          cardId,
          status,
          position: nextPosition(state.cards, status),
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      <div class="workboard-column__header">
        <h2>${STATUS_LABELS[status]}</h2>
        <span>${cards.length}</span>
      </div>
      <div class="workboard-column__cards">
        ${cards.length
          ? cards.map((card) => renderCard(props, card))
          : html`<div class="workboard-empty">Drop work here</div>`}
      </div>
    </section>
  `;
}

export function renderWorkboard(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  if (props.pluginEnabled) {
    void loadWorkboard({
      host: props.host,
      client: props.client,
      requestUpdate: props.onRequestUpdate,
    });
    void syncWorkboardLifecycle({
      host: props.host,
      client: props.client,
      sessions: props.sessions,
      requestUpdate: props.onRequestUpdate,
    });
  }

  if (!props.pluginEnabled) {
    return html`
      <section class="workboard">
        <div class="callout">
          ${t("workboard.disabledHelpStart")}
          <code>${t("workboard.enableConfigKey")}</code>${t("workboard.disabledHelpEnd")}
        </div>
      </section>
    `;
  }

  const filtered = state.cards.filter((card) =>
    matchesFilter(card, { query: state.query, priority: state.priorityFilter }),
  );
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of state.statuses) {
    byStatus.set(status, []);
  }
  for (const card of filtered) {
    byStatus.get(card.status)?.push(card);
  }

  return html`
    <section class="workboard">
      <div class="workboard-toolbar">
        <div class="workboard-toolbar__filters">
          <input
            class="input"
            type="search"
            placeholder="Search cards"
            .value=${state.query}
            @input=${(event: InputEvent) => {
              state.query = (event.currentTarget as HTMLInputElement).value;
              props.onRequestUpdate?.();
            }}
          />
          <select
            class="input"
            .value=${state.priorityFilter}
            @change=${(event: Event) => {
              state.priorityFilter = (event.currentTarget as HTMLSelectElement)
                .value as WorkboardUiState["priorityFilter"];
              props.onRequestUpdate?.();
            }}
          >
            <option value="all">All priorities</option>
            ${WORKBOARD_PRIORITIES.map(
              (priority) => html`<option value=${priority}>${priority}</option>`,
            )}
          </select>
        </div>
        <div class="workboard-toolbar__actions">
          <button
            class="btn"
            ?disabled=${state.loading}
            @click=${() =>
              loadWorkboard({
                host: props.host,
                client: props.client,
                requestUpdate: props.onRequestUpdate,
                force: true,
              })}
          >
            ${state.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
          <button
            class="btn primary"
            @click=${() => {
              state.draftOpen = true;
              props.onRequestUpdate?.();
            }}
          >
            ${icons.plus} New card
          </button>
        </div>
      </div>
      ${state.error ? html`<div class="callout danger">${state.error}</div>` : nothing}
      ${renderDraft(props)}
      <div class="workboard-board">
        ${state.statuses.map((status) => renderColumn(props, status, byStatus.get(status) ?? []))}
      </div>
    </section>
  `;
}
