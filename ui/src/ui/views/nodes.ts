import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import { t } from "../../i18n/index.ts";
import type { DeviceTokenSummary, PairedDevice, PendingDevice } from "../controllers/devices.ts";
import { formatRelativeTimestamp, formatList } from "../format.ts";
import { normalizeOptionalString } from "../string-coerce.ts";
import { renderExecApprovals, resolveExecApprovalsState } from "./nodes-exec-approvals.ts";
import { resolveConfigAgents, resolveNodeTargets, type NodeTargetOption } from "./nodes-shared.ts";
export type { NodesProps } from "./nodes.types.ts";
import type { NodesProps } from "./nodes.types.ts";

/** Inline so wrapping survives any stylesheet order / stale bundles; grid+flex min-sizing can't suppress these. */
const NODES_WRAP_BREAK_ALL: Readonly<Record<string, string>> = {
  overflowWrap: "anywhere",
  wordBreak: "break-all",
  maxWidth: "100%",
  minWidth: "0",
  whiteSpace: "normal",
};

const NODES_WRAP_SOFT: Readonly<Record<string, string>> = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  maxWidth: "100%",
  minWidth: "0",
  whiteSpace: "normal",
};

/** Inserts `<wbr>` so lines can break even when CSS min-content / caching fights `word-break`. */
function htmlChunkWithBreaks(text: string, chunkSize: number): TemplateResult {
  const n = Math.max(8, Math.floor(chunkSize));
  if (text.length <= n) {
    return html`${text}`;
  }
  const parts: Array<string | TemplateResult> = [];
  for (let i = 0; i < text.length; i += n) {
    if (i > 0) {
      parts.push(html`<wbr />`);
    }
    parts.push(text.slice(i, i + n));
  }
  return html`${parts}`;
}

export function renderNodes(props: NodesProps) {
  const bindingState = resolveBindingsState(props);
  const approvalsState = resolveExecApprovalsState(props);
  return html`
    ${renderExecApprovals(approvalsState)} ${renderBindings(bindingState)} ${renderDevices(props)}
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Nodes</div>
          <div class="card-sub">Paired devices and live links.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      <div class="list" style="margin-top: 16px;">
        ${props.nodes.length === 0
          ? html` <div class="muted">No nodes found.</div> `
          : props.nodes.map((n) => renderNode(n))}
      </div>
    </section>
  `;
}

function renderDevices(props: NodesProps) {
  const list = props.devicesList ?? { pending: [], paired: [] };
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const paired = Array.isArray(list.paired) ? list.paired : [];
  const pairedByDeviceId = new Map(
    paired
      .map((device) => [normalizeOptionalString(device.deviceId), device] as const)
      .filter((entry): entry is [string, PairedDevice] => Boolean(entry[0])),
  );
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Devices</div>
          <div class="card-sub">Pairing requests + role tokens.</div>
        </div>
        <button class="btn" ?disabled=${props.devicesLoading} @click=${props.onDevicesRefresh}>
          ${props.devicesLoading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>
      ${props.devicesError
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.devicesError}</div>`
        : nothing}
      <div class="list" style="margin-top: 16px;">
        ${pending.length > 0
          ? html`
              <div class="muted" style="margin-bottom: 8px;">Pending</div>
              ${pending.map((req) =>
                renderPendingDevice(req, props, lookupPairedDevice(pairedByDeviceId, req)),
              )}
            `
          : nothing}
        ${paired.length > 0
          ? html`
              <div class="muted" style="margin-top: 12px; margin-bottom: 8px;">Paired</div>
              ${paired.map((device) => renderPairedDevice(device, props))}
            `
          : nothing}
        ${pending.length === 0 && paired.length === 0
          ? html` <div class="muted">No paired devices.</div> `
          : nothing}
      </div>
    </section>
  `;
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const deviceId = normalizeOptionalString(request.deviceId);
  if (!deviceId) {
    return undefined;
  }
  const paired = pairedByDeviceId.get(deviceId);
  if (!paired) {
    return undefined;
  }
  const requestPublicKey = normalizeOptionalString(request.publicKey);
  const pairedPublicKey = normalizeOptionalString(paired.publicKey);
  if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) {
    return undefined;
  }
  return paired;
}

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return "none";
  }
  return `roles: ${formatList(access.roles)} · scopes: ${formatList(access.scopes)}`;
}

function renderPendingApprovalNote(kind: PendingDeviceApprovalKind) {
  switch (kind) {
    case "scope-upgrade":
      return "scope upgrade requires approval";
    case "role-upgrade":
      return "role upgrade requires approval";
    case "re-approval":
      return "reconnect details changed; approval required";
    case "new-pairing":
      return "new device pairing request";
  }
  const exhaustiveKind: never = kind;
  void exhaustiveKind;
  throw new Error("unsupported pending approval kind");
}

function renderPendingDevice(req: PendingDevice, props: NodesProps, paired?: PairedDevice) {
  const name = normalizeOptionalString(req.displayName) || req.deviceId;
  const age = typeof req.ts === "number" ? formatRelativeTimestamp(req.ts) : t("common.na");
  const approval = resolvePendingDeviceApprovalState(req, paired);
  const repair = req.isRepair ? " · repair" : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="list-item">
      <div class="list-main">
        <div class="list-title">${name}</div>
        <div class="list-sub">${req.deviceId}${ip}</div>
        <div class="muted" style="margin-top: 6px;">
          ${renderPendingApprovalNote(approval.kind)} · requested ${age}${repair}
        </div>
        <div class="muted" style="margin-top: 6px;">
          requested: ${formatAccessSummary(approval.requested)}
        </div>
        ${approval.approved
          ? html`
              <div class="muted" style="margin-top: 6px;">
                approved now: ${formatAccessSummary(approval.approved)}
              </div>
            `
          : nothing}
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
  const displayName = normalizeOptionalString(device.displayName);
  const technicalId = device.deviceId.trim();
  const ip = device.remoteIp ? ` · ${device.remoteIp}` : "";
  const titleLabel = displayName || technicalId;
  const showTechnicalIdRow = Boolean(displayName && displayName.trim() !== technicalId);
  const roles = `roles: ${formatList(device.roles)}`;
  const scopes = `scopes: ${formatList(device.scopes)}`;
  const tokens = Array.isArray(device.tokens) ? device.tokens : [];
  const titleHexClass = showTechnicalIdRow || !technicalId ? "" : "nodes-device-paired__device-id";
  const titleUsesBreakAll = Boolean(technicalId) && !showTechnicalIdRow;
  const titleInline = titleUsesBreakAll ? NODES_WRAP_BREAK_ALL : NODES_WRAP_SOFT;
  const titleText = `${titleLabel}${showTechnicalIdRow ? "" : ip}`;
  const idRowText = `${technicalId}${ip}`;
  const rolesScopesText = `${roles} · ${scopes}`;
  return html`
    <div class="list-item nodes-device-paired">
      <div class="list-main">
        <div class="list-title ${titleHexClass}" style=${styleMap(titleInline)}>
          ${titleUsesBreakAll || titleText.length > 48
            ? htmlChunkWithBreaks(titleText, 14)
            : html`${titleText}`}
        </div>
        ${showTechnicalIdRow
          ? html`<div
              class="list-sub nodes-device-paired__device-id"
              style=${styleMap(NODES_WRAP_BREAK_ALL)}
            >
              ${htmlChunkWithBreaks(idRowText, 14)}
            </div>`
          : nothing}
        <div
          class="muted nodes-device-paired__meta"
          style=${styleMap({ ...NODES_WRAP_BREAK_ALL, marginTop: "6px" })}
        >
          ${htmlChunkWithBreaks(rolesScopesText, 28)}
        </div>
        ${tokens.length === 0
          ? html`
              <div class="muted nodes-device-paired__meta" style="margin-top: 6px">
                Tokens: none
              </div>
            `
          : html`
              <div class="muted" style="margin-top: 10px;">Tokens</div>
              <div class="nodes-device-token-list">
                ${tokens.map((token) => renderTokenRow(device.deviceId, token, props))}
              </div>
            `}
      </div>
    </div>
  `;
}

function renderTokenRow(deviceId: string, token: DeviceTokenSummary, props: NodesProps) {
  const status = token.revokedAtMs ? "revoked" : "active";
  const scopes = `scopes: ${formatList(token.scopes)}`;
  const when = formatRelativeTimestamp(
    token.rotatedAtMs ?? token.createdAtMs ?? token.lastUsedAtMs ?? null,
  );
  const detailText = `${token.role} · ${status} · ${scopes} · ${when}`;
  return html`
    <div class="nodes-device-token-row">
      <div class="list-sub nodes-device-token-row__detail" style=${styleMap(NODES_WRAP_BREAK_ALL)}>
        ${htmlChunkWithBreaks(detailText, 28)}
      </div>
      <div class="nodes-device-token-row__actions">
        <button
          class="btn btn--sm"
          @click=${() => props.onDeviceRotate(deviceId, token.role, token.scopes)}
        >
          Rotate
        </button>
        ${token.revokedAtMs
          ? nothing
          : html`
              <button
                class="btn btn--sm danger"
                @click=${() => props.onDeviceRevoke(deviceId, token.role)}
              >
                Revoke
              </button>
            `}
      </div>
    </div>
  `;
}

type BindingAgent = {
  id: string;
  name: string | undefined;
  index: number;
  isDefault: boolean;
  binding: string | null;
};

type BindingNode = NodeTargetOption;

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

function renderBindings(state: BindingState) {
  const supportsBinding = state.nodes.length > 0;
  const defaultValue = state.defaultBinding ?? "";
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">${t("nodes.binding.execNodeBinding")}</div>
          <div class="card-sub">${t("nodes.binding.execNodeBindingSubtitle")}</div>
        </div>
        <button
          class="btn"
          ?disabled=${state.disabled || !state.configDirty}
          @click=${state.onSave}
        >
          ${state.configSaving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      ${state.formMode === "raw"
        ? html`
            <div class="callout warn" style="margin-top: 12px">
              ${t("nodes.binding.formModeHint")}
            </div>
          `
        : nothing}
      ${!state.ready
        ? html`<div class="row" style="margin-top: 12px; gap: 12px;">
            <div class="muted">${t("nodes.binding.loadConfigHint")}</div>
            <button class="btn" ?disabled=${state.configLoading} @click=${state.onLoadConfig}>
              ${state.configLoading ? t("common.loading") : t("common.loadConfig")}
            </button>
          </div>`
        : html`
            <div class="list" style="margin-top: 16px;">
              <div class="list-item">
                <div class="list-main">
                  <div class="list-title">${t("nodes.binding.defaultBinding")}</div>
                  <div class="list-sub">${t("nodes.binding.defaultBindingHint")}</div>
                </div>
                <div class="list-meta">
                  <label class="field">
                    <span>${t("nodes.binding.node")}</span>
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
                          html`<option value=${node.id} ?selected=${defaultValue === node.id}>
                            ${node.label}
                          </option>`,
                      )}
                    </select>
                  </label>
                  ${!supportsBinding
                    ? html` <div class="muted">No nodes with system.run available.</div> `
                    : nothing}
                </div>
              </div>

              ${state.agents.length === 0
                ? html` <div class="muted">No agents found.</div> `
                : state.agents.map((agent) => renderAgentBinding(agent, state))}
            </div>
          `}
    </section>
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
          ${agent.isDefault ? "default agent" : "agent"} ·
          ${bindingValue === "__default__"
            ? `uses default (${state.defaultBinding ?? "any"})`
            : `override: ${agent.binding}`}
        </div>
      </div>
      <div class="list-meta">
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
                html`<option value=${node.id} ?selected=${bindingValue === node.id}>
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
  return resolveNodeTargets(nodes, ["system.run"]);
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
  if (!Array.isArray(agentsNode.list) || agentsNode.list.length === 0) {
    return { defaultBinding, agents: [fallbackAgent] };
  }

  const agents = resolveConfigAgents(config).map((entry) => {
    const toolsEntry = (entry.record.tools ?? {}) as Record<string, unknown>;
    const execEntry = (toolsEntry.exec ?? {}) as Record<string, unknown>;
    const binding =
      typeof execEntry.node === "string" && execEntry.node.trim() ? execEntry.node.trim() : null;
    return {
      id: entry.id,
      name: entry.name,
      index: entry.index,
      isDefault: entry.isDefault,
      binding,
    };
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
