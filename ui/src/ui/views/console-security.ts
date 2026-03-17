/**
 * Security Policy Observer – displays tool policies, skill gating,
 * plugin trust boundaries, and hook configurations.
 */

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type {
  SecuritySnapshot,
  ToolPolicy,
  SkillGatingRule,
  PluginTrustEntry,
  HookEntry,
} from "../types/console-types.ts";

export type ConsoleSecurityProps = {
  loading: boolean;
  error: string | null;
  snapshot: SecuritySnapshot | null;
  activeTab: "tools" | "skills" | "plugins" | "hooks";
  onTabChange: (tab: "tools" | "skills" | "plugins" | "hooks") => void;
  onRefresh: () => void;
};

function actionBadgeClass(action: string): string {
  switch (action) {
    case "allow":
      return "data-table-badge--direct";
    case "deny":
      return "data-table-badge--unknown";
    case "ask":
      return "data-table-badge--group";
    case "gated":
      return "data-table-badge--global";
    default:
      return "";
  }
}

function trustLevelBadge(level: string): string {
  switch (level) {
    case "builtin":
      return "data-table-badge--direct";
    case "verified":
      return "data-table-badge--group";
    case "community":
      return "data-table-badge--global";
    case "local":
      return "data-table-badge--unknown";
    default:
      return "";
  }
}

function integrityBadge(integrity: string): string {
  switch (integrity) {
    case "verified":
      return "data-table-badge--direct";
    case "unverified":
      return "data-table-badge--global";
    case "tampered":
      return "data-table-badge--unknown";
    default:
      return "";
  }
}

function renderToolPolicies(policies: ToolPolicy[]) {
  return html`
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Action</th>
            <th>Conditions</th>
            <th>Source</th>
            <th>Priority</th>
          </tr>
        </thead>
        <tbody>
          ${policies.map(
            (policy) => html`
              <tr>
                <td><span class="mono">${policy.toolName}</span></td>
                <td>
                  <span class="data-table-badge ${actionBadgeClass(policy.action)}">
                    ${policy.action}
                  </span>
                </td>
                <td>
                  ${
                    policy.conditions.length > 0
                      ? policy.conditions.map(
                          (c) => html`<span class="security-condition">${c}</span>`,
                        )
                      : html`<span class="muted">\u2014</span>`
                  }
                </td>
                <td>${policy.source}</td>
                <td>${policy.priority}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderSkillGating(rules: SkillGatingRule[]) {
  return html`
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Trust Level</th>
            <th>Gated</th>
            <th>API Key Required</th>
            <th>API Key Set</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${rules.map(
            (rule) => html`
              <tr>
                <td>
                  <div>
                    <span>${rule.skillName}</span>
                    <span class="mono muted" style="font-size: 12px; display: block;">${rule.skillKey}</span>
                  </div>
                </td>
                <td>
                  <span class="data-table-badge ${trustLevelBadge(rule.trustLevel)}">
                    ${rule.trustLevel}
                  </span>
                </td>
                <td>
                  <span class="data-table-badge ${rule.gated ? "data-table-badge--global" : "data-table-badge--direct"}">
                    ${rule.gated ? "gated" : "open"}
                  </span>
                </td>
                <td>${rule.requiredApiKey ? "yes" : "no"}</td>
                <td>
                  ${
                    rule.requiredApiKey
                      ? html`
                          <span class="data-table-badge ${rule.hasApiKey ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                            ${rule.hasApiKey ? "configured" : "missing"}
                          </span>
                        `
                      : html`<span class="muted">\u2014</span>`
                  }
                </td>
                <td>${rule.source}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderPluginTrust(entries: PluginTrustEntry[]) {
  return html`
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Trusted</th>
            <th>Integrity</th>
            <th>Version</th>
            <th>Permissions</th>
            <th>Reason</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(
            (entry) => html`
              <tr>
                <td>
                  <div>
                    <span>${entry.pluginName}</span>
                    <span class="mono muted" style="font-size: 12px; display: block;">${entry.pluginId}</span>
                  </div>
                </td>
                <td>
                  <span class="data-table-badge ${entry.trusted ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                    ${entry.trusted ? "trusted" : "untrusted"}
                  </span>
                </td>
                <td>
                  <span class="data-table-badge ${integrityBadge(entry.integrity)}">
                    ${entry.integrity}
                  </span>
                </td>
                <td><span class="mono">${entry.version ?? "\u2014"}</span></td>
                <td>
                  <div class="security-permissions">
                    ${entry.permissions.map(
                      (p) => html`<span class="security-permission-chip">${p}</span>`,
                    )}
                  </div>
                </td>
                <td>${entry.trustReason}</td>
                <td><span class="mono" style="font-size: 12px;">${entry.source}</span></td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function renderHooks(hooks: HookEntry[]) {
  return html`
    <div class="data-table-container">
      <table class="data-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Command</th>
            <th>Enabled</th>
            <th>Last Triggered</th>
            <th>Last Result</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          ${hooks.map(
            (hook) => html`
              <tr>
                <td><span class="mono">${hook.event}</span></td>
                <td><span class="mono" style="font-size: 12px;">${hook.command}</span></td>
                <td>
                  <span class="data-table-badge ${hook.enabled ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                    ${hook.enabled ? "on" : "off"}
                  </span>
                </td>
                <td>${hook.lastTriggeredAt ? formatRelativeTimestamp(hook.lastTriggeredAt) : "\u2014"}</td>
                <td>
                  ${
                    hook.lastResult
                      ? html`
                          <span class="data-table-badge ${hook.lastResult === "success" ? "data-table-badge--direct" : "data-table-badge--unknown"}">
                            ${hook.lastResult}
                          </span>
                        `
                      : html`<span class="muted">\u2014</span>`
                  }
                </td>
                <td>${hook.source}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export function renderConsoleSecurity(props: ConsoleSecurityProps) {
  const snapshot = props.snapshot;
  const tabs = [
    { key: "tools" as const, label: "Tool Policies", count: snapshot?.toolPolicies.length ?? 0 },
    { key: "skills" as const, label: "Skill Gating", count: snapshot?.skillGating.length ?? 0 },
    { key: "plugins" as const, label: "Plugin Trust", count: snapshot?.pluginTrust.length ?? 0 },
    { key: "hooks" as const, label: "Hooks", count: snapshot?.hooks.length ?? 0 },
  ];

  return html`
    <div class="console-security">
      <section class="card">
        <div class="row" style="justify-content: space-between; margin-bottom: 16px;">
          <div>
            <div class="card-title">Security Policy</div>
            <div class="card-sub">
              ${
                snapshot
                  ? html`Exec approval: <strong>${snapshot.execApprovalMode}</strong>
                      \u00B7 Captured ${formatRelativeTimestamp(snapshot.capturedAt)}`
                  : "View tool policies, skill gating, plugin trust, and hooks."
              }
            </div>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading\u2026" : "Refresh"}
          </button>
        </div>

        ${
          props.error
            ? html`<div class="callout danger" style="margin-bottom: 12px;">${props.error}</div>`
            : nothing
        }

        ${
          snapshot
            ? html`
                <!-- Tab bar -->
                <div class="security-tabs">
                  ${tabs.map(
                    (tab) => html`
                      <button
                        class="security-tab ${props.activeTab === tab.key ? "security-tab--active" : ""}"
                        @click=${() => props.onTabChange(tab.key)}
                      >
                        ${tab.label}
                        <span class="security-tab-count">${tab.count}</span>
                      </button>
                    `,
                  )}
                </div>

                <!-- Tab content -->
                <div class="security-tab-content">
                  ${props.activeTab === "tools" ? renderToolPolicies(snapshot.toolPolicies) : nothing}
                  ${props.activeTab === "skills" ? renderSkillGating(snapshot.skillGating) : nothing}
                  ${props.activeTab === "plugins" ? renderPluginTrust(snapshot.pluginTrust) : nothing}
                  ${props.activeTab === "hooks" ? renderHooks(snapshot.hooks) : nothing}
                </div>
              `
            : nothing
        }
      </section>
    </div>
  `;
}
