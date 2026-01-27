import { html, nothing } from "lit";

import { clampText, formatAgo, formatList } from "../format";
import { icon } from "../icons";
import type {
  ExecApprovalsAllowlistEntry,
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "../controllers/exec-approvals";
import type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../controllers/devices";

export type NodesProps = {
  loading: boolean;
  nodes: Array<Record<string, unknown>>;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  configFormMode: "form" | "raw";
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  activeTab?: "nodes" | "devices" | "approvals" | "bindings";
  onTabChange?: (tab: "nodes" | "devices" | "approvals" | "bindings") => void;
  onRefresh: () => void;
  onDevicesRefresh: () => void;
  onDeviceApprove: (requestId: string) => void;
  onDeviceReject: (requestId: string) => void;
  onDeviceRotate: (deviceId: string, role: string, scopes?: string[]) => void;
  onDeviceRevoke: (deviceId: string, role: string) => void;
  onLoadConfig: () => void;
  onLoadExecApprovals: () => void;
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSaveBindings: () => void;
  onExecApprovalsTargetChange: (kind: "gateway" | "node", nodeId: string | null) => void;
  onExecApprovalsSelectAgent: (agentId: string) => void;
  onExecApprovalsPatch: (path: Array<string | number>, value: unknown) => void;
  onExecApprovalsRemove: (path: Array<string | number>) => void;
  onSaveExecApprovals: () => void;
};

type NodesTab = "nodes" | "devices" | "approvals" | "bindings";

export function renderNodes(props: NodesProps) {
  const activeTab = props.activeTab ?? "nodes";
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);

  return html`
    <div class="nodes-view">
      ${renderHeader(props)}
      ${renderTabs(activeTab, props.onTabChange)}
      <div class="nodes-content">
        ${activeTab === "nodes" ? renderNodesTab(props) : nothing}
        ${activeTab === "devices" ? renderDevicesTab(props) : nothing}
        ${activeTab === "approvals" ? renderApprovalsTab(approvalsState) : nothing}
        ${activeTab === "bindings" ? renderBindingsTab(bindingState) : nothing}
      </div>
    </div>
  `;
}

function renderHeader(props: NodesProps) {
  return html`
    <div class="nodes-header">
      <div class="nodes-header__info">
        <div class="nodes-header__icon">
          ${icon("server", { size: 24 })}
        </div>
        <div>
          <h1 class="nodes-header__title">Nodes</h1>
          <p class="nodes-header__desc">Manage connected nodes, devices, and execution approvals</p>
        </div>
      </div>
      <button class="btn btn--secondary" ?disabled=${props.loading} @click=${props.onRefresh}>
        ${icon("refresh-cw", { size: 16 })}
        <span>${props.loading ? "Loading..." : "Refresh"}</span>
      </button>
    </div>
  `;
}

function renderTabs(activeTab: NodesTab, onTabChange?: (tab: NodesTab) => void) {
  const tabs: Array<{ id: NodesTab; label: string; icon: ReturnType<typeof icon> }> = [
    { id: "nodes", label: "Nodes", icon: icon("server", { size: 16 }) },
    { id: "devices", label: "Devices", icon: icon("monitor", { size: 16 }) },
    { id: "approvals", label: "Exec Approvals", icon: icon("check", { size: 16 }) },
    { id: "bindings", label: "Bindings", icon: icon("link", { size: 16 }) },
  ];

  return html`
    <div class="nodes-tabs nodes-tabs--modern">
      ${tabs.map(
        (tab) => html`
          <button
            class="nodes-tab ${activeTab === tab.id ? "nodes-tab--active" : ""}"
            @click=${() => onTabChange?.(tab.id)}
          >
            ${tab.icon}
            <span>${tab.label}</span>
          </button>
        `
      )}
    </div>
  `;
}

/**
 * Render skeleton loading state for nodes
 */
function renderNodesSkeleton() {
  return html`
    <div class="nodes-skeleton">
      ${Array.from({ length: 3 }, () => html`
        <div class="node-card node-card--modern node-card--skeleton">
          <div class="node-card__header">
            <div class="node-card__icon skeleton skeleton--circle" style="width: 36px; height: 36px;"></div>
            <div class="node-card__info">
              <div class="skeleton skeleton--text" style="width: 8rem; height: 1rem; margin-bottom: 0.5rem;"></div>
              <div class="skeleton skeleton--text" style="width: 12rem; height: 0.75rem;"></div>
            </div>
            <div class="skeleton skeleton--text" style="width: 4rem; height: 1.5rem; border-radius: 9999px;"></div>
          </div>
        </div>
      `)}
    </div>
  `;
}

function renderNodesTab(props: NodesProps) {
  const connectedNodes = props.nodes.filter((n) => Boolean(n.connected));
  const offlineNodes = props.nodes.filter((n) => !Boolean(n.connected));

  return html`
    <div class="nodes-tab-content">
      ${props.loading && props.nodes.length === 0
        ? renderNodesSkeleton()
        : props.nodes.length === 0
          ? html`
              <div class="nodes-empty">
                <div class="nodes-empty__icon">
                  ${icon("server", { size: 32 })}
                </div>
                <div class="nodes-empty__title">No nodes connected</div>
                <div class="nodes-empty__desc">Nodes will appear here when they connect to the gateway. Run <code>clawdbot node start</code> to connect a node.</div>
                <button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.loading} @click=${props.onRefresh}>
                  ${icon("refresh-cw", { size: 14 })}
                  <span>Refresh</span>
                </button>
              </div>
            `
        : html`
            <div class="node-tree">
              <div class="node-tree__gateway">
                <div class="node-card node-card--modern node-card--gateway">
                  <div class="node-card__header">
                    <div class="node-card__icon node-card__icon--gateway">
                      ${icon("radio", { size: 20 })}
                    </div>
                    <div class="node-card__info">
                      <div class="node-card__name">Gateway</div>
                      <div class="node-card__subtitle">Central hub</div>
                    </div>
                    <div class="node-card__status">
                      <span class="status-indicator--modern status-indicator--online"></span>
                      <span class="status-label">Online</span>
                    </div>
                  </div>
                </div>
              </div>

              ${connectedNodes.length > 0 || offlineNodes.length > 0
                ? html`
                    <div class="node-tree__connector"></div>
                    <div class="node-tree__children">
                      ${connectedNodes.map((n) => renderNodeCard(n, true))}
                      ${offlineNodes.map((n) => renderNodeCard(n, false))}
                    </div>
                  `
                : nothing}
            </div>
          `}
    </div>
  `;
}

function renderNodeCard(node: Record<string, unknown>, isOnline: boolean) {
  const title =
    (typeof node.displayName === "string" && node.displayName.trim()) ||
    (typeof node.nodeId === "string" ? node.nodeId : "unknown");
  const nodeId = typeof node.nodeId === "string" ? node.nodeId : "";
  const paired = Boolean(node.paired);
  const version = typeof node.version === "string" ? node.version : "";
  const remoteIp = typeof node.remoteIp === "string" ? node.remoteIp : "";
  const caps = Array.isArray(node.caps) ? (node.caps as unknown[]).slice(0, 6) : [];
  const commands = Array.isArray(node.commands) ? (node.commands as unknown[]).slice(0, 4) : [];

  return html`
    <div class="node-card node-card--modern ${isOnline ? "node-card--online" : "node-card--offline"}">
      <div class="node-card__header">
        <div class="node-card__icon ${isOnline ? "node-card__icon--online" : "node-card__icon--offline"}">
          ${icon("server", { size: 18 })}
        </div>
        <div class="node-card__info">
          <div class="node-card__name">${title}</div>
          <div class="node-card__subtitle mono">${nodeId}</div>
        </div>
        <div class="node-card__status">
          <span class="status-indicator--modern ${isOnline ? "status-indicator--online" : "status-indicator--offline"}"></span>
          <span class="status-label">${isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>

      <div class="node-card__details">
        <div class="node-card__meta-grid">
          ${remoteIp
            ? html`
                <div class="node-card__meta-item">
                  <span class="node-card__meta-label">IP Address</span>
                  <span class="node-card__meta-value mono">${remoteIp}</span>
                </div>
              `
            : nothing}
          ${version
            ? html`
                <div class="node-card__meta-item">
                  <span class="node-card__meta-label">Version</span>
                  <span class="node-card__meta-value mono">${version}</span>
                </div>
              `
            : nothing}
          <div class="node-card__meta-item">
            <span class="node-card__meta-label">Status</span>
            <span class="badge ${paired ? "badge--ok" : "badge--warn"}">${paired ? "Paired" : "Unpaired"}</span>
          </div>
        </div>

        ${caps.length > 0 || commands.length > 0
          ? html`
              <div class="node-card__tags">
                ${caps.map((c) => html`<span class="chip">${String(c)}</span>`)}
                ${commands.map((c) => html`<span class="chip chip--accent">${String(c)}</span>`)}
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

/**
 * Render skeleton loading state for devices
 */
function renderDevicesSkeleton() {
  return html`
    <div class="devices-skeleton">
      ${Array.from({ length: 2 }, () => html`
        <div class="device-card device-card--modern device-card--skeleton">
          <div class="device-card__header">
            <div class="device-card__icon skeleton skeleton--circle" style="width: 32px; height: 32px;"></div>
            <div class="device-card__info">
              <div class="skeleton skeleton--text" style="width: 10rem; height: 1rem; margin-bottom: 0.5rem;"></div>
              <div class="skeleton skeleton--text" style="width: 8rem; height: 0.75rem;"></div>
            </div>
            <div class="skeleton skeleton--text" style="width: 4rem; height: 1.25rem; border-radius: 9999px;"></div>
          </div>
          <div class="device-card__meta" style="margin-top: 0.75rem;">
            <div class="skeleton skeleton--text" style="width: 50%; height: 0.75rem;"></div>
          </div>
        </div>
      `)}
    </div>
  `;
}

function renderDevicesTab(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];

  return html`
    <div class="nodes-tab-content">
      <div class="devices-header">
        <div class="devices-header__info">
          <span class="devices-header__count">${pending.length + paired.length} devices</span>
          ${pending.length > 0
            ? html`<span class="badge badge--warn">${pending.length} pending</span>`
            : nothing}
        </div>
        <button class="btn btn--sm" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
          ${icon("refresh-cw", { size: 14 })}
          <span>${props.devicesLoading ? "Loading..." : "Refresh"}</span>
        </button>
      </div>

      ${props.devicesError
        ? html`
            <div class="callout--danger" style="margin-top: 16px;">
              <div class="callout__icon">${icon("alert-circle", { size: 18 })}</div>
              <div class="callout__content">${props.devicesError}</div>
            </div>
          `
        : nothing}

      ${pending.length > 0
        ? html`
            <div class="devices-section">
              <div class="devices-section__header">
                <div class="devices-section__icon devices-section__icon--warn">
                  ${icon("clock", { size: 16 })}
                </div>
                <div class="devices-section__title">Pending Requests</div>
              </div>
              <div class="devices-list">
                ${pending.map((req) => renderPendingDeviceCard(req, props))}
              </div>
            </div>
          `
        : nothing}

      ${paired.length > 0
        ? html`
            <div class="devices-section">
              <div class="devices-section__header">
                <div class="devices-section__icon devices-section__icon--ok">
                  ${icon("check", { size: 16 })}
                </div>
                <div class="devices-section__title">Approved Devices</div>
              </div>
              <div class="devices-list">
                ${paired.map((device) => renderApprovedDeviceCard(device, props))}
              </div>
            </div>
          `
        : nothing}

      ${props.devicesLoading && pending.length === 0 && paired.length === 0
        ? renderDevicesSkeleton()
        : pending.length === 0 && paired.length === 0
          ? html`
              <div class="nodes-empty">
                <div class="nodes-empty__icon">
                  ${icon("monitor", { size: 32 })}
                </div>
                <div class="nodes-empty__title">No devices</div>
                <div class="nodes-empty__desc">Paired devices will appear here when they request access to the gateway</div>
                <button class="btn btn--sm" style="margin-top: 12px;" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
                  ${icon("refresh-cw", { size: 14 })}
                  <span>Refresh</span>
                </button>
              </div>
            `
          : nothing}
    </div>
  `;
}

function renderPendingDeviceCard(req: PendingDevice, props: NodesProps) {
  const name = req.displayName?.trim() || req.deviceId;
  const age = typeof req.ts === "number" ? formatAgo(req.ts) : "n/a";
  const role = req.role?.trim() || "user";
  const repair = req.isRepair;
  const ip = req.remoteIp || "";

  return html`
    <div class="device-card device-card--modern device-card--pending">
      <div class="device-card__header">
        <div class="device-card__icon device-card__icon--pending">
          ${icon("monitor", { size: 18 })}
        </div>
        <div class="device-card__info">
          <div class="device-card__name">${name}</div>
          <div class="device-card__id mono">${req.deviceId}</div>
        </div>
        <div class="device-card__badge">
          <span class="badge badge--warn badge--animated">
            ${icon("clock", { size: 12 })}
            <span>Pending</span>
          </span>
          ${repair ? html`<span class="badge badge--info">Repair</span>` : nothing}
        </div>
      </div>

      <div class="device-card__meta">
        <div class="device-card__meta-row">
          <span class="muted">Role:</span>
          <span>${role}</span>
        </div>
        ${ip
          ? html`
              <div class="device-card__meta-row">
                <span class="muted">IP:</span>
                <span class="mono">${ip}</span>
              </div>
            `
          : nothing}
        <div class="device-card__meta-row">
          <span class="muted">Requested:</span>
          <span>${age}</span>
        </div>
      </div>

      <div class="device-card__actions">
        <button class="btn btn--primary btn--sm" @click=${() => props.onDeviceApprove(req.requestId)}>
          ${icon("check", { size: 14 })}
          <span>Approve</span>
        </button>
        <button class="btn btn--danger btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
          ${icon("x", { size: 14 })}
          <span>Reject</span>
        </button>
      </div>
    </div>
  `;
}

function renderApprovedDeviceCard(device: PairedDevice, props: NodesProps) {
  const name = device.displayName?.trim() || device.deviceId;
  const ip = device.remoteIp || "";
  const roles = device.roles || [];
  const scopes = device.scopes || [];
  const tokens = Array.isArray(device.tokens) ? device.tokens : [];

  return html`
    <div class="device-card device-card--modern device-card--active">
      <div class="device-card__header">
        <div class="device-card__icon device-card__icon--active">
          ${icon("monitor", { size: 18 })}
        </div>
        <div class="device-card__info">
          <div class="device-card__name">${name}</div>
          <div class="device-card__id mono">${device.deviceId}</div>
        </div>
        <div class="device-card__badge">
          <span class="badge badge--ok badge--animated">
            ${icon("check", { size: 12 })}
            <span>Active</span>
          </span>
        </div>
      </div>

      <div class="device-card__meta">
        ${ip
          ? html`
              <div class="device-card__meta-row">
                <span class="muted">IP:</span>
                <span class="mono">${ip}</span>
              </div>
            `
          : nothing}
        <div class="device-card__meta-row">
          <span class="muted">Roles:</span>
          <span>${formatList(roles)}</span>
        </div>
        <div class="device-card__meta-row">
          <span class="muted">Scopes:</span>
          <span>${formatList(scopes)}</span>
        </div>
      </div>

      ${tokens.length > 0
        ? html`
            <div class="device-card__tokens">
              <div class="device-card__tokens-title">
                ${icon("zap", { size: 14 })}
                <span>Tokens (${tokens.length})</span>
              </div>
              <div class="device-card__tokens-list">
                ${tokens.map((token) => renderTokenCard(device.deviceId, token, props))}
              </div>
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderTokenCard(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const isRevoked = Boolean(token.revokedAtMs);
  const status = isRevoked ? "revoked" : "active";
  const scopes = token.scopes || [];
  const when = formatAgo(token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null);

  return html`
    <div class="token-card ${isRevoked ? "token-card--revoked" : ""}">
      <div class="token-card__info">
        <span class="token-card__role">${token.role}</span>
        <span class="badge ${isRevoked ? "badge--muted" : "badge--ok"} badge--sm">${status}</span>
      </div>
      <div class="token-card__meta">
        <span class="muted">scopes: ${formatList(scopes)}</span>
        <span class="muted">${when}</span>
      </div>
      <div class="token-card__actions">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          ${icon("refresh-cw", { size: 12 })}
          <span>Rotate</span>
        </button>
        ${!isRevoked
          ? html`
              <button
                class="btn btn--danger btn--sm"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                ${icon("trash", { size: 12 })}
                <span>Revoke</span>
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

type BindingAgent = {
  id: string;
  name?: string;
  index: number;
  isDefault: boolean;
  binding?: string | null;
};

type BindingNode = {
  id: string;
  label: string;
};

type BindingState = {
  ready: boolean;
  disabled: boolean;
  configDirty: boolean;
  configLoading: boolean;
  configSaving: boolean;
  defaultBinding?: string | null;
  agents: BindingAgent[];
  nodes: BindingNode[];
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSave: () => void;
  onLoadConfig: () => void;
  formMode: "form" | "raw";
};

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";

type ExecApprovalsResolvedDefaults = {
  security: ExecSecurity;
  ask: ExecAsk;
  askFallback: ExecSecurity;
  autoAllowSkills: boolean;
};

type ExecApprovalsAgentOption = {
  id: string;
  name?: string;
  isDefault?: boolean;
};

type ExecApprovalsTargetNode = {
  id: string;
  label: string;
};

type ExecApprovalsState = {
  ready: boolean;
  disabled: boolean;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  form: ExecApprovalsFile | null;
  defaults: ExecApprovalsResolvedDefaults;
  selectedScope: string;
  selectedAgent: Record<string, unknown> | null;
  agents: ExecApprovalsAgentOption[];
  allowlist: ExecApprovalsAllowlistEntry[];
  target: "gateway" | "node";
  targetNodeId: string | null;
  targetNodes: ExecApprovalsTargetNode[];
  onSelectScope: (agentId: string) => void;
  onSelectTarget: (kind: "gateway" | "node", nodeId: string | null) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove: (path: Array<string | number>) => void;
  onLoad: () => void;
  onSave: () => void;
};

const EXEC_APPROVALS_DEFAULT_SCOPE = "__defaults__";

const SECURITY_OPTIONS: Array<{ value: ExecSecurity; label: string }> = [
  { value: "deny", label: "Deny" },
  { value: "allowlist", label: "Allowlist" },
  { value: "full", label: "Full" },
];

const ASK_OPTIONS: Array<{ value: ExecAsk; label: string }> = [
  { value: "off", label: "Off" },
  { value: "on-miss", label: "On miss" },
  { value: "always", label: "Always" },
];

function resolveBindingsState(props: NodesProps): BindingState {
  const config = props.configForm;
  const nodes = resolveExecNodes(props.nodes);
  const { defaultBinding, agents } = resolveAgentBindings(config);
  const ready = Boolean(config);
  const disabled = props.configSaving || props.configFormMode === "raw";
  return {
    ready,
    disabled,
    configDirty: props.configDirty,
    configLoading: props.configLoading,
    configSaving: props.configSaving,
    defaultBinding,
    agents,
    nodes,
    onBindDefault: props.onBindDefault,
    onBindAgent: props.onBindAgent,
    onSave: props.onSaveBindings,
    onLoadConfig: props.onLoadConfig,
    formMode: props.configFormMode,
  };
}

function normalizeSecurity(value?: string): ExecSecurity {
  if (value === "allowlist" || value === "full" || value === "deny") return value;
  return "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") return value;
  return "on-miss";
}

function resolveExecApprovalsDefaults(
  form: ExecApprovalsFile | null,
): ExecApprovalsResolvedDefaults {
  const defaults = form?.defaults ?? {};
  return {
    security: normalizeSecurity(defaults.security),
    ask: normalizeAsk(defaults.ask),
    askFallback: normalizeSecurity(defaults.askFallback ?? "deny"),
    autoAllowSkills: Boolean(defaults.autoAllowSkills ?? false),
  };
}

function resolveConfigAgents(config: Record<string, unknown> | null): ExecApprovalsAgentOption[] {
  const agentsNode = (config?.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  const agents: ExecApprovalsAgentOption[] = [];
  list.forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return;
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const isDefault = record.default === true;
    agents.push({ id, name: name || undefined, isDefault });
  });
  return agents;
}

function resolveExecApprovalsAgents(
  config: Record<string, unknown> | null,
  form: ExecApprovalsFile | null,
): ExecApprovalsAgentOption[] {
  const configAgents = resolveConfigAgents(config);
  const approvalsAgents = Object.keys(form?.agents ?? {});
  const merged = new Map<string, ExecApprovalsAgentOption>();
  configAgents.forEach((agent) => merged.set(agent.id, agent));
  approvalsAgents.forEach((id) => {
    if (merged.has(id)) return;
    merged.set(id, { id });
  });
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    const aLabel = a.name?.trim() ? a.name : a.id;
    const bLabel = b.name?.trim() ? b.name : b.id;
    return aLabel.localeCompare(bLabel);
  });
  return agents;
}

function resolveExecApprovalsScope(
  selected: string | null,
  agents: ExecApprovalsAgentOption[],
): string {
  if (selected === EXEC_APPROVALS_DEFAULT_SCOPE) return EXEC_APPROVALS_DEFAULT_SCOPE;
  if (selected && agents.some((agent) => agent.id === selected)) return selected;
  return EXEC_APPROVALS_DEFAULT_SCOPE;
}

function resolveExecApprovalsState(props: NodesProps): ExecApprovalsState {
  const form = props.execApprovalsForm ?? props.execApprovalsSnapshot?.file ?? null;
  const ready = Boolean(form);
  const defaults = resolveExecApprovalsDefaults(form);
  const agents = resolveExecApprovalsAgents(props.configForm, form);
  const targetNodes = resolveExecApprovalsNodes(props.nodes);
  const target = props.execApprovalsTarget;
  let targetNodeId =
    target === "node" && props.execApprovalsTargetNodeId
      ? props.execApprovalsTargetNodeId
      : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? ((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ??
        null
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ??
        [])
    : [];
  return {
    ready,
    disabled: props.execApprovalsSaving || props.execApprovalsLoading,
    dirty: props.execApprovalsDirty,
    loading: props.execApprovalsLoading,
    saving: props.execApprovalsSaving,
    form,
    defaults,
    selectedScope,
    selectedAgent,
    agents,
    allowlist,
    target,
    targetNodeId,
    targetNodes,
    onSelectScope: props.onExecApprovalsSelectAgent,
    onSelectTarget: props.onExecApprovalsTargetChange,
    onPatch: props.onExecApprovalsPatch,
    onRemove: props.onExecApprovalsRemove,
    onLoad: props.onLoadExecApprovals,
    onSave: props.onSaveExecApprovals,
  };
}

function renderBindingsTab(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";

  return html`
    <div class="nodes-tab-content">
      <div class="approvals-header">
        <div class="approvals-header__info">
          <div class="approvals-header__icon">
            ${icon("link", { size: 20 })}
          </div>
          <div>
            <div class="approvals-header__title">Exec Node Binding</div>
            <div class="approvals-header__desc">
              Pin agents to a specific node when using <span class="mono">exec host=node</span>.
            </div>
          </div>
        </div>
        <button
          class="btn btn--primary btn--sm"
          ?disabled=${state.disabled || !state.configDirty}
          @click=${state.onSave}
        >
          ${icon("check", { size: 14 })}
          <span>${state.configSaving ? "Saving..." : "Save"}</span>
        </button>
      </div>

      ${state.formMode === "raw"
        ? html`
            <div class="callout--info" style="margin-top: 16px;">
              <div class="callout__icon">${icon("info", { size: 18 })}</div>
              <div class="callout__content">
                Switch the Config tab to <strong>Form</strong> mode to edit bindings here.
              </div>
            </div>
          `
        : nothing}

      ${!state.ready
        ? html`
            <div class="approvals-load-prompt">
              <div class="muted">Load config to edit bindings.</div>
              <button class="btn btn--sm" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
                ${state.configLoading ? "Loading..." : "Load config"}
              </button>
            </div>
          `
        : html`
            <div class="bindings-list">
              <div class="binding-card binding-card--modern binding-card--default">
                <div class="binding-card__header">
                  <div class="binding-card__icon">
                    ${icon("server", { size: 18 })}
                  </div>
                  <div class="binding-card__info">
                    <div class="binding-card__name">Default Binding</div>
                    <div class="binding-card__desc">Used when agents do not override a node binding.</div>
                  </div>
                </div>
                <div class="binding-card__control">
                  <label class="field">
                    <span>Node</span>
                    <select
                      ?disabled=${state.disabled || !supportsBinding}
                      @change=${(event: Event) => {
                        const target = event.target as HTMLSelectElement;
                        const value = target.value.trim();
                        state.onBindDefault(value ? value : null);
                      }}
                    >
                      <option value="" ?selected=${defaultValue === ""}>Any node</option>
                      ${state.nodes.map(
                        (node) =>
                          html`<option
                            value=${node.id}
                            ?selected=${defaultValue === node.id}
                          >
                            ${node.label}
                          </option>`,
                      )}
                    </select>
                  </label>
                  ${!supportsBinding
                    ? html`<div class="muted" style="font-size: 11px; margin-top: 4px;">No nodes with system.run available.</div>`
                    : nothing}
                </div>
              </div>

              ${state.agents.length === 0
                ? html`<div class="muted">No agents found.</div>`
                : state.agents.map((agent) => renderAgentBindingCard(agent, state))}
            </div>
          `}
    </div>
  `;
}

function renderApprovalsTab(state: ExecApprovalsState) {
  const ready = state.ready;
  const targetReady = state.target !== "node" || Boolean(state.targetNodeId);

  return html`
    <div class="nodes-tab-content">
      <div class="approvals-header">
        <div class="approvals-header__info">
          <div class="approvals-header__icon">
            ${icon("check", { size: 20 })}
          </div>
          <div>
            <div class="approvals-header__title">Exec Approvals</div>
            <div class="approvals-header__desc">
              Allowlist and approval policy for <span class="mono">exec host=gateway/node</span>.
            </div>
          </div>
        </div>
        <button
          class="btn btn--primary btn--sm"
          ?disabled=${state.disabled || !state.dirty || !targetReady}
          @click=${state.onSave}
        >
          ${icon("check", { size: 14 })}
          <span>${state.saving ? "Saving..." : "Save"}</span>
        </button>
      </div>

      ${renderExecApprovalsTarget(state)}

      ${!ready
        ? html`
            <div class="approvals-load-prompt">
              <div class="muted">Load exec approvals to edit allowlists.</div>
              <button class="btn btn--sm" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
                ${state.loading ? "Loading..." : "Load approvals"}
              </button>
            </div>
          `
        : html`
            ${renderExecApprovalsScopeTabs(state)}
            ${renderExecApprovalsPolicy(state)}
            ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
              ? nothing
              : renderExecApprovalsAllowlist(state)}
          `}
    </div>
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";

  return html`
    <div class="approvals-target">
      <div class="approvals-target__label">
        ${icon("server", { size: 16 })}
        <span>Target</span>
      </div>
      <div class="approvals-target__controls">
        <label class="field">
          <span>Host</span>
          <select
            ?disabled=${state.disabled}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value;
              if (value === "node") {
                const first = state.targetNodes[0]?.id ?? null;
                state.onSelectTarget("node", nodeValue || first);
              } else {
                state.onSelectTarget("gateway", null);
              }
            }}
          >
            <option value="gateway" ?selected=${state.target === "gateway"}>Gateway</option>
            <option value="node" ?selected=${state.target === "node"}>Node</option>
          </select>
        </label>
        ${state.target === "node"
          ? html`
              <label class="field">
                <span>Node</span>
                <select
                  ?disabled=${state.disabled || !hasNodes}
                  @change=${(event: Event) => {
                    const target = event.target as HTMLSelectElement;
                    const value = target.value.trim();
                    state.onSelectTarget("node", value ? value : null);
                  }}
                >
                  <option value="" ?selected=${nodeValue === ""}>Select node</option>
                  ${state.targetNodes.map(
                    (node) =>
                      html`<option
                        value=${node.id}
                        ?selected=${nodeValue === node.id}
                      >
                        ${node.label}
                      </option>`,
                  )}
                </select>
              </label>
            `
          : nothing}
      </div>
      ${state.target === "node" && !hasNodes
        ? html`<div class="muted" style="margin-top: 8px; font-size: 12px;">No nodes advertise exec approvals yet.</div>`
        : nothing}
    </div>
  `;
}

function renderExecApprovalsScopeTabs(state: ExecApprovalsState) {
  return html`
    <div class="approvals-scope">
      <div class="approvals-scope__label">Scope</div>
      <div class="approvals-scope__tabs">
        <button
          class="approvals-scope__tab ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE ? "approvals-scope__tab--active" : ""}"
          @click=${() => state.onSelectScope(EXEC_APPROVALS_DEFAULT_SCOPE)}
        >
          ${icon("settings", { size: 14 })}
          <span>Defaults</span>
        </button>
        ${state.agents.map((agent) => {
          const label = agent.name?.trim() ? `${agent.name}` : agent.id;
          return html`
            <button
              class="approvals-scope__tab ${state.selectedScope === agent.id ? "approvals-scope__tab--active" : ""}"
              @click=${() => state.onSelectScope(agent.id)}
            >
              ${icon("user", { size: 14 })}
              <span>${label}</span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function renderExecApprovalsPolicy(state: ExecApprovalsState) {
  const isDefaults = state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE;
  const defaults = state.defaults;
  const agent = state.selectedAgent ?? {};
  const basePath = isDefaults ? ["defaults"] : ["agents", state.selectedScope];
  const agentSecurity = typeof agent.security === "string" ? agent.security : undefined;
  const agentAsk = typeof agent.ask === "string" ? agent.ask : undefined;
  const agentAskFallback =
    typeof agent.askFallback === "string" ? agent.askFallback : undefined;
  const securityValue = isDefaults ? defaults.security : agentSecurity ?? "__default__";
  const askValue = isDefaults ? defaults.ask : agentAsk ?? "__default__";
  const askFallbackValue = isDefaults
    ? defaults.askFallback
    : agentAskFallback ?? "__default__";
  const autoOverride =
    typeof agent.autoAllowSkills === "boolean" ? agent.autoAllowSkills : undefined;
  const autoEffective = autoOverride ?? defaults.autoAllowSkills;
  const autoIsDefault = autoOverride == null;

  return html`
    <div class="policy-grid">
      <div class="policy-card policy-card--modern">
        <div class="policy-card__header">
          <div class="policy-card__icon">${icon("settings", { size: 16 })}</div>
          <div class="policy-card__title">Security</div>
        </div>
        <div class="policy-card__desc">
          ${isDefaults ? "Default security mode." : `Default: ${defaults.security}.`}
        </div>
        <label class="field">
          <span>Mode</span>
          <select
            ?disabled=${state.disabled}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value;
              if (!isDefaults && value === "__default__") {
                state.onRemove([...basePath, "security"]);
              } else {
                state.onPatch([...basePath, "security"], value);
              }
            }}
          >
            ${!isDefaults
              ? html`<option value="__default__" ?selected=${securityValue === "__default__"}>
                  Use default (${defaults.security})
                </option>`
              : nothing}
            ${SECURITY_OPTIONS.map(
              (option) =>
                html`<option
                  value=${option.value}
                  ?selected=${securityValue === option.value}
                >
                  ${option.label}
                </option>`,
            )}
          </select>
        </label>
      </div>

      <div class="policy-card policy-card--modern">
        <div class="policy-card__header">
          <div class="policy-card__icon">${icon("alert-circle", { size: 16 })}</div>
          <div class="policy-card__title">Ask</div>
        </div>
        <div class="policy-card__desc">
          ${isDefaults ? "Default prompt policy." : `Default: ${defaults.ask}.`}
        </div>
        <label class="field">
          <span>Mode</span>
          <select
            ?disabled=${state.disabled}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value;
              if (!isDefaults && value === "__default__") {
                state.onRemove([...basePath, "ask"]);
              } else {
                state.onPatch([...basePath, "ask"], value);
              }
            }}
          >
            ${!isDefaults
              ? html`<option value="__default__" ?selected=${askValue === "__default__"}>
                  Use default (${defaults.ask})
                </option>`
              : nothing}
            ${ASK_OPTIONS.map(
              (option) =>
                html`<option
                  value=${option.value}
                  ?selected=${askValue === option.value}
                >
                  ${option.label}
                </option>`,
            )}
          </select>
        </label>
      </div>

      <div class="policy-card policy-card--modern">
        <div class="policy-card__header">
          <div class="policy-card__icon">${icon("alert-triangle", { size: 16 })}</div>
          <div class="policy-card__title">Ask Fallback</div>
        </div>
        <div class="policy-card__desc">
          ${isDefaults
            ? "Applied when UI prompt unavailable."
            : `Default: ${defaults.askFallback}.`}
        </div>
        <label class="field">
          <span>Fallback</span>
          <select
            ?disabled=${state.disabled}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value;
              if (!isDefaults && value === "__default__") {
                state.onRemove([...basePath, "askFallback"]);
              } else {
                state.onPatch([...basePath, "askFallback"], value);
              }
            }}
          >
            ${!isDefaults
              ? html`<option value="__default__" ?selected=${askFallbackValue === "__default__"}>
                  Use default (${defaults.askFallback})
                </option>`
              : nothing}
            ${SECURITY_OPTIONS.map(
              (option) =>
                html`<option
                  value=${option.value}
                  ?selected=${askFallbackValue === option.value}
                >
                  ${option.label}
                </option>`,
            )}
          </select>
        </label>
      </div>

      <div class="policy-card policy-card--modern">
        <div class="policy-card__header">
          <div class="policy-card__icon">${icon("zap", { size: 16 })}</div>
          <div class="policy-card__title">Auto-allow Skills</div>
        </div>
        <div class="policy-card__desc">
          ${isDefaults
            ? "Allow skill executables listed by Gateway."
            : autoIsDefault
              ? `Using default (${defaults.autoAllowSkills ? "on" : "off"}).`
              : `Override (${autoEffective ? "on" : "off"}).`}
        </div>
        <div class="policy-card__toggle">
          <label class="toggle-field">
            <input
              type="checkbox"
              ?disabled=${state.disabled}
              .checked=${autoEffective}
              @change=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                state.onPatch([...basePath, "autoAllowSkills"], target.checked);
              }}
            />
            <span>Enabled</span>
          </label>
          ${!isDefaults && !autoIsDefault
            ? html`
                <button
                  class="btn btn--sm"
                  ?disabled=${state.disabled}
                  @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
                >
                  Use default
                </button>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;

  return html`
    <div class="allowlist-section">
      <div class="allowlist-header">
        <div class="allowlist-header__info">
          <div class="allowlist-header__icon">
            ${icon("check", { size: 18 })}
          </div>
          <div>
            <div class="allowlist-header__title">Allowlist</div>
            <div class="allowlist-header__desc">Case-insensitive glob patterns.</div>
          </div>
        </div>
        <button
          class="btn btn--sm"
          ?disabled=${state.disabled}
          @click=${() => {
            const next = [...entries, { pattern: "" }];
            state.onPatch(allowlistPath, next);
          }}
        >
          ${icon("plus", { size: 14 })}
          <span>Add pattern</span>
        </button>
      </div>

      <div class="allowlist-entries">
        ${entries.length === 0
          ? html`
              <div class="allowlist-empty">
                <div class="muted">No allowlist entries yet.</div>
              </div>
            `
          : entries.map((entry, index) =>
              renderAllowlistEntry(state, entry, index),
            )}
      </div>
    </div>
  `;
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatAgo(entry.lastUsedAt) : "never";
  const lastCommand = entry.lastUsedCommand
    ? clampText(entry.lastUsedCommand, 100)
    : null;
  const lastPath = entry.lastResolvedPath
    ? clampText(entry.lastResolvedPath, 100)
    : null;

  return html`
    <div class="allowlist-entry">
      <div class="allowlist-entry__main">
        <label class="field">
          <span>Pattern</span>
          <input
            type="text"
            .value=${entry.pattern ?? ""}
            placeholder="e.g., /usr/bin/*"
            ?disabled=${state.disabled}
            @input=${(event: Event) => {
              const target = event.target as HTMLInputElement;
              state.onPatch(
                ["agents", state.selectedScope, "allowlist", index, "pattern"],
                target.value,
              );
            }}
          />
        </label>
        <div class="allowlist-entry__meta">
          <span class="muted">Last used: ${lastUsed}</span>
          ${lastCommand ? html`<span class="mono">${lastCommand}</span>` : nothing}
          ${lastPath ? html`<span class="mono muted">${lastPath}</span>` : nothing}
        </div>
      </div>
      <button
        class="btn btn--danger btn--sm btn--icon"
        ?disabled=${state.disabled}
        @click=${() => {
          if (state.allowlist.length <= 1) {
            state.onRemove(["agents", state.selectedScope, "allowlist"]);
            return;
          }
          state.onRemove(["agents", state.selectedScope, "allowlist", index]);
        }}
      >
        ${icon("trash", { size: 14 })}
      </button>
    </div>
  `;
}

function renderAgentBindingCard(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name}` : agent.id;
  const supportsBinding = state.nodes.length > 0;

  return html`
    <div class="binding-card binding-card--modern">
      <div class="binding-card__header">
        <div class="binding-card__icon binding-card__icon--agent">
          ${icon("user", { size: 18 })}
        </div>
        <div class="binding-card__info">
          <div class="binding-card__name">${label}</div>
          <div class="binding-card__desc">
            ${agent.isDefault ? "default agent" : "agent"} ·
            ${bindingValue === "__default__"
              ? `uses default (${state.defaultBinding ?? "any"})`
              : `override: ${agent.binding}`}
          </div>
        </div>
        ${agent.isDefault
          ? html`<span class="badge badge--accent badge--animated badge--sm">Default</span>`
          : nothing}
      </div>
      <div class="binding-card__control">
        <label class="field">
          <span>Binding</span>
          <select
            ?disabled=${state.disabled || !supportsBinding}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value.trim();
              state.onBindAgent(agent.index, value === "__default__" ? null : value);
            }}
          >
            <option value="__default__" ?selected=${bindingValue === "__default__"}>
              Use default
            </option>
            ${state.nodes.map(
              (node) =>
                html`<option
                  value=${node.id}
                  ?selected=${bindingValue === node.id}
                >
                  ${node.label}
                </option>`,
            )}
          </select>
        </label>
      </div>
    </div>
  `;
}

function resolveExecNodes(nodes: Array<Record<string, unknown>>): BindingNode[] {
  const list: BindingNode[] = [];
  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some((cmd) => String(cmd) === "system.run");
    if (!supports) continue;
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) continue;
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({ id: nodeId, label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}` });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

function resolveExecApprovalsNodes(nodes: Array<Record<string, unknown>>): ExecApprovalsTargetNode[] {
  const list: ExecApprovalsTargetNode[] = [];
  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some(
      (cmd) => String(cmd) === "system.execApprovals.get" || String(cmd) === "system.execApprovals.set",
    );
    if (!supports) continue;
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) continue;
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({ id: nodeId, label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}` });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

function resolveAgentBindings(config: Record<string, unknown> | null): {
  defaultBinding?: string | null;
  agents: BindingAgent[];
} {
  const fallbackAgent: BindingAgent = {
    id: "main",
    name: undefined,
    index: 0,
    isDefault: true,
    binding: null,
  };
  if (!config || typeof config !== "object") {
    return { defaultBinding: null, agents: [fallbackAgent] };
  }
  const tools = (config.tools ?? {}) as Record<string, unknown>;
  const exec = (tools.exec ?? {}) as Record<string, unknown>;
  const defaultBinding =
    typeof exec.node === "string" && exec.node.trim() ? exec.node.trim() : null;

  const agentsNode = (config.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  if (list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents: BindingAgent[] = [];
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return;
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const isDefault = record.default === true;
    const toolsEntry = (record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim()
        ? execEntry.node.trim()
        : null;
    agents.push({
      id,
      name: name || undefined,
      index,
      isDefault,
      binding,
    });
  });

  if (agents.length === 0) {
    agents.push(fallbackAgent);
  }

  return { defaultBinding, agents };
}
