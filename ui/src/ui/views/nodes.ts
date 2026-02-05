import { html, nothing } from "lit";
import type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../controllers/devices.ts";
import type {
  ExecApprovalsAllowlistEntry,
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "../controllers/exec-approvals.ts";
import { t } from "../../i18n/i18n";
import { clampText, formatAgo, formatList } from "../format.ts";

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

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  return html`
    ${renderExecApprovals(approvalsState)}
    ${renderBindings(bindingState)}
    ${renderDevices(props)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("nodes.nodes_title")}</div>
          <div class="card-sub">${t("nodes.nodes_subtitle")}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh_button")}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${
          props.nodes.length === 0
            ? html`
                <div class="muted">${t("nodes.no_nodes_found")}</div>
              `
            : props.nodes.map((n) => renderNode(n))
        }
      </div>
    </section>
  `;
}

function renderDevices(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${t("nodes.devices_title")}</div>
          <div class="card-sub">${t("nodes.devices_subtitle")}</div>
        </div>
        <button class="btn" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
          ${props.devicesLoading ? t("common.loading") : t("common.refresh_button")}
        </button>
      </div>
      ${
        props.devicesError
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.devicesError}</div>`
          : nothing
      }
      <div class="list" style="margin-top: 16px;">
        ${
          pending.length > 0
            ? html`
              <div class="muted" style="margin-bottom: 8px;">${t("nodes.pending_label")}</div>
              ${pending.map((req) => renderPendingDevice(req, props))}
            `
            : nothing
        }
        ${
          paired.length > 0
            ? html`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">${t("nodes.paired_label")}</div>
              ${paired.map((device) => renderPairedDevice(device, props))}
            `
            : nothing
        }
        ${
          pending.length === 0 && paired.length === 0
            ? html`
                <div class="muted">${t("nodes.no_paired_devices")}</div>
              `
            : nothing
        }
      </div>
    </section>
  `;
}

function renderPendingDevice(req: PendingDevice, props: NodesProps) {
  const name = req.displayName?.trim() || req.deviceId;
  const age = typeof req.ts === "number" ? formatAgo(req.ts) : "n/a";
  const role = req.role?.trim() ? `role: ${req.role}` : "role: -";
  const repair = req.isRepair ? " · repair" : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${req.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          ${role} · requested ${age}${repair}
        </div>
      </div>
      <div class="list-meta">
        <div class="row" style="justify-content: flex-end; gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm primary" @click=${() => props.onDeviceApprove(req.requestId)}>
            Approve
          </button>
          <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderPairedDevice(device: PairedDevice, props: NodesProps) {
  const name = device.displayName?.trim() || device.deviceId;
  const ip = device.remoteIp ? ` · ${device.remoteIp}` : "";
  const roles = `roles: ${formatList(device.roles)}`;
  const scopes = `scopes: ${formatList(device.scopes)}`;
  const tokens = Array.isArray(device.tokens) ? device.tokens : [];
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${device.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">${roles} · ${scopes}</div>
        ${
          tokens.length === 0
            ? html`
                <div class="muted" style="margin-top: 6px">${t("nodes.tokens_none")}</div>
              `
            : html`
              <div class="muted" style="margin-top: 10px;">${t("nodes.tokens_label")}</div>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 6px;">
                ${tokens.map((token) => renderTokenRow(device.deviceId, token, props))}
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? "revoked" : "active";
  const scopes = `scopes: ${formatList(token.scopes)}`;
  const when = formatAgo(token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null);
  return html`
    <div class="row" style="justify-content: space-between; gap: 8px;">
      <div class="list-sub">${token.role} · ${status} · ${scopes} · ${when}</div>
      <div class="row" style="justify-content: flex-end; gap: 6px; flex-wrap: wrap;">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          Rotate
        </button>
        ${
          token.revokedAtMs
            ? nothing
            : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                Revoke
              </button>
            `
        }
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
  if (value === "allowlist" || value === "full" || value === "deny") {
    return value;
  }
  return "deny";
}

function normalizeAsk(value?: string): ExecAsk {
  if (value === "always" || value === "off" || value === "on-miss") {
    return value;
  }
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
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return;
    }
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
    if (merged.has(id)) {
      return;
    }
    merged.set(id, { id });
  });
  const agents = Array.from(merged.values());
  if (agents.length === 0) {
    agents.push({ id: "main", isDefault: true });
  }
  agents.sort((a, b) => {
    if (a.isDefault && !b.isDefault) {
      return -1;
    }
    if (!a.isDefault && b.isDefault) {
      return 1;
    }
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
  if (selected === EXEC_APPROVALS_DEFAULT_SCOPE) {
    return EXEC_APPROVALS_DEFAULT_SCOPE;
  }
  if (selected && agents.some((agent) => agent.id === selected)) {
    return selected;
  }
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
    target === "node" && props.execApprovalsTargetNodeId ? props.execApprovalsTargetNodeId : null;
  if (target === "node" && targetNodeId && !targetNodes.some((node) => node.id === targetNodeId)) {
    targetNodeId = null;
  }
  const selectedScope = resolveExecApprovalsScope(props.execApprovalsSelectedAgent, agents);
  const selectedAgent =
    selectedScope !== EXEC_APPROVALS_DEFAULT_SCOPE
      ? (((form?.agents ?? {})[selectedScope] as Record<string, unknown> | undefined) ?? null)
      : null;
  const allowlist = Array.isArray((selectedAgent as { allowlist?: unknown })?.allowlist)
    ? ((selectedAgent as { allowlist?: ExecApprovalsAllowlistEntry[] }).allowlist ?? [])
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

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t("nodes.exec_node_binding_title")}</div>
          <div class="card-sub">
            ${t("nodes.exec_node_binding_subtitle")}<span class="mono">exec host=node</span>.
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.configDirty}
          @click=${state.onSave}
        >
          ${state.configSaving ? t("common.saving") : t("common.save_button")}
        </button>
      </div>

      ${
        state.formMode === "raw"
          ? html`
              <div class="callout warn" style="margin-top: 12px">
                ${t("nodes.switch_config_form_mode")}
              </div>
            `
          : nothing
      }

      ${
        !state.ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t("nodes.load_config_to_edit")}</div>
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? t("common.loading") : t("nodes.load_config_button")}
            </button>
          </div>`
          : html`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t("nodes.default_binding_title")}</div>
                  <div class="list-sub">${t("nodes.default_binding_subtitle")}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${t("nodes.node_label")}</span>
                    <select
                      ?disabled=${state.disabled || !supportsBinding}
                      @change=${(event: Event) => {
                        const target = event.target as HTMLSelectElement;
                        const value = target.value.trim();
                        state.onBindDefault(value ? value : null);
                      }}
                    >
                      <option value="" ?selected=${defaultValue === ""}>${t("nodes.any_node_option")}</option>
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
                  ${
                    !supportsBinding
                      ? html`<div class="muted">${t("nodes.no_nodes_with_system_run")}</div>`
                      : nothing
                  }
                </div>
              </div>

              ${
                state.agents.length === 0
                  ? html`<div class="muted">${t("nodes.no_agents_found")}</div>`
                  : state.agents.map((agent) => renderAgentBinding(agent, state))
              }
            </div>
          `
      }
    </section>
  `;
}

function renderExecApprovals(state: ExecApprovalsState) {
  const ready = state.ready;
  const targetReady = state.target !== "node" || Boolean(state.targetNodeId);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t("nodes.exec_approvals_title")}</div>
          <div class="card-sub">
            ${t("nodes.exec_approvals_subtitle")}
          </div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.dirty || !targetReady}
          @click=${state.onSave}
        >
          ${state.saving ? t("common.saving") : t("common.save_button")}
        </button>
      </div>

      ${renderExecApprovalsTarget(state)}

      ${
        !ready
          ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t("nodes.load_exec_approvals")}</div>
            <button class="btn" ?disabled=${state.loading || !targetReady} @click=${state.onLoad}>
              ${state.loading ? t("common.loading") : t("nodes.load_approvals_button")}
            </button>
          </div>`
          : html`
            ${renderExecApprovalsTabs(state)}
            ${renderExecApprovalsPolicy(state)}
            ${
              state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE
                ? nothing
                : renderExecApprovalsAllowlist(state)
            }
          `
      }
    </section>
  `;
}

function renderExecApprovalsTarget(state: ExecApprovalsState) {
  const hasNodes = state.targetNodes.length > 0;
  const nodeValue = state.targetNodeId ?? "";
  return html`
    <div class="list" style="margin-top: 12px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.target_title")}</div>
          <div class="list-sub">
            ${t("nodes.target_subtitle")}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.host_label")}</span>
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
              <option value="gateway" ?selected=${state.target === "gateway"}>${t("nodes.gateway_option")}</option>
              <option value="node" ?selected=${state.target === "node"}>${t("nodes.node_option")}</option>
            </select>
          </label>
          ${
            state.target === "node"
              ? html`
                <label class="field">
                  <span>${t("nodes.node_label")}</span>
                  <select
                    ?disabled=${state.disabled || !hasNodes}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLSelectElement;
                      const value = target.value.trim();
                      state.onSelectTarget("node", value ? value : null);
                    }}
                  >
                    <option value="" ?selected=${nodeValue === ""}>${t("nodes.select_node_option")}</option>
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
              : nothing
          }
        </div>
      </div>
      ${
        state.target === "node" && !hasNodes
          ? html`<div class="muted">${t("nodes.no_nodes_advertise_exec_approvals")}</div>`
          : nothing
      }
    </div>
  `;
}

function renderExecApprovalsTabs(state: ExecApprovalsState) {
  return html`
    <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap;">
      <span class="label">${t("nodes.scope_label")}</span>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <button
          class="btn btn--sm ${state.selectedScope === EXEC_APPROVALS_DEFAULT_SCOPE ? "active" : ""}"
          @click=${() => state.onSelectScope(EXEC_APPROVALS_DEFAULT_SCOPE)}
        >
          ${t("nodes.defaults_button")}
        </button>
        ${state.agents.map((agent) => {
          const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
          return html`
            <button
              class="btn btn--sm ${state.selectedScope === agent.id ? "active" : ""}"
              @click=${() => state.onSelectScope(agent.id)}
            >
              ${label}
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
  const agentAskFallback = typeof agent.askFallback === "string" ? agent.askFallback : undefined;
  const securityValue = isDefaults ? defaults.security : (agentSecurity ?? "__default__");
  const askValue = isDefaults ? defaults.ask : (agentAsk ?? "__default__");
  const askFallbackValue = isDefaults ? defaults.askFallback : (agentAskFallback ?? "__default__");
  const autoOverride =
    typeof agent.autoAllowSkills === "boolean" ? agent.autoAllowSkills : undefined;
  const autoEffective = autoOverride ?? defaults.autoAllowSkills;
  const autoIsDefault = autoOverride == null;

  return html`
    <div class="list" style="margin-top: 16px;">
      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.security_title")}</div>
          <div class="list-sub">
            ${
              isDefaults
                ? t("nodes.default_security_mode")
                : t("common.default_value", { value: defaults.security })
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.mode_label")}</span>
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
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${securityValue === "__default__"}>
                    ${t("nodes.use_default_button")} (${defaults.security})
                  </option>`
                  : nothing
              }
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
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.ask_title")}</div>
          <div class="list-sub">
            ${isDefaults ? t("nodes.default_prompt_policy") : t("common.default_value", { value: defaults.ask })}
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.mode_label")}</span>
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
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askValue === "__default__"}>
                    ${t("nodes.use_default_button")} (${defaults.ask})
                  </option>`
                  : nothing
              }
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
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.ask_fallback_title")}</div>
          <div class="list-sub">
            ${
              isDefaults
                ? t("nodes.applied_when_ui_unavailable")
                : t("common.default_value", { value: defaults.askFallback })
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.fallback_label")}</span>
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
              ${
                !isDefaults
                  ? html`<option value="__default__" ?selected=${askFallbackValue === "__default__"}>
                    ${t("nodes.use_default_button")} (${defaults.askFallback})
                  </option>`
                  : nothing
              }
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
      </div>

      <div class="list-item">
        <div class="list-main">
          <div class="list-title">${t("nodes.auto_allow_skill_clis_title")}</div>
          <div class="list-sub">
            ${
              isDefaults
                ? t("nodes.allow_skill_executables")
                : autoIsDefault
                  ? t("nodes.using_default_value", {
                      value: defaults.autoAllowSkills ? t("nodes.on_value") : t("nodes.off_value"),
                    })
                  : t("common.override_value", {
                      value: autoEffective ? t("nodes.on_value") : t("nodes.off_value"),
                    })
            }
          </div>
        </div>
        <div class="list-meta">
          <label class="field">
            <span>${t("nodes.enabled_label")}</span>
            <input
              type="checkbox"
              ?disabled=${state.disabled}
              .checked=${autoEffective}
              @change=${(event: Event) => {
                const target = event.target as HTMLInputElement;
                state.onPatch([...basePath, "autoAllowSkills"], target.checked);
              }}
            />
          </label>
          ${
            !isDefaults && !autoIsDefault
              ? html`<button
                class="btn btn--sm"
                ?disabled=${state.disabled}
                @click=${() => state.onRemove([...basePath, "autoAllowSkills"])}
              >
                ${t("nodes.use_default_button")}
              </button>`
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

function renderExecApprovalsAllowlist(state: ExecApprovalsState) {
  const allowlistPath = ["agents", state.selectedScope, "allowlist"];
  const entries = state.allowlist;
  return html`
    <div class="row" style="margin-top: 18px; justify-content: space-between;">
      <div>
        <div class="card-title">${t("nodes.allowlist_title")}</div>
        <div class="card-sub">${t("nodes.case_insensitive_glob_patterns")}</div>
      </div>
      <button
        class="btn btn--sm"
        ?disabled=${state.disabled}
        @click=${() => {
          const next = [...entries, { pattern: "" }];
          state.onPatch(allowlistPath, next);
        }}
      >
        ${t("nodes.add_pattern_button")}
      </button>
    </div>
    <div class="list" style="margin-top: 12px;">
      ${
        entries.length === 0
          ? html`<div class="muted">${t("nodes.no_allowlist_entries")}</div>`
          : entries.map((entry, index) => renderAllowlistEntry(state, entry, index))
      }
    </div>
  `;
}

function renderAllowlistEntry(
  state: ExecApprovalsState,
  entry: ExecApprovalsAllowlistEntry,
  index: number,
) {
  const lastUsed = entry.lastUsedAt ? formatAgo(entry.lastUsedAt) : "never";
  const lastCommand = entry.lastUsedCommand ? clampText(entry.lastUsedCommand, 120) : null;
  const lastPath = entry.lastResolvedPath ? clampText(entry.lastResolvedPath, 120) : null;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${entry.pattern?.trim() ? entry.pattern : "New pattern"}</div>
        <div class="list-sub">Last used: ${lastUsed}</div>
        ${lastCommand ? html`<div class="list-sub mono">${lastCommand}</div>` : nothing}
        ${lastPath ? html`<div class="list-sub mono">${lastPath}</div>` : nothing}
      </div>
      <div class="list-meta">
        <label class="field">
          <span>${t("nodes.pattern_label")}</span>
          <input
            type="text"
            .value=${entry.pattern ?? ""}
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
        <button
          class="btn btn--sm danger"
          ?disabled=${state.disabled}
          @click=${() => {
            if (state.allowlist.length <= 1) {
              state.onRemove(["agents", state.selectedScope, "allowlist"]);
              return;
            }
            state.onRemove(["agents", state.selectedScope, "allowlist", index]);
          }}
        >
          ${t("nodes.remove_button")}
        </button>
      </div>
    </div>
  `;
}

function renderAgentBinding(agent: BindingAgent, state: BindingState) {
  const bindingValue = agent.binding ?? "__default__";
  const label = agent.name?.trim() ? `${agent.name} (${agent.id})` : agent.id;
  const supportsBinding = state.nodes.length > 0;
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${label}</div>
        <div class="list-sub">
          ${agent.isDefault ? t("nodes.default_agent") : t("nodes.agent")} ·
          ${
            bindingValue === "__default__"
              ? t("common.uses_default_value", {
                  value: state.defaultBinding ?? t("nodes.any_value"),
                })
              : t("common.override_value_simple", { value: agent.binding ?? t("nodes.any_value") })
          }
        </div>
      </div>
      <div class="list-meta">
        <label class="field">
          <span>${t("nodes.binding_label")}</span>
          <select
            ?disabled=${state.disabled || !supportsBinding}
            @change=${(event: Event) => {
              const target = event.target as HTMLSelectElement;
              const value = target.value.trim();
              state.onBindAgent(agent.index, value === "__default__" ? null : value);
            }}
          >
            <option value="__default__" ?selected=${bindingValue === "__default__"}>
              ${t("nodes.use_default_button")}
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
    if (!supports) {
      continue;
    }
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) {
      continue;
    }
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }
  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}

function resolveExecApprovalsNodes(
  nodes: Array<Record<string, unknown>>,
): ExecApprovalsTargetNode[] {
  const list: ExecApprovalsTargetNode[] = [];
  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some(
      (cmd) =>
        String(cmd) === "system.execApprovals.get" || String(cmd) === "system.execApprovals.set",
    );
    if (!supports) {
      continue;
    }
    const nodeId = typeof node.nodeId === "string" ? node.nodeId.trim() : "";
    if (!nodeId) {
      continue;
    }
    const displayName =
      typeof node.displayName === "string" && node.displayName.trim()
        ? node.displayName.trim()
        : nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
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
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      return;
    }
    const name = typeof record.name === "string" ? record.name.trim() : undefined;
    const isDefault = record.default === true;
    const toolsEntry = (record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
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

function renderNode(node: Record<string, unknown>) {
  const connected = Boolean(node.connected);
  const paired = Boolean(node.paired);
  const title =
    (typeof node.displayName === "string" && node.displayName.trim()) ||
    (typeof node.nodeId === "string" ? node.nodeId : "unknown");
  const caps = Array.isArray(node.caps) ? (node.caps as unknown[]) : [];
  const commands = Array.isArray(node.commands) ? (node.commands as unknown[]) : [];
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${title}</div>
        <div class="list-sub">
          ${typeof node.nodeId === "string" ? node.nodeId : ""}
          ${typeof node.remoteIp === "string" ? ` · ${node.remoteIp}` : ""}
          ${typeof node.version === "string" ? ` · ${node.version}` : ""}
        </div>
        <div class="chip-row" style="margin-top: 6px;">
          <span class="chip">${paired ? "paired" : "unpaired"}</span>
          <span class="chip ${connected ? "chip-ok" : "chip-warn"}">
            ${connected ? "connected" : "offline"}
          </span>
          ${caps.slice(0, 12).map((c) => html`<span class="chip">${String(c)}</span>`)}
          ${commands.slice(0, 8).map((c) => html`<span class="chip">${String(c)}</span>`)}
        </div>
      </div>
    </div>
  `;
}
