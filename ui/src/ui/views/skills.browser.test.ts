import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderSkills } from "./skills.ts";

describe("skills view (browser)", () => {
  it("renders the skill filter as a search input with autofill-resistant attributes", async () => {
    const container = document.createElement("div");
    render(
      renderSkills({
        connected: true,
        loading: false,
        report: {
          workspaceDir: "/tmp/openclaw-workspace",
          managedSkillsDir: "/tmp/openclaw-workspace/skills",
          skills: [],
        },
        error: null,
        filter: "",
        statusFilter: "all",
        edits: {},
        busyKey: null,
        messages: {},
        detailKey: null,
        onFilterChange: () => undefined,
        onStatusFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onEdit: () => undefined,
        onSaveKey: () => undefined,
        onInstall: () => undefined,
        onDetailOpen: () => undefined,
        onDetailClose: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const input = container.querySelector<HTMLInputElement>('input[name="skills-filter"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute("type")).toBe("search");
    expect(input?.getAttribute("autocomplete")).toBe("off");
    expect(input?.getAttribute("autocapitalize")).toBe("off");
    expect(input?.getAttribute("autocorrect")).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");
  });
});
