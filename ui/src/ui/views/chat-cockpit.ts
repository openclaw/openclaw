import { html, nothing, type TemplateResult } from "lit";
import type { SlashCommandDef } from "../chat/slash-commands.ts";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";
import { icons } from "../icons.ts";

// ─── Types ────────────────────────────────────────────────────

export type CockpitRightPaneTab = "node" | "tools" | "memory" | "approvals";

export type CockpitToolEntry = {
  id: string;
  name: string;
  node?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  status: "running" | "success" | "error";
  startedAt: number;
};

export type CockpitErrorBanner = {
  id: string;
  message: string;
  detail?: string;
  severity: "error" | "warning";
  ts: number;
};

export type CockpitSessionInfo = {
  sessionKey: string;
  startedAt: number | null;
  nodeId?: string;
  execPolicy?: string;
};

export type CockpitCostInfo = {
  cumulativeCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
};

export type CockpitModelInfo = {
  modelId: string | null;
  thinkingLevel: string | null;
};

export type CockpitState = {
  session: CockpitSessionInfo;
  approvals: ExecApprovalRequest[];
  toolTimeline: CockpitToolEntry[];
  cost: CockpitCostInfo;
  model: CockpitModelInfo;
  errors: CockpitErrorBanner[];
  rightPaneTab: CockpitRightPaneTab;
  rightPaneOpen: boolean;
  composerPaletteOpen: boolean;
  composerPaletteQuery: string;
  composerPaletteIndex: number;
  slashCommands: SlashCommandDef[];
  nodes: Array<Record<string, unknown>>;
  memoryEntries: string[];
};

export type CockpitCallbacks = {
  onNewSession: () => void;
  onForkSession: () => void;
  onExportSession: () => void;
  onApprovalDecision: (id: string, decision: "allow-once" | "allow-always" | "deny") => void;
  onSummarize: () => void;
  onDropTools: () => void;
  onDismissError: (id: string) => void;
  onRightPaneTabChange: (tab: CockpitRightPaneTab) => void;
  onToggleRightPane: () => void;
  onComposerPaletteSelect: (command: string) => void;
  onNavigateToLogs: () => void;
  onNavigateToSessions: () => void;
};

// ─── Helpers ──────────────────────────────────────────────────

function formatTs(ts: number | null): string {
  if (!ts) {
    return "—";
  }
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCost(dollars: number): string {
  if (dollars < 0.01) {
    return "<$0.01";
  }
  return `$${dollars.toFixed(2)}`;
}

function truncateId(id: string, max = 12): string {
  return id.length > max ? id.slice(0, max) + "…" : id;
}

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m`;
}

// ─── 1. Session Header ───────────────────────────────────────

export function renderCockpitSessionHeader(
  session: CockpitSessionInfo,
  callbacks: CockpitCallbacks,
): TemplateResult {
  return html`
    <div class="cockpit-session-header">
      <div class="cockpit-session-header__meta">
        <span
          class="cockpit-session-header__tag cockpit-session-header__tag--id"
          title=${session.sessionKey}
        >
          ${truncateId(session.sessionKey)}
        </span>
        <span class="cockpit-session-header__tag">
          ${icons.loader} ${formatTs(session.startedAt)}
        </span>
        ${session.nodeId
          ? html`<span class="cockpit-session-header__tag"
              >${icons.monitor} ${session.nodeId}</span
            >`
          : nothing}
        ${session.execPolicy
          ? html`<span class="cockpit-session-header__tag cockpit-session-header__tag--policy">
              ${session.execPolicy}
            </span>`
          : nothing}
      </div>
      <div class="cockpit-session-header__actions">
        <button class="cockpit-btn" @click=${callbacks.onNewSession} title="New session">
          ${icons.plus} New
        </button>
        <button class="cockpit-btn" @click=${callbacks.onForkSession} title="Fork session">
          ${icons.copy} Fork
        </button>
        <button class="cockpit-btn" @click=${callbacks.onExportSession} title="Export session">
          ${icons.download} Export
        </button>
      </div>
    </div>
  `;
}

// ─── 2. Approvals Tray ──────────────────────────────────────

export function renderCockpitApprovalsTray(
  approvals: ExecApprovalRequest[],
  callbacks: CockpitCallbacks,
  busy: boolean,
): TemplateResult | typeof nothing {
  if (approvals.length === 0) {
    return nothing;
  }

  return html`
    <div class="cockpit-approvals-tray">
      ${approvals.map((approval) => {
        const remainingMs = approval.expiresAtMs - Date.now();
        const expired = remainingMs <= 0;
        return html`
          <div class="cockpit-approval-card">
            <div class="cockpit-approval-card__header">
              <span class="cockpit-approval-card__title">
                ${approval.kind === "plugin" ? "Plugin" : "Exec"} Approval
              </span>
              <span class="cockpit-approval-card__expiry">
                ${expired ? "expired" : formatRemaining(remainingMs)}
              </span>
            </div>
            <div class="cockpit-approval-card__command" title=${approval.request.command}>
              ${approval.request.command}
            </div>
            <div class="cockpit-approval-card__actions">
              <button
                class="cockpit-btn cockpit-btn--primary"
                ?disabled=${busy || expired}
                @click=${() => callbacks.onApprovalDecision(approval.id, "allow-once")}
              >
                ${icons.check} Allow
              </button>
              <button
                class="cockpit-btn cockpit-btn--danger"
                ?disabled=${busy || expired}
                @click=${() => callbacks.onApprovalDecision(approval.id, "deny")}
              >
                ${icons.x} Deny
              </button>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

// ─── 3. Tool Timeline ───────────────────────────────────────

export function renderCockpitToolTimeline(
  entries: CockpitToolEntry[],
): TemplateResult | typeof nothing {
  if (entries.length === 0) {
    return nothing;
  }

  return html`
    <div class="cockpit-tool-timeline">
      <div class="cockpit-tool-timeline__title">Tool Runs</div>
      ${entries.map(
        (entry) => html`
          <div class="cockpit-tool-entry">
            <span
              class="cockpit-tool-entry__indicator cockpit-tool-entry__indicator--${entry.status}"
            ></span>
            <span class="cockpit-tool-entry__name">${entry.name}</span>
            ${entry.node
              ? html`<span class="cockpit-tool-entry__node">${entry.node}</span>`
              : nothing}
            ${entry.command
              ? html`<span class="cockpit-tool-entry__cmd" title=${entry.command}>
                  ${entry.command}
                </span>`
              : nothing}
            ${entry.exitCode != null
              ? html`<span
                  class="cockpit-tool-entry__exit ${entry.exitCode === 0
                    ? "cockpit-tool-entry__exit--ok"
                    : "cockpit-tool-entry__exit--fail"}"
                >
                  exit ${entry.exitCode}
                </span>`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

// ─── 4. Context & Cost Controls ─────────────────────────────

export function renderCockpitContextCost(
  cost: CockpitCostInfo,
  callbacks: CockpitCallbacks,
): TemplateResult {
  return html`
    <div class="cockpit-context-cost">
      <div class="cockpit-context-cost__controls">
        <button class="cockpit-btn" @click=${callbacks.onSummarize} title="Summarize context">
          ${icons.loader} Summarize
        </button>
        <button class="cockpit-btn" @click=${callbacks.onDropTools} title="Drop inactive tools">
          ${icons.trash} Drop tools
        </button>
      </div>
      <span class="cockpit-context-cost__stat">
        ${icons.arrowDown} ${cost.inputTokens.toLocaleString()} in
      </span>
      <span class="cockpit-context-cost__stat"> ${cost.outputTokens.toLocaleString()} out </span>
      ${cost.cacheHits > 0
        ? html`<span class="cockpit-context-cost__stat">
            ${icons.zap} ${cost.cacheHits.toLocaleString()} cached
          </span>`
        : nothing}
      <span class="cockpit-context-cost__stat cockpit-context-cost__stat--cost">
        ${formatCost(cost.cumulativeCost)}
      </span>
    </div>
  `;
}

// ─── 5. Model / Reasoning Switch Notes ──────────────────────

export function renderCockpitModelSwitch(model: CockpitModelInfo): TemplateResult | typeof nothing {
  if (!model.modelId) {
    return nothing;
  }

  return html`
    <div class="cockpit-model-switch">
      <span class="cockpit-model-switch__label">${icons.brain} Model</span>
      <span class="cockpit-model-switch__value">${model.modelId}</span>
      ${model.thinkingLevel
        ? html`<span class="cockpit-model-switch__thinking">
            thinking: ${model.thinkingLevel}
          </span>`
        : nothing}
    </div>
  `;
}

// ─── 6. Composer Palette (/autocomplete) ────────────────────

export function renderCockpitComposerPalette(
  open: boolean,
  query: string,
  activeIndex: number,
  commands: SlashCommandDef[],
  onSelect: (command: string) => void,
): TemplateResult | typeof nothing {
  if (!open || commands.length === 0) {
    return nothing;
  }

  const q = query.toLowerCase();
  const filtered = q
    ? commands.filter(
        (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
      )
    : commands;

  if (filtered.length === 0) {
    return nothing;
  }

  return html`
    <div class="cockpit-composer-palette">
      ${filtered.map(
        (cmd, i) => html`
          <div
            class="cockpit-composer-palette__item ${i === activeIndex
              ? "cockpit-composer-palette__item--active"
              : ""}"
            @click=${() => onSelect(`/${cmd.name}`)}
          >
            <span class="cockpit-composer-palette__item-name">/${cmd.name}</span>
            <span class="cockpit-composer-palette__item-desc">${cmd.description}</span>
            ${cmd.category
              ? html`<span class="cockpit-composer-palette__item-category"> ${cmd.category} </span>`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

// ─── 7. Observability Links ─────────────────────────────────

export function renderCockpitObsLinks(
  callbacks: CockpitCallbacks,
  sessionKey: string,
): TemplateResult {
  return html`
    <div class="cockpit-obs-links">
      <a class="cockpit-obs-link" @click=${callbacks.onNavigateToLogs}> ${icons.fileText} Logs </a>
      <a
        class="cockpit-obs-link"
        @click=${callbacks.onNavigateToSessions}
        title="Sessions filtered to ${sessionKey}"
      >
        ${icons.scrollText} Sessions
      </a>
    </div>
  `;
}

// ─── 8. Right Pane ──────────────────────────────────────────

const RIGHT_PANE_TABS: Array<{ id: CockpitRightPaneTab; label: string }> = [
  { id: "node", label: "Node" },
  { id: "tools", label: "Tools" },
  { id: "memory", label: "Memory" },
  { id: "approvals", label: "Approvals" },
];

export function renderCockpitRightPane(
  state: CockpitState,
  callbacks: CockpitCallbacks,
): TemplateResult | typeof nothing {
  if (!state.rightPaneOpen) {
    return nothing;
  }

  return html`
    <div class="cockpit-right-pane">
      <div class="cockpit-right-pane__tabs">
        ${RIGHT_PANE_TABS.map(
          (tab) => html`
            <div
              class="cockpit-right-pane__tab ${state.rightPaneTab === tab.id
                ? "cockpit-right-pane__tab--active"
                : ""}"
              @click=${() => callbacks.onRightPaneTabChange(tab.id)}
            >
              ${tab.label}
              ${tab.id === "approvals" && state.approvals.length > 0
                ? html`<span class="cockpit-right-pane__tab-badge">
                    ${state.approvals.length}
                  </span>`
                : nothing}
            </div>
          `,
        )}
      </div>
      <div class="cockpit-right-pane__content">${renderRightPaneContent(state, callbacks)}</div>
    </div>
  `;
}

function renderRightPaneContent(state: CockpitState, callbacks: CockpitCallbacks): TemplateResult {
  switch (state.rightPaneTab) {
    case "node":
      return renderRightPaneNode(state);
    case "tools":
      return renderRightPaneTools(state);
    case "memory":
      return renderRightPaneMemory(state);
    case "approvals":
      return renderRightPaneApprovals(state, callbacks);
    default:
      return html``;
  }
}

function renderRightPaneNode(state: CockpitState): TemplateResult {
  if (state.nodes.length === 0) {
    return html`<div class="cockpit-right-pane__empty">No nodes connected</div>`;
  }
  return html`
    <div class="cockpit-right-pane__section">
      <div class="cockpit-right-pane__section-title">Connected Nodes</div>
      ${state.nodes.map(
        (node) => html`
          <div class="cockpit-right-pane__item">
            ${icons.monitor}
            <span>${(node as { id?: string }).id ?? "unknown"}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderRightPaneTools(state: CockpitState): TemplateResult {
  if (state.toolTimeline.length === 0) {
    return html`<div class="cockpit-right-pane__empty">No tool runs yet</div>`;
  }
  return html`
    <div class="cockpit-right-pane__section">
      <div class="cockpit-right-pane__section-title">Recent Tool Runs</div>
      ${state.toolTimeline.map(
        (entry) => html`
          <div class="cockpit-right-pane__item">
            <span
              class="cockpit-tool-entry__indicator cockpit-tool-entry__indicator--${entry.status}"
            ></span>
            <span>${entry.name}</span>
            ${entry.exitCode != null
              ? html`<span
                  class="cockpit-tool-entry__exit ${entry.exitCode === 0
                    ? "cockpit-tool-entry__exit--ok"
                    : "cockpit-tool-entry__exit--fail"}"
                  >exit ${entry.exitCode}</span
                >`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderRightPaneMemory(state: CockpitState): TemplateResult {
  if (state.memoryEntries.length === 0) {
    return html`<div class="cockpit-right-pane__empty">No memory entries</div>`;
  }
  return html`
    <div class="cockpit-right-pane__section">
      <div class="cockpit-right-pane__section-title">Memory</div>
      ${state.memoryEntries.map(
        (entry) => html`
          <div class="cockpit-right-pane__item">${icons.bookmark} <span>${entry}</span></div>
        `,
      )}
    </div>
  `;
}

function renderRightPaneApprovals(
  state: CockpitState,
  callbacks: CockpitCallbacks,
): TemplateResult {
  if (state.approvals.length === 0) {
    return html`<div class="cockpit-right-pane__empty">No pending approvals</div>`;
  }
  return html`
    <div class="cockpit-right-pane__section">
      <div class="cockpit-right-pane__section-title">Pending Approvals</div>
      ${state.approvals.map(
        (approval) => html`
          <div class="cockpit-approval-card">
            <div class="cockpit-approval-card__header">
              <span class="cockpit-approval-card__title">
                ${approval.kind === "plugin" ? "Plugin" : "Exec"}
              </span>
              <span class="cockpit-approval-card__expiry">
                ${approval.expiresAtMs - Date.now() > 0
                  ? formatRemaining(approval.expiresAtMs - Date.now())
                  : "expired"}
              </span>
            </div>
            <div class="cockpit-approval-card__command">${approval.request.command}</div>
            <div class="cockpit-approval-card__actions">
              <button
                class="cockpit-btn cockpit-btn--primary"
                @click=${() => callbacks.onApprovalDecision(approval.id, "allow-once")}
              >
                Allow
              </button>
              <button
                class="cockpit-btn cockpit-btn--danger"
                @click=${() => callbacks.onApprovalDecision(approval.id, "deny")}
              >
                Deny
              </button>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// ─── 9. Error Banners ───────────────────────────────────────

export function renderCockpitErrorBanners(
  errors: CockpitErrorBanner[],
  onDismiss: (id: string) => void,
): TemplateResult | typeof nothing {
  if (errors.length === 0) {
    return nothing;
  }

  return html`
    ${errors.map(
      (err) => html`
        <div class="cockpit-error-banner">
          <span class="cockpit-error-banner__icon">${icons.bug}</span>
          <div class="cockpit-error-banner__text">
            <strong>${err.severity === "error" ? "Error" : "Warning"}:</strong>
            ${err.message} ${err.detail ? html` — <em>${err.detail}</em>` : nothing}
          </div>
          <button
            class="cockpit-error-banner__dismiss"
            @click=${() => onDismiss(err.id)}
            title="Dismiss"
          >
            ${icons.x}
          </button>
        </div>
      `,
    )}
  `;
}

// ─── Orchestrator: Full Cockpit Render ──────────────────────

export function renderChatCockpit(
  state: CockpitState,
  callbacks: CockpitCallbacks,
): TemplateResult {
  return html`
    ${renderCockpitErrorBanners(state.errors, callbacks.onDismissError)}
    ${renderCockpitSessionHeader(state.session, callbacks)}
    ${renderCockpitApprovalsTray(state.approvals, callbacks, false)}
    ${renderCockpitModelSwitch(state.model)} ${renderCockpitToolTimeline(state.toolTimeline)}
    ${renderCockpitContextCost(state.cost, callbacks)}
    ${renderCockpitObsLinks(callbacks, state.session.sessionKey)}
  `;
}
