import type { SkillStatusEntry } from "../types.ts";
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

export type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; label: string; sources: string[] }> = [
  {
    id: "workspace",
    label: uiText("Workspace Skills", "Kỹ năng workspace"),
    sources: ["openclaw-workspace"],
  },
  {
    id: "built-in",
    label: uiText("Built-in Skills", "Kỹ năng tích hợp"),
    sources: ["openclaw-bundled"],
  },
  {
    id: "installed",
    label: uiText("Installed Skills", "Kỹ năng đã cài"),
    sources: ["openclaw-managed"],
  },
  {
    id: "extra",
    label: uiText("Extra Skills", "Kỹ năng bổ sung"),
    sources: ["openclaw-extra"],
  },
];

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = {
    id: "other",
    label: uiText("Other Skills", "Kỹ năng khác"),
    skills: [],
  };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}
