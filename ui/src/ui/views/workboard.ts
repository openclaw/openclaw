import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  deleteWorkboardCard,
  findWorkboardSession,
  getWorkboardLifecycle,
  getWorkboardState,
  loadWorkboard,
  moveWorkboardCard,
  saveWorkboardCardDraft,
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

const WORKBOARD_GAME_SIZE = 5;
const WORKBOARD_GAME_GOAL = WORKBOARD_GAME_SIZE * WORKBOARD_GAME_SIZE - 1;
const WORKBOARD_GAME_BLOCKERS = new Set([6, 8, 12, 16, 18]);

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

function isWorkboardSessionChoice(session: GatewaySessionRow): boolean {
  if (session.archived || session.kind === "global") {
    return false;
  }
  const raw = [session.key, session.label, session.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(":")
    .toLowerCase();
  return !/(^|:)heartbeat(:|$)/.test(raw);
}

function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea"))
    : false;
}

function openCardSession(
  props: Pick<WorkboardProps, "onOpenSession">,
  card: WorkboardCard,
): boolean {
  if (!card.sessionKey) {
    return false;
  }
  props.onOpenSession(card.sessionKey);
  return true;
}

function resetDraft(state: WorkboardUiState) {
  state.draftOpen = false;
  state.editingCardId = null;
  state.draftTitle = "";
  state.draftNotes = "";
  state.draftStatus = "todo";
  state.draftPriority = "normal";
  state.draftLabels = "";
  state.draftAgentId = "";
  state.draftSessionKey = "";
}

function openCreateModal(state: WorkboardUiState) {
  resetDraft(state);
  state.draftOpen = true;
}

function resetGame(state: WorkboardUiState) {
  state.gamePlayerIndex = 0;
  state.gameMoves = 0;
  state.gameMessage = "workboard.gameStart";
}

function moveGamePlayer(state: WorkboardUiState, delta: number) {
  if (state.gamePlayerIndex === WORKBOARD_GAME_GOAL) {
    resetGame(state);
  }
  const currentRow = Math.floor(state.gamePlayerIndex / WORKBOARD_GAME_SIZE);
  const nextIndex = state.gamePlayerIndex + delta;
  const nextRow = Math.floor(nextIndex / WORKBOARD_GAME_SIZE);
  if (
    nextIndex < 0 ||
    nextIndex > WORKBOARD_GAME_GOAL ||
    (delta === -1 && nextRow !== currentRow) ||
    (delta === 1 && nextRow !== currentRow)
  ) {
    state.gameMessage = "workboard.gameBoundary";
    return;
  }
  if (WORKBOARD_GAME_BLOCKERS.has(nextIndex)) {
    state.gameMessage = "workboard.gameBlocked";
    return;
  }
  state.gamePlayerIndex = nextIndex;
  state.gameMoves += 1;
  state.gameMessage =
    nextIndex === WORKBOARD_GAME_GOAL ? "workboard.gameWin" : "workboard.gameContinue";
  if (nextIndex === WORKBOARD_GAME_GOAL) {
    state.gameWins += 1;
  }
}

function openEditModal(state: WorkboardUiState, card: WorkboardCard) {
  state.draftOpen = true;
  state.editingCardId = card.id;
  state.draftTitle = card.title;
  state.draftNotes = card.notes ?? "";
  state.draftStatus = card.status;
  state.draftPriority = card.priority;
  state.draftLabels = card.labels.join(", ");
  state.draftAgentId = card.agentId ?? "";
  state.draftSessionKey = card.sessionKey ?? "";
}

function renderGameArrow(
  label: string,
  className: string,
  delta: number,
  props: Pick<WorkboardProps, "host" | "onRequestUpdate">,
) {
  const state = getWorkboardState(props.host);
  return html`
    <button
      class="btn btn--icon workboard-game__arrow ${className}"
      type="button"
      title=${label}
      aria-label=${label}
      @click=${() => {
        moveGamePlayer(state, delta);
        props.onRequestUpdate?.();
      }}
    >
      ${icons.arrowDown}
    </button>
  `;
}

function renderGameModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  if (!state.gameOpen) {
    return nothing;
  }
  return html`
    <div
      class="workboard-modal"
      role="presentation"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          state.gameOpen = false;
          props.onRequestUpdate?.();
        }
      }}
    >
      <div
        class="workboard-game"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workboard-game-title"
        tabindex="0"
        @keydown=${(event: KeyboardEvent) => {
          const moves: Record<string, number> = {
            ArrowDown: WORKBOARD_GAME_SIZE,
            ArrowLeft: -1,
            ArrowRight: 1,
            ArrowUp: -WORKBOARD_GAME_SIZE,
          };
          const delta = moves[event.key];
          if (typeof delta !== "number") {
            return;
          }
          event.preventDefault();
          moveGamePlayer(state, delta);
          props.onRequestUpdate?.();
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id="workboard-game-title">${t("workboard.gameTitle")}</h2>
            <p>${t(state.gameMessage)}</p>
          </div>
          <button
            class="btn btn--icon workboard-card__icon"
            type="button"
            title=${t("common.cancel")}
            @click=${() => {
              state.gameOpen = false;
              props.onRequestUpdate?.();
            }}
          >
            ${icons.x}
          </button>
        </div>
        <div class="workboard-game__stats">
          <span>${t("workboard.gameMoves", { count: String(state.gameMoves) })}</span>
          <span>${t("workboard.gameWins", { count: String(state.gameWins) })}</span>
        </div>
        <div class="workboard-game__grid" role="grid" aria-label=${t("workboard.gameBoard")}>
          ${Array.from({ length: WORKBOARD_GAME_SIZE * WORKBOARD_GAME_SIZE }, (_, index) => {
            const player = index === state.gamePlayerIndex;
            const goal = index === WORKBOARD_GAME_GOAL;
            const blocker = WORKBOARD_GAME_BLOCKERS.has(index);
            return html`
              <div
                class="workboard-game__cell ${player ? "workboard-game__cell--player" : ""} ${goal
                  ? "workboard-game__cell--goal"
                  : ""} ${blocker ? "workboard-game__cell--blocker" : ""}"
                role="gridcell"
                aria-label=${player
                  ? t("workboard.gameAgent")
                  : goal
                    ? t("workboard.gameLaunch")
                    : blocker
                      ? t("workboard.gameBlockedCell")
                      : t("workboard.gameOpenCell")}
              >
                ${player ? "A" : goal ? "L" : blocker ? "" : ""}
              </div>
            `;
          })}
        </div>
        <div class="workboard-game__controls" aria-label=${t("workboard.gameControls")}>
          ${renderGameArrow(
            t("workboard.gameMoveUp"),
            "workboard-game__arrow--up",
            -WORKBOARD_GAME_SIZE,
            props,
          )}
          ${renderGameArrow(t("workboard.gameMoveLeft"), "workboard-game__arrow--left", -1, props)}
          ${renderGameArrow(t("workboard.gameMoveDown"), "", WORKBOARD_GAME_SIZE, props)}
          ${renderGameArrow(t("workboard.gameMoveRight"), "workboard-game__arrow--right", 1, props)}
        </div>
        <div class="workboard-modal__actions">
          <button
            class="btn"
            type="button"
            @click=${() => {
              resetGame(state);
              props.onRequestUpdate?.();
            }}
          >
            ${t("common.reset")}
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderCardModal(props: WorkboardProps) {
  const state = getWorkboardState(props.host);
  const agents = props.agentsList?.agents ?? [];
  const sessions = props.sessions.filter(isWorkboardSessionChoice);
  if (!state.draftOpen) {
    return nothing;
  }
  const editing = Boolean(state.editingCardId);
  return html`
    <div
      class="workboard-modal"
      role="presentation"
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) {
          resetDraft(state);
          props.onRequestUpdate?.();
        }
      }}
    >
      <form
        class="workboard-draft"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workboard-card-modal-title"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void saveWorkboardCardDraft({
            host: props.host,
            client: props.client,
            requestUpdate: props.onRequestUpdate,
          });
        }}
      >
        <div class="workboard-modal__header">
          <div>
            <h2 id="workboard-card-modal-title">${editing ? "Edit card" : "New card"}</h2>
            <p>
              ${editing
                ? "Update queue metadata and session handoff."
                : "Queue work for an agent session."}
            </p>
          </div>
          <button
            class="btn btn--icon workboard-card__icon"
            type="button"
            title=${t("common.cancel")}
            @click=${() => {
              resetDraft(state);
              props.onRequestUpdate?.();
            }}
          >
            ${icons.x}
          </button>
        </div>
        <div class="workboard-draft__main">
          <label class="workboard-field">
            <span>Title</span>
            <input
              class="input workboard-draft__title"
              placeholder="Card title"
              .value=${state.draftTitle}
              @input=${(event: InputEvent) => {
                state.draftTitle = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
            />
          </label>
          <label class="workboard-field">
            <span>Notes</span>
            <textarea
              class="input workboard-draft__notes"
              placeholder="Notes, acceptance criteria, links"
              .value=${state.draftNotes}
              @input=${(event: InputEvent) => {
                state.draftNotes = (event.currentTarget as HTMLTextAreaElement).value;
                props.onRequestUpdate?.();
              }}
            ></textarea>
          </label>
        </div>
        <div class="workboard-draft__meta">
          <label class="workboard-field">
            <span>Status</span>
            <select
              class="input"
              .value=${state.draftStatus}
              @change=${(event: Event) => {
                state.draftStatus = (event.currentTarget as HTMLSelectElement)
                  .value as WorkboardStatus;
                props.onRequestUpdate?.();
              }}
            >
              ${state.statuses.map(
                (status) => html`<option value=${status}>${STATUS_LABELS[status]}</option>`,
              )}
            </select>
          </label>
          <label class="workboard-field">
            <span>Priority</span>
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
          </label>
          <label class="workboard-field">
            <span>Agent</span>
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
          </label>
          <label class="workboard-field">
            <span>Session</span>
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
          </label>
          <label class="workboard-field workboard-field--wide">
            <span>Labels</span>
            <input
              class="input"
              placeholder="ui, docs"
              .value=${state.draftLabels}
              @input=${(event: InputEvent) => {
                state.draftLabels = (event.currentTarget as HTMLInputElement).value;
                props.onRequestUpdate?.();
              }}
            />
          </label>
        </div>
        <div class="workboard-modal__actions">
          <button class="btn primary" ?disabled=${state.loading || !state.draftTitle.trim()}>
            ${editing ? t("common.save") : t("common.create")}
          </button>
          <button
            class="btn"
            type="button"
            @click=${() => {
              resetDraft(state);
              props.onRequestUpdate?.();
            }}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
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
  const linked = Boolean(card.sessionKey);
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy ? "workboard-card--busy" : ""} ${linked
        ? "workboard-card--openable"
        : ""}"
      role=${linked ? "button" : nothing}
      tabindex=${linked ? 0 : nothing}
      title=${linked ? "Open linked session" : nothing}
      draggable="true"
      @click=${(event: MouseEvent) => {
        if (!isCardActionTarget(event)) {
          openCardSession(props, card);
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        if (openCardSession(props, card)) {
          event.preventDefault();
        }
      }}
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
        <button
          class="btn btn--icon workboard-card__icon"
          title="Edit card"
          @click=${() => {
            openEditModal(state, card);
            props.onRequestUpdate?.();
          }}
        >
          ${icons.edit}
        </button>
        ${card.sessionKey
          ? html`
              <button
                class="btn btn--icon workboard-card__icon"
                title="Open session"
                @click=${() => props.onOpenSession(card.sessionKey!)}
              >
                ${icons.messageSquare}
              </button>
              ${live
                ? html`
                    <button
                      class="btn btn--icon workboard-card__icon"
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
                class="btn btn--xs workboard-card__start"
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
                ${icons.play} Start
              </button>
            `}
        <button
          class="btn btn--icon workboard-card__icon workboard-card__delete"
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
            class="btn"
            @click=${() => {
              state.gameOpen = true;
              props.onRequestUpdate?.();
            }}
          >
            ${icons.play} ${t("workboard.gameButton")}
          </button>
          <button
            class="btn primary"
            @click=${() => {
              openCreateModal(state);
              props.onRequestUpdate?.();
            }}
          >
            ${icons.plus} New card
          </button>
        </div>
      </div>
      ${state.error ? html`<div class="callout danger">${state.error}</div>` : nothing}
      ${renderGameModal(props)} ${renderCardModal(props)}
      <div class="workboard-board">
        ${state.statuses.map((status) => renderColumn(props, status, byStatus.get(status) ?? []))}
      </div>
    </section>
  `;
}
