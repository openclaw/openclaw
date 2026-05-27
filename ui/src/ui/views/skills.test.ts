import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { renderSkills, type SkillsProps } from "./skills.ts";

const dialogRestores: Array<() => void> = [];

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: "OPENAI_API_KEY",
    emoji: undefined,
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

function createProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill()],
  };

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
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    ...overrides,
  };
}

describe("renderSkills", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
  });

  it("opens the skill detail dialog as a modal", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    installDialogMethod("showModal", showModal);

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  });

  it("closes the skill detail dialog through the dialog close event", async () => {
    const container = document.createElement("div");
    const onDetailClose = vi.fn();

    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    installDialogMethod("close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onDetailClose,
        }),
      ),
      container,
    );
    await Promise.resolve();

    container.querySelector<HTMLButtonElement>(".md-preview-dialog__header .btn")?.click();

    expect(onDetailClose).toHaveBeenCalledTimes(1);
  });
});

function installDialogMethod(
  name: "showModal" | "close",
  value: (this: HTMLDialogElement) => void,
) {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, {
    configurable: true,
    writable: true,
    value,
  });
  dialogRestores.push(() => {
    if (original) {
      Object.defineProperty(proto, name, original);
      return;
    }
    delete proto[name];
  });
}
