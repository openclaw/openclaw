import type { TemplateResult } from "lit";
import { describe, expect, it } from "vitest";
import { renderSkills } from "./skills.ts";

function collectTemplateMarkup(value: unknown): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectTemplateMarkup(entry)).join("");
  }
  if (typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as TemplateResult;
    return `${template.strings.join("")}${template.values
      .map((entry) => collectTemplateMarkup(entry))
      .join("")}`;
  }
  return "";
}

describe("skills view", () => {
  it("marks filter and api-key inputs to avoid login autofill", () => {
    const template = renderSkills({
      loading: false,
      report: {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/managed",
        skills: [
          {
            skillKey: "demo",
            name: "Demo Skill",
            description: "Has an API key",
            source: "openclaw-workspace",
            filePath: "/tmp/workspace/demo/SKILL.md",
            baseDir: "/tmp/workspace/demo",
            emoji: undefined,
            disabled: false,
            bundled: false,
            always: false,
            blockedByAllowlist: false,
            eligible: true,
            requirements: { bins: [], env: [], config: [], os: [] },
            missing: { bins: [], env: [], config: [], os: [] },
            configChecks: [],
            install: [],
            primaryEnv: "DEMO_API_KEY",
          },
        ],
      },
      error: null,
      filter: "",
      edits: {},
      busyKey: null,
      messages: {},
      onFilterChange: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      onEdit: () => undefined,
      onSaveKey: () => undefined,
      onInstall: () => undefined,
    });

    const markup = collectTemplateMarkup(template);

    expect(markup).toContain('type="search"');
    expect(markup).toContain('name="skill-filter"');
    expect(markup).toContain('autocomplete="off"');
    expect(markup).toContain('spellcheck="false"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autocomplete="new-password"');
  });
});
