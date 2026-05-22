import { html, nothing } from "lit";
import type { SkillStatusEntry } from "../types.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

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
    reasons.push(uiText("disabled", "đã tắt"));
  }
  if (skill.blockedByAllowlist) {
    reasons.push(uiText("blocked by allowlist", "bị chặn bởi allowlist"));
  }
  return reasons;
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
      ${showBundledBadge
        ? html` <span class="chip">${uiText("bundled", "tích hợp")}</span> `
        : nothing}
      <span class="chip ${skill.eligible ? "chip-ok" : "chip-warn"}">
        ${skill.eligible ? uiText("eligible", "hợp lệ") : uiText("blocked", "bị chặn")}
      </span>
      ${skill.disabled
        ? html` <span class="chip chip-warn">${uiText("disabled", "đã tắt")}</span> `
        : nothing}
    </div>
  `;
}
