import { t } from "../../i18n/index.ts";
import type { SkillStatusEntry } from "../types.ts";

export type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

function getSkillSourceGroups(): Array<{ id: string; label: string; sources: string[] }> {
  return [
    {
      id: "workspace",
      label: t("skillsPage.groups.workspace"),
      sources: ["openclaw-workspace"],
    },
    {
      id: "built-in",
      label: t("skillsPage.groups.builtIn"),
      sources: ["openclaw-bundled"],
    },
    {
      id: "installed",
      label: t("skillsPage.groups.installed"),
      sources: ["openclaw-managed"],
    },
    {
      id: "extra",
      label: t("skillsPage.groups.extra"),
      sources: ["openclaw-extra"],
    },
  ];
}

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const skillSourceGroups = getSkillSourceGroups();
  const groups = new Map<string, SkillGroup>();
  for (const def of skillSourceGroups) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = skillSourceGroups.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: t("skillsPage.groups.other"), skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : skillSourceGroups.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = skillSourceGroups
    .map((group) => groups.get(group.id))
    .filter((group): group is SkillGroup => Boolean(group && group.skills.length > 0));
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}
