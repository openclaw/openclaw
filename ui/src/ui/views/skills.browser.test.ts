import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { renderSkills } from "./skills.ts";

function makeSkill(overrides: Partial<SkillStatusEntry>): SkillStatusEntry {
  return {
    name: "sample-skill",
    description: "Sample description",
    source: "openclaw-workspace",
    filePath: "/tmp/sample/SKILL.md",
    baseDir: "/tmp/sample",
    skillKey: "sample-skill",
    bundled: false,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { bins: [], env: [], config: [], os: [] },
    missing: { bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function makeReport(skills: SkillStatusEntry[]): SkillStatusReport {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/managed",
    skills,
  };
}

function makeProps(report: SkillStatusReport) {
  return {
    connected: true,
    loading: false,
    report,
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    busyKey: null,
    messages: {},
    detailKey: null,
    clawhubQuery: "",
    clawhubResults: null,
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallSlug: null,
    clawhubInstallMessage: null,
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
  };
}

describe("skills view (browser)", () => {
  it("keeps workspace-installed skills in the workspace group even when bundled badge is set", async () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        makeProps(
          makeReport([
            makeSkill({
              name: "workspace-helper",
              skillKey: "workspace-helper",
              source: "openclaw-workspace",
              bundled: true,
            }),
            makeSkill({
              name: "bundled-helper",
              skillKey: "bundled-helper",
              source: "openclaw-bundled",
              bundled: true,
            }),
          ]),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const groups = [...container.querySelectorAll("details.agent-skills-group")].map((element) =>
      (element.textContent ?? "").replace(/\s+/g, " ").trim(),
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toContain("Workspace Skills");
    expect(groups[0]).toContain("workspace-helper");
    expect(groups[0]).not.toContain("bundled-helper");
    expect(groups[1]).toContain("Built-in Skills");
    expect(groups[1]).toContain("bundled-helper");
  });
});
