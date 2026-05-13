import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SkillStatusEntry } from "../types.ts";

export function computeSkillMissing(skill: SkillStatusEntry): string[] {
  return [
    ...skill.missing.bins.map((b) => `${t("skills.missing.bin")}:${b}`),
    ...skill.missing.env.map((e) => `${t("skills.missing.env")}:${e}`),
    ...skill.missing.config.map((c) => `${t("skills.missing.config")}:${c}`),
    ...skill.missing.os.map((o) => `${t("skills.missing.os")}:${o}`),
  ];
}

export function computeSkillReasons(skill: SkillStatusEntry): string[] {
  const reasons: string[] = [];
  if (skill.disabled) {
    reasons.push(t("skills.reasonDisabled"));
  }
  if (skill.blockedByAllowlist) {
    reasons.push(t("skills.reasonBlockedByAllowlist"));
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
      ${showBundledBadge ? html` <span class="chip">${t("skills.bundled")}</span> ` : nothing}
      <span class="chip ${skill.eligible ? "chip-ok" : "chip-warn"}">
        ${skill.eligible ? t("skills.eligible") : t("skills.blocked")}
      </span>
      ${skill.disabled
        ? html` <span class="chip chip-warn">${t("skills.disabled")}</span> `
        : nothing}
    </div>
  `;
}
