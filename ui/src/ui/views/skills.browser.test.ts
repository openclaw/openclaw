import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderSkills } from "./skills.ts";

function createProps(overrides: Partial<Parameters<typeof renderSkills>[0]> = {}) {
  return {
    loading: false,
    report: {
      workspaceDir: "/tmp/work",
      managedSkillsDir: "/tmp/work/managed",
      skills: [
        {
          name: "peekaboo",
          description: "Capture screenshots",
          source: "openclaw-workspace",
          filePath: "/tmp/work/skills/peekaboo/SKILL.md",
          baseDir: "/tmp/work/skills/peekaboo",
          skillKey: "peekaboo",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        },
      ],
    },
    error: null,
    filter: "",
    edits: {},
    busyKey: null,
    messages: {},
    verdicts: {},
    verdictErrors: {},
    verdictExpanded: {},
    verdictLoadingKey: null,
    onFilterChange: vi.fn(),
    onRefresh: vi.fn(),
    onToggle: vi.fn(),
    onEdit: vi.fn(),
    onSaveKey: vi.fn(),
    onInstall: vi.fn(),
    onToggleVerdict: vi.fn(),
    onRefreshVerdict: vi.fn(),
    ...overrides,
  };
}

describe("skills view verdict panel (browser)", () => {
  it("renders explain verdict button and triggers toggle callback", async () => {
    const container = document.createElement("div");
    const onToggleVerdict = vi.fn();
    render(
      renderSkills(
        createProps({
          onToggleVerdict,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const button = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Explain verdict",
    );
    expect(button).toBeTruthy();
    button?.click();
    expect(onToggleVerdict).toHaveBeenCalledWith("peekaboo");
  });

  it("renders expanded verdict details and refresh action", async () => {
    const container = document.createElement("div");
    const onRefreshVerdict = vi.fn();
    render(
      renderSkills(
        createProps({
          verdictExpanded: { peekaboo: true },
          verdicts: {
            peekaboo: {
              skillKey: "peekaboo",
              skillName: "peekaboo",
              verdict: "review",
              confidence: 0.82,
              generatedAtMs: Date.now(),
              summary: {
                scannedFiles: 3,
                critical: 0,
                warn: 1,
                info: 0,
                ruleIds: ["suspicious-network"],
              },
              antiAbuse: {
                maxFiles: 500,
                maxFileBytes: 1024 * 1024,
                cappedAtMaxFiles: false,
              },
              remediationHints: ["Restrict outbound endpoints."],
              findings: [
                {
                  ruleId: "suspicious-network",
                  severity: "warn",
                  confidence: 0.74,
                  remediationHint: "Restrict outbound endpoints.",
                  message: "WebSocket connection to non-standard port",
                  file: "runner.ts",
                  line: 12,
                },
              ],
            },
          },
          onRefreshVerdict,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const text = container.textContent ?? "";
    expect(text).toContain("ClawHub security verdict");
    expect(text).toContain("82%");
    expect(text).toContain("suspicious-network");
    expect(text).toContain("Remediation hints");

    const refreshButton = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Refresh verdict",
    );
    expect(refreshButton).toBeTruthy();
    refreshButton?.click();
    expect(onRefreshVerdict).toHaveBeenCalledWith("peekaboo");
  });

  it("shows loading and error states for verdict panel", async () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        createProps({
          verdictExpanded: { peekaboo: true },
          verdictLoadingKey: "peekaboo",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent ?? "").toContain("Scanning skill source...");

    render(
      renderSkills(
        createProps({
          verdictExpanded: { peekaboo: true },
          verdictErrors: { peekaboo: "scan failed" },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent ?? "").toContain("scan failed");
  });
});
