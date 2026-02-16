import { html, nothing } from "lit";
import type { SkillCapability, SkillStatusEntry } from "../types.ts";

const CAPABILITY_LABELS: Record<SkillCapability, { icon: string; label: string }> = {
  shell: { icon: ">_", label: "Shell" },
  filesystem: { icon: "fs", label: "Filesystem" },
  network: { icon: "net", label: "Network" },
  browser: { icon: "www", label: "Browser" },
  sessions: { icon: "ses", label: "Sessions" },
};

export function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `bin:${b}`),
    ...skill.missing.env.map((e) => `env:${e}`),
    ...skill.missing.config.map((c) => `config:${c}`),
    ...skill.missing.os.map((o) => `os:${o}`),
  ];
}

export function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons: string[] = [];
  if (skill.disabled) {
    reasons.push("disabled");
  }
  if (skill.blockedByAllowlist) {
    reasons.push("blocked by allowlist");
  }
  return reasons;
}

export function renderCapabilityChips(capabilities: SkillCapability[]) {
  if (!capabilities || capabilities.length === 0) {
    return nothing;
  }
  return html`
    <div class="chip-row" style="margin-top: 6px;">
      ${capabilities.map((cap) => {
        const info = CAPABILITY_LABELS[cap];
        const isHighRisk = cap === "shell" || cap === "sessions";
        return html`
          <span class="chip ${isHighRisk ? "chip-warn" : ""}" title="${info?.label ?? cap}">
            ${info?.icon ?? cap} ${info?.label ?? cap}
          </span>
        `;
      })}
    </div>
  `;
}

export function renderScanBadge(scanResult?: { severity: string; findings: string[] }) {
  if (!scanResult) {
    return nothing;
  }
  switch (scanResult.severity) {
    case "critical":
      return html`<span class="chip chip-danger" title="${scanResult.findings.join("; ")}">✗ blocked</span>`;
    case "warn":
      return html`<span class="chip chip-warn" title="${scanResult.findings.join("; ")}">⚠ warning</span>`;
    case "info":
      return html`<span class="chip" title="${scanResult.findings.join("; ")}">ℹ notice</span>`;
    default:
      return nothing;
  }
}

export function renderSkillStatusChips(params: {
  skill: SkillStatusEntry;
  showBundledBadge?: boolean;
}) {
  const skill = params.skill;
  const showBundledBadge = Boolean(params.showBundledBadge);
  return html`
    <div class="chip-row" style="margin-top: 6px;">
      <span class="chip">${skill.source}</span>
      ${
        showBundledBadge
          ? html`
              <span class="chip">bundled</span>
            `
          : nothing
      }
      <span class="chip ${skill.eligible ? "chip-ok" : "chip-warn"}">
        ${skill.eligible ? "eligible" : "blocked"}
      </span>
      ${
        skill.disabled
          ? html`
              <span class="chip chip-warn">disabled</span>
            `
          : nothing
      }
      ${renderScanBadge(skill.scanResult)}
    </div>
  `;
}
