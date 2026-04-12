import { html, nothing } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import type {
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../controllers/exec-approval.ts";

type ApprovalTone = "danger" | "warn" | "info";

function formatRemaining(ms: number): string {
  const remaining = Math.max(0, ms);
  const totalSeconds = Math.floor(remaining / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function renderMetaRow(label: string, value?: string | null) {
  if (!value) {
    return nothing;
  }
  return html`<div class="exec-approval-meta-row"><span>${label}</span><span>${value}</span></div>`;
}

function normalizePath(value?: string | null): string {
  return (value ?? "").replace(/\\/g, "/").trim().toLowerCase();
}

function isPathOutsideCwd(request: ExecApprovalRequestPayload): boolean {
  const cwd = normalizePath(request.cwd);
  const resolved = normalizePath(request.resolvedPath);
  if (!cwd || !resolved) {
    return false;
  }
  return !(resolved === cwd || resolved.startsWith(`${cwd}/`));
}

function resolveApprovalRisk(active: ExecApprovalRequest): {
  label: string;
  tone: ApprovalTone;
  detail: string;
  reasons: string[];
} {
  if (active.kind === "plugin") {
    const severity = (active.pluginSeverity ?? "").trim().toLowerCase();
    if (["critical", "high", "danger"].includes(severity)) {
      return {
        label: "High risk",
        tone: "danger",
        detail: "This plugin asks for elevated behavior. Verify the plugin and scope before allowing it.",
        reasons: [
          `Plugin severity is marked ${severity}.`,
          "The request asks for capabilities outside normal chat behavior.",
        ],
      };
    }
    if (["medium", "moderate", "warn", "warning"].includes(severity)) {
      return {
        label: "Medium risk",
        tone: "warn",
        detail: "Review the plugin details and agent/session context before allowing it.",
        reasons: [
          `Plugin severity is marked ${severity}.`,
          "The request should match the plugin you intended to install or run.",
        ],
      };
    }
    return {
      label: "Review required",
      tone: "info",
      detail: "Confirm this plugin request matches what you expected the agent to do.",
      reasons: ["Plugin requests can add or unlock new behavior in the UI."],
    };
  }

  const command = active.request.command.trim().toLowerCase();
  const destructivePattern =
    /\b(rm\s+-rf|remove-item\b.*-recurse|del\s+\/|format\b|mkfs\b|shutdown\b|reboot\b|git reset --hard|curl\b.+\|\s*(?:sh|bash|pwsh|powershell))\b/i;
  const mutatingPattern =
    /\b(npm\b|pnpm\b|yarn\b|pip\b|cargo\b|apt\b|brew\b|git push\b|git commit\b|move-item\b|copy-item\b|new-item\b|chmod\b|chown\b)\b/i;
  const reasons: string[] = [];
  const commandPreview = active.request.command.trim();
  if (destructivePattern.test(command)) {
    reasons.push(`Matched a destructive command pattern in \`${commandPreview}\`.`);
  }
  if (mutatingPattern.test(command)) {
    reasons.push("Includes a command that can install, write, move, or change files.");
  }
  if (isPathOutsideCwd(active.request)) {
    reasons.push("The resolved target path is outside the current working directory.");
  }
  if (destructivePattern.test(command)) {
    return {
      label: "High risk",
      tone: "danger",
      detail: "This command includes destructive or highly privileged operations. Check the exact command and target path carefully.",
      reasons,
    };
  }
  if (mutatingPattern.test(command) || isPathOutsideCwd(active.request)) {
    return {
      label: "Medium risk",
      tone: "warn",
      detail: "This command can change files or reach outside the immediate working directory. Review the path and command intent before allowing it.",
      reasons,
    };
  }
  return {
    label: "Review required",
    tone: "info",
    detail: "This command still needs approval. Confirm the host, path, and exact command before allowing it.",
    reasons: ["Manual approval is required before this command can run."],
  };
}

function renderRiskBadge(risk: { label: string; tone: ApprovalTone }) {
  return html`<span class="exec-approval-badge exec-approval-badge--${risk.tone}">${risk.label}</span>`;
}

function renderSectionLabel(label: string) {
  return html`<div class="exec-approval-section-label">${label}</div>`;
}

function renderRiskReasons(risk: { reasons: string[] }) {
  if (!risk.reasons.length) {
    return nothing;
  }
  return html`
    <div class="exec-approval-reasons">
      <div class="exec-approval-reasons__label">Why this was flagged</div>
      <ul class="exec-approval-reasons__list">
        ${risk.reasons.map((reason) => html`<li>${reason}</li>`)}
      </ul>
    </div>
  `;
}

function renderExecBody(request: ExecApprovalRequestPayload) {
  return html`
    ${renderSectionLabel("Command")}
    <div class="exec-approval-command mono">${request.command}</div>
    <div class="exec-approval-meta">
      ${renderMetaRow("Host", request.host)} ${renderMetaRow("Agent", request.agentId)}
      ${renderMetaRow("Session", request.sessionKey)} ${renderMetaRow("CWD", request.cwd)}
      ${renderMetaRow("Resolved", request.resolvedPath)}
      ${renderMetaRow("Security", request.security)} ${renderMetaRow("Ask", request.ask)}
    </div>
  `;
}

function renderPluginBody(active: ExecApprovalRequest) {
  return html`
    ${renderSectionLabel("Plugin request")}
    ${active.pluginDescription
      ? html`<pre class="exec-approval-command mono" style="white-space:pre-wrap">
${active.pluginDescription}</pre
        >`
      : nothing}
    <div class="exec-approval-meta">
      ${renderMetaRow("Severity", active.pluginSeverity)}
      ${renderMetaRow("Plugin", active.pluginId)} ${renderMetaRow("Agent", active.request.agentId)}
      ${renderMetaRow("Session", active.request.sessionKey)}
    </div>
  `;
}

export function renderExecApprovalPrompt(state: AppViewState) {
  const active = state.execApprovalQueue[0];
  if (!active) {
    return nothing;
  }
  const request = active.request;
  const risk = resolveApprovalRisk(active);
  const remainingMs = active.expiresAtMs - Date.now();
  const remaining = remainingMs > 0 ? `expires in ${formatRemaining(remainingMs)}` : "expired";
  const queueCount = state.execApprovalQueue.length;
  const isPlugin = active.kind === "plugin";
  const title = isPlugin
    ? (active.pluginTitle ?? "Plugin approval needed")
    : "Exec approval needed";
  return html`
    <div class="exec-approval-overlay" role="dialog" aria-live="polite">
      <div class="exec-approval-card">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${remaining}</div>
          </div>
          <div class="exec-approval-header-badges">
            ${renderRiskBadge(risk)}
            ${queueCount > 1
              ? html`<div class="exec-approval-queue">${queueCount} pending</div>`
              : nothing}
          </div>
        </div>
        <div class="exec-approval-notice exec-approval-notice--${risk.tone}">${risk.detail}</div>
        ${renderRiskReasons(risk)}
        ${isPlugin ? renderPluginBody(active) : renderExecBody(request)}
        ${state.execApprovalError
          ? html`<div class="exec-approval-error">${state.execApprovalError}</div>`
          : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-once")}
          >
            Allow once
          </button>
          <button
            class="btn"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("allow-always")}
          >
            Always allow
          </button>
          <button
            class="btn danger"
            ?disabled=${state.execApprovalBusy}
            @click=${() => state.handleExecApprovalDecision("deny")}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  `;
}
