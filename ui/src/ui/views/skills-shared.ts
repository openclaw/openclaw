import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SkillStatusEntry } from "../types.ts";

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
    reasons.push(t("skillsPage.status.disabled"));
  }
  if (skill.blockedByAllowlist) {
    reasons.push(t("skillsPage.status.blockedByAllowlist"));
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
        ? html` <span class="chip">${t("skillsPage.status.bundled")}</span> `
        : nothing}
      <span class="chip ${skill.eligible ? "chip-ok" : "chip-warn"}">
        ${skill.eligible ? t("skillsPage.status.eligible") : t("skillsPage.status.blocked")}
      </span>
      ${skill.disabled
        ? html` <span class="chip chip-warn">${t("skillsPage.status.disabled")}</span> `
        : nothing}
    </div>
  `;
}
