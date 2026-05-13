import { t } from "../../i18n/index.ts";
import type { SkillStatusEntry } from "../types.ts";

export type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

function getSkillGroupLabel(id: string): string {
  switch (id) {
    case "workspace":
      return t("skills.group.workspace");
    case "built-in":
      return t("skills.group.builtIn");
    case "installed":
      return t("skills.group.installed");
    case "extra":
      return t("skills.group.extra");
    default:
      return t("skills.group.other");
  }
}

const SKILL_SOURCE_GROUPS: Array<{ id: string; sources: string[] }> = [
  { id: "workspace", sources: ["openclaw-workspace"] },
  { id: "built-in", sources: ["openclaw-bundled"] },
  { id: "installed", sources: ["openclaw-managed"] },
  { id: "extra", sources: ["openclaw-extra"] },
];

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: getSkillGroupLabel(def.id), skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: getSkillGroupLabel("other"), skills: [] };
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
