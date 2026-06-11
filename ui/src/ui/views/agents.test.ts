import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type {
  SelfImprovementActionQueueSummary,
  SelfImprovementProposal,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationGroup,
} from "../types.ts";
import { renderAgentFiles } from "./agents-panels-status-files.ts";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
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
  };
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    connected: true,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
    toolsEffective: {
      loading: false,
      error: null,
      result: null,
    },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    workflowMaps: {
      selectedRoomId: null,
      selectedStepId: null,
      orders: {},
    },
    sessions: {
      loading: false,
      error: null,
      result: {
        ts: Date.now(),
        path: "/tmp/sessions",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      },
    },
    runtimeStatus: {
      loading: false,
      error: null,
      result: null,
    },
    opsSummary: {
      loading: false,
      error: null,
      result: {
        ts: Date.parse("2026-05-07T12:00:00.000Z"),
        state: "healthy",
        issues: [],
        checks: {
          cronEnabled: true,
          cronJobs: 11,
          failedCronJobs: 0,
          nextCronRunAtMs: null,
          channelAccounts: 1,
          loadedModelCount: 1,
          loadedModelBytes: 29_000_000_000,
          ollamaProcessRssBytes: 29_000_000_000,
          openclawProcessRssBytes: 500_000_000,
          macosAvailabilityEstimateBytes: 150_000_000_000,
        },
        next: {
          automation: "No scheduled automation found",
          nextCronRunAtMs: null,
        },
        sources: {
          runtimeTelemetry: "live",
          cron: "live",
          channels: "live",
        },
      },
    },
    selfImprovement: {
      loading: false,
      error: null,
      recommendations: [],
      groups: [],
      scorecard: null,
      scorecards: [],
      health: null,
      proposals: [],
      auditEvents: [],
      total: 0,
      scanLoading: false,
      lastScan: null,
      analysisLoading: false,
      lastAnalysis: null,
      modelPreflightLoading: false,
      lastModelPreflight: null,
      productionCheckLoading: false,
      lastProductionCheck: null,
      maintenanceLoading: false,
      lastMaintenance: null,
    },
    kalshiDashboard: null,
    modelCatalog: [],
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onCronRunNow: () => undefined,
    onSelfImprovementRefresh: () => undefined,
    onSelfImprovementScan: () => undefined,
    onSelfImprovementAnalysis: () => undefined,
    onSelfImprovementModelPreflight: () => undefined,
    onSelfImprovementProductionCheck: () => undefined,
    onSelfImprovementMaintenanceDryRun: () => undefined,
    onSelfImprovementRecommendationUpdate: () => undefined,
    onSelfImprovementGroupUpdate: () => undefined,
    onSelfImprovementCuratorUpdate: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    onAssignAgentRoom: () => undefined,
    onWorkflowRoomSelect: () => undefined,
    onWorkflowStepSelect: () => undefined,
    onWorkflowOrderChange: () => undefined,
    onWorkflowResetRoom: () => undefined,
    ...overrides,
  };
}

function createRamRuntimeStatus(): AgentsProps["runtimeStatus"] {
  return {
    loading: false,
    error: null,
    result: {
      ts: Date.now(),
      system: {
        totalBytes: 256 * 1024 ** 3,
        freeBytes: 64 * 1024 ** 3,
        usedBytes: 192 * 1024 ** 3,
        usedRatio: 0.75,
        macosMemory: {
          available: true,
          pageSizeBytes: 16 * 1024,
          freeBytes: 64 * 1024 ** 3,
          speculativeBytes: 16 * 1024 ** 3,
          purgeableBytes: 1 * 1024 ** 3,
          fileBackedBytes: 96 * 1024 ** 3,
          anonymousBytes: 28 * 1024 ** 3,
          wiredBytes: 10 * 1024 ** 3,
          compressedBytes: 256 * 1024 ** 2,
          reclaimableBytes: 113 * 1024 ** 3,
          availabilityEstimateBytes: 177 * 1024 ** 3,
        },
        processes: {
          available: true,
          totalRssBytes: 19 * 1024 ** 3,
          openclawRssBytes: 1 * 1024 ** 3,
          ollamaRssBytes: 15 * 1024 ** 3,
          otherRssBytes: 3 * 1024 ** 3,
          top: [],
        },
      },
      localModels: {
        provider: "ollama",
        available: true,
        totalLoadedBytes: 15 * 1024 ** 3,
        totalLoadedVramBytes: 0,
        count: 1,
        models: [
          {
            provider: "ollama",
            name: "openclaw-control-qwen25-32b:latest",
            model: "openclaw-control-qwen25-32b:latest",
            sizeBytes: 15 * 1024 ** 3,
          },
        ],
        installedAvailable: true,
        installedModels: [],
      },
      warnings: [],
    },
  };
}

function readAgentSignalText(container: Element): string {
  return [...container.querySelectorAll(".agent-signal")]
    .map((entry) => entry.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .join(" | ");
}

async function waitForLazyAgentPanel() {
  await vi.dynamicImportSettled();
  await Promise.resolve();
}

describe("renderAgents", () => {
  it("renders a plain-English attention command center and healthy issue queue above the room", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-07T12:00:00.000Z"),
              state: "healthy",
              issues: [],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 0,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    expect(container.textContent).toContain("What Needs My Attention?");
    expect(container.textContent).toContain("All clear");
    expect(container.textContent).toContain(
      "OpenClaw is running normally. No action is needed right now.",
    );
    expect(container.textContent).toContain("No action needed");
    const signals = readAgentSignalText(container);
    expect(container.textContent).toContain("Dashboard Data Sources");
    expect(signals).toContain("Gateway Connected");
    expect(signals).toContain("Ops Summary Verified");
    expect(signals).toContain("Model RAM 1 loaded");
    expect(container.textContent).toContain("Issue Queue");
    expect(container.textContent).toContain("No actionable issues detected");
    expect(container.textContent).toContain("You likely have 177 GB available for models");
  });

  it("keeps recent action and model RAM lookups correct with indexed room data", async () => {
    const container = document.createElement("div");
    const now = Date.parse("2026-05-07T12:00:00.000Z");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "beta",
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha" } as never,
              {
                id: "beta",
                name: "Beta",
                model: { primary: "ollama/beta-model:latest" },
              } as never,
              { id: "gamma", name: "Gamma" } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: now,
              path: "/tmp/sessions",
              count: 3,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "agent:alpha:main",
                  kind: "agent",
                  status: "done",
                  startedAt: now - 30_000,
                  updatedAt: now - 20_000,
                  displayName: "Alpha-only work",
                } as never,
                {
                  key: "agent:gamma:main",
                  spawnedBy: "agent:beta:main",
                  kind: "agent",
                  status: "done",
                  startedAt: now - 10_000,
                  updatedAt: now,
                  displayName: "Beta delegated analysis",
                  modelProvider: "ollama",
                  model: "beta-model:latest",
                } as never,
                {
                  key: "agent:beta:older",
                  kind: "agent",
                  status: "done",
                  startedAt: now - 50_000,
                  updatedAt: now - 40_000,
                  displayName: "Older beta work",
                } as never,
              ],
            },
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: now,
              system: {
                totalBytes: 128 * 1024 ** 3,
                freeBytes: 64 * 1024 ** 3,
                usedBytes: 64 * 1024 ** 3,
                usedRatio: 0.5,
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 6 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "beta-model:latest",
                    model: "beta-model:latest",
                    sizeBytes: 6 * 1024 ** 3,
                    contextLength: 8192,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const selectedDetail = container.querySelector<HTMLElement>(".agent-room-detail");
    const selectedText = selectedDetail?.textContent?.replace(/\s+/g, " ") ?? "";

    expect(selectedText).toContain("Beta delegated analysis");
    expect(selectedText).toContain("Older beta work");
    expect(selectedText).not.toContain("Alpha-only work");
    expect(selectedText).toContain("6.0 GB - 8,192 ctx");
    expect(selectedText).toContain("6.0 GB live now");
  });

  it("labels source-level dashboard data problems before the room state is trusted", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          connected: false,
          sessions: {
            loading: false,
            error: "sessions unavailable",
            result: null,
          },
          runtimeStatus: {
            loading: false,
            error: "runtime unavailable",
            result: null,
          },
          kalshiDashboard: null,
          kalshiDashboardLoading: false,
          kalshiDashboardError: "kalshi unavailable",
        }),
      ),
      container,
    );
    await Promise.resolve();

    const signals = readAgentSignalText(container);
    expect(container.textContent).toContain("Dashboard Data Sources");
    expect(signals).toContain("Gateway Offline");
    expect(signals).toContain("Agents Problem");
    expect(signals).toContain("sessions unavailable");
    expect(signals).toContain("Model RAM Problem");
    expect(signals).toContain("runtime unavailable");
    expect(signals).toContain("Prediction Markets Problem");
    expect(signals).toContain("kalshi unavailable");
  });

  it("does not show all clear before the Gateway operations summary is verified", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          opsSummary: {
            loading: true,
            error: null,
            result: null,
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Review recommended");
    expect(container.textContent).toContain("Checking live Gateway status");
    expect(container.textContent).toContain(
      "The dashboard should not show all clear until Gateway health is verified.",
    );
    expect(container.textContent).not.toContain("All clear");
  });

  it("shows a resolved learning telemetry fallback when Kalshi snapshot loading times out", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          kalshiDashboard: null,
          kalshiDashboardLoading: false,
          kalshiDashboardError: "kalshi.dashboard.snapshot timed out after 15000ms",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Kalshi snapshot unavailable");
    expect(container.textContent).toContain("Learning telemetry could not load in time");
    expect(container.textContent).not.toContain("Waiting for Kalshi snapshot");
    expect(container.textContent).not.toContain("No snapshot loaded yet");
  });

  it("includes gateway verified ops summary issues when available", async () => {
    const container = document.createElement("div");
    const failedCronJob = {
      id: "kalshi-status",
      name: "Kalshi status bridge",
      enabled: true,
      createdAtMs: Date.parse("2026-05-07T11:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-07T12:00:00.000Z"),
      schedule: { kind: "every", everyMs: 60_000 } as never,
      sessionTarget: { kind: "main" } as never,
      wakeMode: "always" as never,
      payload: { kind: "agentTurn", message: "Check Kalshi bridge" } as never,
      state: {
        lastRunAtMs: Date.parse("2026-05-07T11:59:00.000Z"),
        lastStatus: "error",
        lastRunStatus: "error",
        lastError: "cron: job interrupted by gateway restart",
        consecutiveErrors: 1,
      },
    } as never;

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [failedCronJob],
          },
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-07T12:00:00.000Z"),
              state: "needs_review",
              issues: [
                {
                  id: "cron-kalshi-status",
                  severity: "medium",
                  title: "Scheduled job failed",
                  affected: "Kalshi status bridge",
                  detectedAt: Date.parse("2026-05-07T11:59:00.000Z"),
                  likelyCause: "cron: job interrupted by gateway restart",
                  nextInspection: "cron.runs for kalshi-status",
                  source: "cron",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 1,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("What Needs My Attention?");
    expect(container.textContent).toContain("Review recommended");
    expect(container.textContent).toContain("Top Next Actions");
    expect(container.textContent).toContain("Gateway verified");
    expect(container.textContent).toContain("Kalshi status bridge");
    expect(container.textContent).toContain("cron.runs for kalshi-status");
  });

  it("does not keep stale gateway cron issues after live cron state recovers", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [
              {
                id: "kalshi-status",
                name: "Kalshi status bridge",
                enabled: true,
                createdAtMs: Date.parse("2026-05-07T11:00:00.000Z"),
                updatedAtMs: Date.parse("2026-05-07T12:00:00.000Z"),
                schedule: { kind: "every", everyMs: 60_000 } as never,
                sessionTarget: { kind: "main" } as never,
                wakeMode: "always" as never,
                payload: { kind: "agentTurn", message: "Check Kalshi bridge" } as never,
                state: {
                  lastRunAtMs: Date.parse("2026-05-07T12:00:00.000Z"),
                  lastStatus: "ok",
                  lastRunStatus: "ok",
                  consecutiveErrors: 0,
                },
              } as never,
            ],
          },
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-07T12:00:00.000Z"),
              state: "needs_review",
              issues: [
                {
                  id: "cron-kalshi-status",
                  severity: "medium",
                  title: "Scheduled job failed",
                  affected: "Kalshi status bridge",
                  detectedAt: Date.parse("2026-05-07T11:59:00.000Z"),
                  likelyCause: "cron: job interrupted by gateway restart",
                  nextInspection: "cron.runs for kalshi-status",
                  source: "cron",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 1,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("All clear");
    expect(container.textContent).not.toContain("Scheduled job failed");
    expect(container.textContent).not.toContain("cron: job interrupted by gateway restart");
  });

  it("does not promote gateway cron issues before current cron state is verified", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          cron: {
            status: null,
            loading: true,
            error: null,
            jobs: [],
          },
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-07T12:00:00.000Z"),
              state: "needs_review",
              issues: [
                {
                  id: "cron-kalshi-status",
                  severity: "medium",
                  title: "Scheduled job failed",
                  affected: "Kalshi status bridge",
                  detectedAt: Date.parse("2026-05-07T11:59:00.000Z"),
                  likelyCause: "cron: job interrupted by gateway restart",
                  nextInspection: "cron.runs for kalshi-status",
                  source: "cron",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 1,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("All clear");
    expect(container.textContent).not.toContain("Scheduled job failed");
    expect(container.textContent).not.toContain("cron: job interrupted by gateway restart");
  });

  it("renders dashboard customization protection status from the verified ops summary", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-17T18:35:00.000Z"),
              state: "needs_review",
              issues: [
                {
                  id: "customization-protection",
                  severity: "medium",
                  title: "Dashboard customization protection needs review",
                  affected: "OpenClaw Dashboard custom features",
                  detectedAt: Date.parse("2026-05-17T18:35:00.000Z"),
                  likelyCause: "1 protected file(s) changed since bundle generation",
                  nextInspection: "customizations/dashboard/manifest.json",
                  source: "customization",
                  plainSummary: "The dashboard customization bundle is not fully current.",
                  whyItMatters:
                    "A one-click update could fail to preserve custom dashboard features unless the local patch bundle and update guard are healthy.",
                  recommendedAction:
                    "Regenerate the dashboard customization bundle, verify the patch applies, then rerun the update dry-run.",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 0,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
                customizationProtection: {
                  status: "needs_review",
                  checkedAt: Date.parse("2026-05-17T18:35:00.000Z"),
                  generatedAtUtc: "2026-05-17T18:28:14.911Z",
                  manifestPath: "customizations/dashboard/manifest.json",
                  patchPath: "customizations/dashboard/openclaw-dashboard-customizations.patch",
                  fileCount: 37,
                  missingFileCount: 0,
                  contentDriftCount: 1,
                  patchApplies: false,
                  updateGuardActive: true,
                  preserveDirty: true,
                  sourceRootConfigured: true,
                  detail: "1 protected file(s) changed since bundle generation",
                },
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Customization Protection");
    expect(container.textContent).toContain("Needs Review");
    expect(container.textContent).toContain("Protected files");
    expect(container.textContent).toContain("37");
    expect(container.textContent).toContain("Patch blocked");
    expect(container.textContent).toContain(
      "The dashboard customization bundle is not fully current.",
    );
    expect(container.textContent).toContain("Review protection");
  });

  it("renders actionable Discord degraded copy from the verified ops summary", async () => {
    const container = document.createElement("div");
    const onAttentionAction = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          onAttentionAction,
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.parse("2026-05-08T19:24:00.000Z"),
              state: "needs_review",
              issues: [
                {
                  id: "channel-discord-default",
                  severity: "medium",
                  title: "Discord is having trouble connecting",
                  affected: "discord: default",
                  detectedAt: Date.parse("2026-05-08T19:23:00.000Z"),
                  likelyCause: "gateway close code 4000",
                  nextInspection: "channels.status",
                  source: "channel",
                  plainSummary:
                    "Discord is reachable in config, but the live Discord connection is degraded.",
                  whyItMatters:
                    "Messages from Discord may not reach OpenClaw, and OpenClaw may not be able to reply there until this reconnects.",
                  recommendedAction:
                    "Open Channels, check the Discord account, then retry after Discord API/Gateway connectivity settles.",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 0,
                nextCronRunAtMs: null,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 29_000_000_000,
                ollamaProcessRssBytes: 29_000_000_000,
                openclawProcessRssBytes: 500_000_000,
                macosAvailabilityEstimateBytes: 150_000_000_000,
              },
              next: {
                automation: "No scheduled automation found",
                nextCronRunAtMs: null,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Review recommended");
    expect(container.textContent).toContain(
      "Discord is reachable in config, but the live Discord connection is degraded.",
    );
    expect(container.textContent).toContain("Messages from Discord may not reach OpenClaw");
    expect(container.textContent).toContain("retry after Discord API/Gateway connectivity settles");
    expect(container.textContent).toContain("Retry channel");
    expect(container.textContent).toContain("Confirmation required");

    const retry = [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-attention-action button"),
    ].find((entry) => entry.textContent?.includes("Retry channel"));
    retry?.click();

    expect(onAttentionAction).toHaveBeenCalledWith({
      kind: "channelStart",
      channel: "discord",
      accountId: "default",
      label: "Retry channel",
    });
  });

  it("turns failed cron jobs into prioritized dashboard issues", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [
              {
                id: "kalshi-status-bridge",
                name: "Kalshi status bridge",
                enabled: true,
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                schedule: { kind: "every", everyMs: 60_000 } as never,
                sessionTarget: { kind: "main" } as never,
                wakeMode: "always" as never,
                payload: { kind: "agentTurn", message: "Check Kalshi bridge" } as never,
                state: {
                  lastRunAtMs: Date.now(),
                  lastStatus: "error",
                  lastError: "cron: job interrupted by gateway restart",
                  consecutiveErrors: 1,
                },
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Review recommended");
    expect(container.textContent).toContain('The scheduled job "Kalshi status bridge" failed.');
    expect(container.textContent).toContain("Confirm a one-time rerun");
    expect(container.textContent).toContain("Scheduled job failed");
    expect(container.textContent).toContain("Kalshi status bridge");
    expect(container.textContent).toContain("cron: job interrupted by gateway restart");
    expect(container.textContent).toContain("Safest next step");
    expect(container.textContent).toContain("Confidence");
  });

  it("does not warn for disabled cron jobs with stale failures", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [
              {
                id: "daily-real-estate",
                name: "Daily Real Estate Evaluations",
                enabled: false,
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                schedule: { kind: "cron", expr: "40 5 * * *" } as never,
                sessionTarget: { kind: "main" } as never,
                wakeMode: "always" as never,
                payload: { kind: "agentTurn", message: "Evaluate deals" } as never,
                state: {
                  lastRunAtMs: Date.now(),
                  lastStatus: "error",
                  lastRunStatus: "error",
                  lastError: "previous disabled run failed",
                  consecutiveErrors: 1,
                },
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("All clear");
    expect(container.textContent).not.toContain("Scheduled job failed");
    expect(container.textContent).not.toContain("previous disabled run failed");
  });

  it("confirmation-gates failed cron reruns from attention actions", async () => {
    const container = document.createElement("div");
    const onCronRunNow = vi.fn();
    const onSelectPanel = vi.fn();
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          onCronRunNow,
          onSelectPanel,
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [
              {
                id: "kalshi-risk",
                name: "Kalshi evidence gate audit",
                enabled: true,
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                schedule: { kind: "every", everyMs: 60_000 } as never,
                sessionTarget: { kind: "main" } as never,
                wakeMode: "always" as never,
                payload: { kind: "agentTurn", message: "Audit risk" } as never,
                state: {
                  lastRunAtMs: Date.now(),
                  lastStatus: "error",
                  lastError: "risk gate failed",
                  consecutiveErrors: 1,
                },
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-attention-action button"),
    ].find((entry) => entry.textContent?.includes("Rerun safely"));
    button?.click();

    expect(confirmSpy).toHaveBeenCalled();
    expect(onCronRunNow).toHaveBeenCalledWith("kalshi-risk");
    expect(onSelectPanel).toHaveBeenCalledWith("cron");

    confirmSpy.mockRestore();
  });

  it("selects the affected agent from an agent attention action", async () => {
    const container = document.createElement("div");
    const onSelectAgent = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "beta",
          onSelectAgent,
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha" } as never,
              { id: "beta", name: "Beta" } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "agent:beta:main",
                  kind: "direct",
                  updatedAt: Date.now(),
                  status: "failed",
                  displayName: "Blocked request",
                  lastMessagePreview: "Tool failed",
                } as never,
              ],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-attention-action button"),
    ].find((entry) => entry.textContent?.includes("Inspect worker"));
    button?.click();

    expect(onSelectAgent).toHaveBeenCalledWith("beta");
  });

  it("limits top next actions to three in deterministic priority order", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          connected: false,
          runtimeStatus: {
            ...createRamRuntimeStatus(),
            error: "runtime probe failed",
          },
          channels: {
            snapshot: null,
            loading: false,
            error: "Discord disconnected",
            lastSuccess: Date.now(),
          },
          cron: {
            status: { enabled: true, jobs: 1 },
            loading: false,
            error: null,
            jobs: [
              {
                id: "kalshi-risk",
                name: "Kalshi evidence gate audit",
                enabled: true,
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
                schedule: { kind: "every", everyMs: 60_000 } as never,
                sessionTarget: { kind: "main" } as never,
                wakeMode: "always" as never,
                payload: { kind: "agentTurn", message: "Audit risk" } as never,
                state: {
                  lastRunAtMs: Date.now(),
                  lastStatus: "error",
                  lastError: "risk gate failed",
                  consecutiveErrors: 1,
                },
              } as never,
            ],
          },
          kalshiDashboard: {
            generated_at_utc: "2026-05-07T10:00:00Z",
            data_quality: { stale: true },
          } as never,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const actions = [...container.querySelectorAll(".agent-attention-action strong")].map((entry) =>
      entry.textContent?.trim(),
    );
    expect(actions).toHaveLength(3);
    expect(actions[0]).toBe("OpenClaw is not connected to the Gateway.");
    expect(actions[1]).toBe("A messaging channel needs review.");
    expect(actions[2]).toBe('The scheduled job "Kalshi evidence gate audit" failed.');
  });

  it("flags active agents without loaded model coverage without blaming dormant agents", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
              { id: "beta", name: "Dormant Specialist" } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "main",
                  kind: "direct",
                  updatedAt: Date.now(),
                  status: "running",
                  displayName: "Answering operator",
                } as never,
              ],
            },
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ...createRamRuntimeStatus().result!,
              localModels: {
                ...createRamRuntimeStatus().result!.localModels,
                totalLoadedBytes: 0,
                count: 0,
                models: [],
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Awake agent without loaded local model");
    expect(container.textContent).toContain("Todd Stanski");
    expect(container.textContent).not.toContain("Dormant Specialist, Todd Stanski");
  });

  it("does not ask for action when an always-on director is only visually supervising", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
            ],
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ...createRamRuntimeStatus().result!,
              localModels: {
                ...createRamRuntimeStatus().result!.localModels,
                totalLoadedBytes: 0,
                count: 0,
                models: [],
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Watching");
    expect(container.textContent).toContain(
      "OpenClaw is running and watching active responsibilities. No action is needed right now.",
    );
    expect(container.textContent).not.toContain("Awake agent without loaded local model");
  });

  it("keeps low runtime telemetry facts out of top next actions", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          opsSummary: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              state: "watching",
              issues: [
                {
                  id: "runtime-warning-0",
                  severity: "low",
                  title: "Runtime telemetry warning",
                  affected: "Local model runtime",
                  detectedAt: Date.now(),
                  likelyCause: "qwen3.5:27b-q8_0 is using 34 GB",
                  nextInspection: "agents.runtime.status",
                  source: "runtime",
                },
              ],
              checks: {
                cronEnabled: true,
                cronJobs: 11,
                failedCronJobs: 0,
                nextCronRunAtMs: Date.now() + 60_000,
                channelAccounts: 1,
                loadedModelCount: 1,
                loadedModelBytes: 34 * 1024 ** 3,
                ollamaProcessRssBytes: 34 * 1024 ** 3,
                openclawProcessRssBytes: 1 * 1024 ** 3,
                macosAvailabilityEstimateBytes: 177 * 1024 ** 3,
              },
              next: {
                automation: "Next scheduled automation in 1 minute",
                nextCronRunAtMs: Date.now() + 60_000,
              },
              sources: {
                runtimeTelemetry: "live",
                cron: "live",
                channels: "live",
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Watching");
    expect(container.textContent).toContain("No action is needed right now");
    expect(container.querySelectorAll(".agent-attention-action")).toHaveLength(0);
    expect(container.textContent).toContain("Runtime telemetry warning");
  });

  it("surfaces stale Kalshi snapshots as Prediction Markets issues", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          kalshiDashboard: {
            generated_at_utc: "2026-05-07T10:00:00Z",
            data_quality: { stale: true },
          } as never,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Prediction Markets input data is stale");
    expect(container.textContent).toContain("fresh dashboard snapshot with stale upstream inputs");
    expect(container.textContent).toContain("Open Kalshi and inspect the data freshness cards");
  });

  it("separates fresh Prediction Markets snapshots from stale upstream inputs", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          kalshiDashboard: {
            generated_at_utc: new Date().toISOString(),
            data_quality: { stale: true },
          } as never,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const signals = readAgentSignalText(container);
    expect(signals).toContain("Prediction Markets Input stale");
    expect(signals).toContain("Fresh snapshot; upstream input marked stale");
    expect(signals).not.toContain("Prediction Markets Stale Signal");
  });

  it("summarizes Kalshi paper-learning velocity in plain English", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          kalshiDashboard: {
            generated_at_utc: new Date().toISOString(),
            live_order_allowed: false,
            self_improvement: {
              metrics: {
                scored_decisions: 16050,
                scored_decisions_last_24h: 412,
                accuracy: 0.42,
                average_pnl_per_scored_trade_usd: -0.12,
                realized_paper_pnl_all_time_usd: -1286.07,
                realized_paper_pnl_last_24h_usd: 38.25,
              },
            },
            strategy_scorecard: {
              summary: {
                scored_accepted_decisions: 6107,
                accuracy: 0.43,
                realized_pnl_usd: -1286.07,
                paused_segments: 12,
                forward_paper_candidates: 3,
              },
              improvement_summary: {
                most_important_lesson: {
                  title: "Pause thin weather buckets",
                  expected_effect: "Avoid repeated low-quality paper losses",
                },
                what_needs_to_happen_next: ["Grade the next batch of fast-resolving outcomes."],
                live_order_allowed: false,
              },
            },
            strategy_governor: {
              accepted_or_tested_count: 51,
              latest_change: {
                governor_action: "PAUSE_SEGMENT",
                plain_language_reason: "Removing this paper bucket avoids simulated losses.",
                live_order_allowed: false,
              },
              live_order_allowed: false,
            },
            paper_volume_accelerator: {
              metrics: {
                resolved_outcomes: 16050,
                what_must_happen_next_to_learn_faster:
                  "Prioritize markets with known result timing.",
              },
            },
          } as never,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Learning Velocity");
    expect(container.textContent).toContain("Learning now");
    expect(container.textContent).toContain("6,107 scored decisions");
    expect(container.textContent).toContain("412 scored in the last 24h");
    expect(container.textContent).toContain("Evidence scored");
    expect(container.textContent).toContain("Paused lanes");
    expect(container.textContent).toContain("PAUSE_SEGMENT");
    expect(container.textContent).toContain("Prioritize markets with known result timing.");
    expect(container.textContent).toContain(
      "Paper-only: live trading and live orders are blocked.",
    );
  });

  it("shows signal confidence and expected behavior in selected worker details", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [{ id: "main", name: "Control Director" } as never],
          },
          runtimeStatus: createRamRuntimeStatus(),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-room-worker__confidence")?.textContent).toContain(
      "Inferred",
    );
    expect(container.textContent).toContain("Expected behavior");
    expect(container.textContent).toContain("Always visible; summon directly");
  });

  it("shows beginner help, quick find shortcuts, and recent-change language", async () => {
    const container = document.createElement("div");
    const onAttentionAction = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
          onAttentionAction,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("What changed recently");
    expect(container.textContent).toContain("Since this tab loaded/refreshed");
    expect(container.textContent).toContain("Beginner help and quick find");
    expect(container.textContent).toContain("Gateway");
    expect(container.textContent).toContain("model RAM");
    expect(container.textContent).toContain("paper trading");

    const kalshiShortcut = [
      ...container.querySelectorAll<HTMLButtonElement>(".agent-room-help__shortcuts button"),
    ].find((entry) => entry.textContent?.includes("Kalshi status"));
    kalshiShortcut?.click();

    expect(onAttentionAction).toHaveBeenCalledWith({
      kind: "appTab",
      tab: "kalshi",
      label: "Open Kalshi",
    });
  });

  it("labels Prediction Markets learning as paper-only self-improvement", async () => {
    const container = document.createElement("div");

    render(renderAgents(createProps({ activePanel: "room" })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("Self-Improvement / Learning Queue");
    expect(container.textContent).toContain("What changed");
    expect(container.textContent).toContain("What stayed blocked / next best proof");
    expect(container.textContent).toContain("Paper-only");
  });

  it("renders Self-Improvement recommendation cards with routing and safety", async () => {
    const container = document.createElement("div");
    const recommendation = {
      id: "sir_test",
      fingerprint: "fingerprint",
      createdAt: Date.parse("2026-05-07T12:00:00.000Z"),
      updatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
      lastSeenAt: Date.parse("2026-05-07T12:00:00.000Z"),
      status: "open",
      title: "Failed dashboard smoke needs QA review",
      summary: "The dashboard smoke failed and needs targeted verification.",
      category: "smoke_failure",
      severity: "high",
      criticality: "high",
      priority: "high",
      impact: "high",
      effort: "medium",
      confidence: 0.9,
      groupKey: "smoke_failure:task_group:dashboard-smoke",
      groupTitle: "Dashboard smoke failures",
      recurrenceCount: 1,
      source: { kind: "task", label: "dashboard smoke", taskId: "task-1" },
      route: {
        role: "qa",
        targetAgentId: "telemetry-evaluation-analyst",
        targetAgentLabel: "QA Test Agent",
        reason: "Verification gap, smoke failure, or test-proof follow-up.",
      },
      recommendedAction: "Rerun the dashboard smoke and attach proof.",
      requiredEvidence: ["Rerun the affected dashboard/mobile smoke."],
      safety: {
        mode: "recommendation_only",
        mutationAllowed: false,
        requiresApproval: true,
        requiresTests: true,
        blockedActions: ["no direct merge, push, or release"],
      },
      analysis: {
        mode: "deterministic",
        summary: "One evidence-backed recommendation is ready for routed review.",
        generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
        confidence: 0.9,
        promptVersion: "self-improvement-deterministic-v1",
        evidenceCount: 1,
        safetyNotes: ["Recommendation-only."],
      },
      evidence: ["Task task-1 status: failed"],
      actionability: {
        ownerState: "unassigned",
        slaState: "overdue",
        proofState: "missing",
        closureState: "blocked",
        rank: 3950,
        ageMs: 300_000,
        slaMs: 259_200_000,
        dueAt: Date.parse("2026-05-10T12:00:00.000Z"),
        overdueMs: 1_000,
        blockers: ["No owner assigned.", "Resolution proof is missing."],
        nextAction: "Assign an owner immediately and attach the proof path.",
      },
    } satisfies SelfImprovementRecommendation;
    const group = {
      id: "sig_test",
      groupKey: recommendation.groupKey,
      title: "Dashboard smoke failures",
      category: "smoke_failure",
      severity: "high",
      criticality: "high",
      priority: "high",
      status: "open",
      route: recommendation.route,
      count: 2,
      open: 1,
      acknowledged: 0,
      assigned: 0,
      inProgress: 0,
      reopened: 0,
      quarantined: 0,
      resolved: 0,
      dismissed: 0,
      requiresTests: true,
      requiresApproval: true,
      firstSeenAt: recommendation.createdAt,
      lastSeenAt: recommendation.lastSeenAt,
      lastUpdatedAt: recommendation.updatedAt,
      recommendationIds: [recommendation.id],
      topEvidence: ["Task task-1 status: failed"],
      recommendedAction: recommendation.recommendedAction,
      analysis: recommendation.analysis,
      actionability: recommendation.actionability,
    } satisfies SelfImprovementRecommendationGroup;
    const actionQueue = {
      generatedAt: Date.parse("2026-05-07T12:10:00.000Z"),
      total: 1,
      unassigned: 1,
      overdue: 1,
      proofMissing: 1,
      readyToResolve: 0,
      blocked: 1,
      items: [
        {
          kind: "group",
          id: group.id,
          title: group.title,
          status: group.status,
          priority: group.priority,
          route: group.route,
          actionability: group.actionability,
        },
      ],
    } satisfies SelfImprovementActionQueueSummary;
    const proposal = {
      id: "sip_test",
      createdAt: recommendation.createdAt,
      updatedAt: recommendation.updatedAt,
      status: "pending",
      kind: "verification",
      groupId: group.id,
      groupKey: group.groupKey,
      title: "Verification proposal: Dashboard smoke failures",
      summary: "Queue the dashboard smoke verification follow-up.",
      route: recommendation.route,
      sourceRecommendationIds: [recommendation.id],
      recommendedAction: "Rerun the dashboard smoke before resolving.",
      requiredEvidence: ["Smoke proof"],
      safetyNotes: ["Recommendation-only."],
      approvalRequired: true,
      testsRequired: true,
      analysisMode: "deterministic",
    } satisfies SelfImprovementProposal;
    const memoryProposal = {
      id: "sip_memory",
      createdAt: recommendation.createdAt,
      updatedAt: recommendation.updatedAt,
      status: "pending",
      kind: "memory_skill",
      groupId: "sig_memory",
      groupKey: "knowledge_hygiene:knowledge:memory",
      title: "Pending memory/skill proposal: repeated correction",
      summary: "Capture a repeated correction as a pending Skill Workshop proposal.",
      route: {
        role: "memory_curator",
        targetAgentId: "memory-knowledge-curator",
        targetAgentLabel: "Memory/Knowledge Curator",
        reason: "Memory and skill curation.",
      },
      sourceRecommendationIds: [recommendation.id],
      recommendedAction: "Draft a pending Skill Workshop proposal.",
      requiredEvidence: ["Repeated correction evidence"],
      safetyNotes: ["No uncontrolled memory or skill writes."],
      approvalRequired: true,
      testsRequired: false,
      analysisMode: "deterministic",
      curatorStatus: "accepted_for_workshop",
      curatorProof: "Reviewed repeated correction evidence.",
    } satisfies SelfImprovementProposal;
    const onGroupUpdate = vi.fn();
    const onCuratorUpdate = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "self-improvement",
          selfImprovement: {
            loading: false,
            error: null,
            recommendations: [recommendation],
            groups: [group],
            scorecard: {
              generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
              totalRecommendations: 1,
              activeRecommendations: 1,
              groupedRecommendations: 1,
              criticalOpen: 0,
              highOpen: 1,
              testRequired: 1,
              approvalRequired: 1,
              reopenedLast24h: 0,
              resolvedLast24h: 0,
              byCategory: [{ key: "smoke_failure", label: "smoke failure", count: 1 }],
              byRoute: [{ key: "qa", label: "qa", count: 1 }],
              needsApproval: [group],
              whatImproved: [],
              whatWorsened: [group],
              actionQueue,
              intelligence: {
                generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
                total: 2,
                highCritical: 1,
                requiresApproval: 1,
                requiresTests: 1,
                byCategory: [
                  {
                    category: "workflow_simplification",
                    label: "workflow simplification",
                    count: 1,
                    highCritical: 1,
                    routes: [{ key: "program_manager", label: "program manager", count: 1 }],
                  },
                ],
                topOpportunities: [
                  {
                    id: "sig_efficiency",
                    title: "Repeated verification workflow can be simplified",
                    category: "workflow_simplification",
                    priority: "high",
                    route: {
                      role: "program_manager",
                      targetAgentId: "program-manager",
                      targetAgentLabel: "Program Manager",
                      reason: "Sequencing and prioritization.",
                    },
                    count: 1,
                    confidence: 0.86,
                    firstSeenAt: Date.parse("2026-05-07T11:00:00.000Z"),
                    lastSeenAt: Date.parse("2026-05-07T12:00:00.000Z"),
                    ageMs: 3_600_000,
                    recommendedAction: "Sequence a simplification proposal with parity proof.",
                    blockers: [],
                  },
                ],
                stalePatterns: [],
                instructionThemes: [],
                simplificationCandidates: [],
                majorChangeCandidates: [],
                outcomeMetricGaps: [],
              },
            },
            scorecards: [
              {
                id: "sis_2026-05-07",
                dateKey: "2026-05-07",
                createdAt: Date.parse("2026-05-07T12:00:00.000Z"),
                scorecard: {
                  generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
                  totalRecommendations: 1,
                  activeRecommendations: 1,
                  groupedRecommendations: 1,
                  criticalOpen: 0,
                  highOpen: 1,
                  testRequired: 1,
                  approvalRequired: 1,
                  reopenedLast24h: 0,
                  resolvedLast24h: 0,
                  byCategory: [{ key: "smoke_failure", label: "smoke failure", count: 1 }],
                  byRoute: [{ key: "qa", label: "qa", count: 1 }],
                  needsApproval: [group],
                  whatImproved: [],
                  whatWorsened: [group],
                  actionQueue,
                },
              },
            ],
            health: {
              current: {
                generatedAt: Date.parse("2026-05-07T12:10:00.000Z"),
                status: "degraded",
                score: 74,
                trend: "worsening",
                intervalMs: 21_600_000,
                staleAfterMs: 43_200_000,
                dimensions: [
                  {
                    id: "recommendations",
                    label: "Recommendations",
                    status: "degraded",
                    score: 72,
                    summary: "1 active recommendation, 1 high/critical.",
                    metrics: [
                      { key: "activeRecommendations", label: "Active", value: 1 },
                      { key: "highCriticalOpen", label: "High/critical open", value: 1 },
                    ],
                    blockers: ["High/critical recommendation count increased."],
                    nextActions: ["Review the highest-priority routed recommendations."],
                  },
                  {
                    id: "reviewer",
                    label: "Reviewer evals",
                    status: "degraded",
                    score: 70,
                    summary: "Latest reviewer eval is degraded.",
                    metrics: [{ key: "stale", label: "Stale", value: false }],
                    blockers: ["Latest reviewer eval is degraded."],
                    nextActions: ["Run reviewer evals."],
                  },
                ],
                blockers: [
                  "High/critical recommendation count increased.",
                  "Latest reviewer eval is degraded.",
                ],
                nextActions: ["Run reviewer evals."],
                latestReviewerEvalAt: Date.parse("2026-05-07T12:10:00.000Z"),
                latestModelPreflightAt: Date.parse("2026-05-07T12:00:00.000Z"),
                latestAnalysisAt: Date.parse("2026-05-07T12:00:00.000Z"),
                latestBackgroundAt: Date.parse("2026-05-07T12:00:00.000Z"),
              },
              snapshots: [
                {
                  id: "sih_test",
                  createdAt: Date.parse("2026-05-07T12:10:00.000Z"),
                  health: {
                    generatedAt: Date.parse("2026-05-07T12:10:00.000Z"),
                    status: "degraded",
                    score: 74,
                    trend: "worsening",
                    intervalMs: 21_600_000,
                    staleAfterMs: 43_200_000,
                    dimensions: [],
                    blockers: [],
                    nextActions: [],
                  },
                },
              ],
            },
            proposals: [proposal, memoryProposal],
            auditEvents: [
              {
                id: "sie_1",
                createdAt: Date.parse("2026-05-07T12:00:00.000Z"),
                kind: "model_preflight",
                actor: "gateway",
                targetId: "self-improvement-models",
                summary: "Checked Self-Improvement model readiness: degraded.",
                metadata: {
                  readiness: "degraded",
                  readyTier: "crossCheck",
                  preflightSources: ["crossCheck:default_ollama:default"],
                  defaultOllamaFallbackAttempts: 1,
                  invalidJsonDiagnostics: ["missing_required_fields"],
                  primaryRemediationHint:
                    "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
                },
              },
              {
                id: "sie_eval",
                createdAt: Date.parse("2026-05-07T12:10:00.000Z"),
                kind: "reviewer_eval_run",
                actor: "governor",
                targetId: "self-improvement-reviewer",
                summary: "Ran Self-Improvement reviewer evals: degraded.",
                metadata: {
                  readiness: "degraded",
                  ready: false,
                  passRate: 0.75,
                  schemaValidRate: 1,
                  safetyPassRate: 0.75,
                  routePreservationRate: 1,
                  p95CompletionMs: 4321,
                  modelId: "ollama/qwen3.6:27b-q8_0",
                  modelTier: "primaryReview",
                  failedCases: ["skill_workshop_pending_only:unsafe_action"],
                  diagnostics: ["unsafe_action:1"],
                },
              },
            ],
            total: 1,
            scanLoading: false,
            lastScan: {
              scannedAt: Date.parse("2026-05-07T12:00:00.000Z"),
              trigger: "manual",
              inspected: { tasks: 1, cronJobs: 0, auditEvents: 0, skillWorkshopProposals: 0 },
              produced: 1,
              created: 1,
              updated: 0,
              reopened: 0,
              total: 1,
              open: 1,
            },
            analysisLoading: false,
            lastAnalysis: {
              analyzedAt: Date.parse("2026-05-07T12:00:00.000Z"),
              mode: "fallback",
              modelId: "gpt-5.5",
              ready: false,
              readiness: "blocked",
              confidence: 0.74,
              reviewPolicy: "hosted",
              reviewModelId: "gpt-5.5",
              promptVersion: "self-improvement-governor-analysis-v1",
              llmRequested: true,
              llmApproved: false,
              localFirst: false,
              hostedEscalationAllowed: false,
              strategicLocalAllowed: false,
              groupsAnalyzed: 1,
              groupsReviewedByLlm: 0,
              groupsReviewedByLocalLlm: 0,
              recommendationsUpdated: 0,
              proposalsCreated: 1,
              attempts: [
                {
                  attempt: 1,
                  tier: "hostedEscalation",
                  modelId: "gpt-5.5",
                  status: "blocked",
                  local: false,
                  schemaValidated: false,
                  groupsReviewed: 0,
                  preflightStatus: "not_required",
                  preflightMs: 0,
                },
                {
                  attempt: 2,
                  tier: "crossCheck",
                  modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
                  status: "invalid_json",
                  local: true,
                  schemaValidated: false,
                  groupsReviewed: 0,
                  quantization: "Q6",
                  parameters: "30B",
                  contextWindow: 262_144,
                  maxOutputTokens: 8_192,
                  temperature: 0.2,
                  topP: 0.95,
                  timeoutMs: 180_000,
                  preflightStatus: "passed",
                  preflightSource: "default_ollama",
                  providerConfigured: false,
                  preflightMs: 7,
                  completionMs: 1234,
                  diagnostic: "missing_required_fields",
                  error:
                    "Reviewer returned invalid JSON. Reason: review groups were missing summary, recommendedAction, or confidence.",
                },
              ],
              schemaValidated: false,
              preflightStatus: "not_required",
              preflightMs: 0,
              fallbackReason: "LLM analysis was requested.",
              blockedPrimaryReason: "Hosted LLM review requires explicit per-run approval.",
              scorecard: {
                generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
                totalRecommendations: 1,
                activeRecommendations: 1,
                groupedRecommendations: 1,
                criticalOpen: 0,
                highOpen: 1,
                testRequired: 1,
                approvalRequired: 1,
                reopenedLast24h: 0,
                resolvedLast24h: 0,
                byCategory: [{ key: "smoke_failure", label: "smoke failure", count: 1 }],
                byRoute: [{ key: "qa", label: "qa", count: 1 }],
                needsApproval: [group],
                whatImproved: [],
                whatWorsened: [group],
                actionQueue,
                intelligence: {
                  generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
                  total: 2,
                  highCritical: 1,
                  requiresApproval: 1,
                  requiresTests: 1,
                  byCategory: [
                    {
                      category: "workflow_simplification",
                      label: "workflow simplification",
                      count: 1,
                      highCritical: 1,
                      routes: [{ key: "program_manager", label: "program manager", count: 1 }],
                    },
                  ],
                  topOpportunities: [
                    {
                      id: "sig_efficiency",
                      title: "Repeated verification workflow can be simplified",
                      category: "workflow_simplification",
                      priority: "high",
                      route: {
                        role: "program_manager",
                        targetAgentId: "program-manager",
                        targetAgentLabel: "Program Manager",
                        reason: "Sequencing and prioritization.",
                      },
                      count: 1,
                      confidence: 0.86,
                      firstSeenAt: Date.parse("2026-05-07T11:00:00.000Z"),
                      lastSeenAt: Date.parse("2026-05-07T12:00:00.000Z"),
                      ageMs: 3_600_000,
                      recommendedAction: "Sequence a simplification proposal with parity proof.",
                      blockers: [],
                    },
                  ],
                  stalePatterns: [],
                  instructionThemes: [],
                  simplificationCandidates: [],
                  majorChangeCandidates: [],
                  outcomeMetricGaps: [],
                },
              },
              proposals: [proposal, memoryProposal],
            },
            modelPreflightLoading: false,
            lastModelPreflight: {
              checkedAt: Date.parse("2026-05-07T12:00:00.000Z"),
              ready: true,
              readiness: "degraded",
              readyTier: "crossCheck",
              readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
              reviewPolicy: "local_first",
              reviewModelId: "ollama/qwen3.6:27b-q8_0",
              fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
              strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
              localFirst: true,
              hostedEscalationAllowed: false,
              strategicLocalAllowed: false,
              strategicRequested: false,
              attempts: [
                {
                  attempt: 1,
                  tier: "primaryReview",
                  modelId: "ollama/qwen3.6:27b-q8_0",
                  status: "blocked",
                  local: true,
                  schemaValidated: false,
                  groupsReviewed: 0,
                  quantization: "Q8_0",
                  parameters: "27B",
                  contextWindow: 65_536,
                  maxOutputTokens: 8_192,
                  temperature: 0.2,
                  topP: 0.95,
                  timeoutMs: 180_000,
                  preflightStatus: "missing_config",
                  providerConfigured: false,
                  preflightMs: 1,
                  error: "Local model preflight could not find qwen3.6:27b-q8_0.",
                  remediationHint:
                    "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
                },
                {
                  attempt: 2,
                  tier: "crossCheck",
                  modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
                  status: "success",
                  local: true,
                  schemaValidated: false,
                  groupsReviewed: 0,
                  quantization: "Q6",
                  parameters: "30B",
                  contextWindow: 262_144,
                  maxOutputTokens: 8_192,
                  temperature: 0.2,
                  topP: 0.95,
                  timeoutMs: 180_000,
                  preflightStatus: "passed",
                  preflightSource: "default_ollama",
                  providerConfigured: false,
                  preflightMs: 6,
                },
              ],
              preflightStatus: "missing_config",
              preflightMs: 7,
              schemaValidated: false,
              blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
            },
            productionCheckLoading: false,
            lastProductionCheck: {
              checkedAt: Date.parse("2026-05-07T12:15:00.000Z"),
              status: "degraded",
              ready: false,
              score: 74,
              failOnDegraded: false,
              failOnBlocked: false,
              requireModelReady: false,
              requireEvalsReady: false,
              blockers: ["High/critical recommendation count increased."],
              warnings: ["No retention maintenance audit event is recorded yet."],
              nextActions: ["Run reviewer evals."],
              evidence: [
                {
                  key: "recommendations",
                  label: "Recommendations",
                  status: "degraded",
                  summary: "1 active recommendation, 1 high/critical.",
                  source: "operational-health:recommendations",
                },
                {
                  key: "maintenance",
                  label: "Retention maintenance",
                  status: "degraded",
                  summary: "No retention maintenance audit event is recorded yet.",
                  source: "audit-events:retention_maintenance",
                },
              ],
              health: {
                generatedAt: Date.parse("2026-05-07T12:10:00.000Z"),
                status: "degraded",
                score: 74,
                trend: "worsening",
                intervalMs: 21_600_000,
                staleAfterMs: 43_200_000,
                dimensions: [],
                blockers: [],
                nextActions: [],
              },
            },
            maintenanceLoading: false,
            lastMaintenance: {
              maintainedAt: Date.parse("2026-05-07T12:16:00.000Z"),
              dryRun: true,
              applied: false,
              stores: [
                {
                  store: "recommendations",
                  before: 12,
                  after: 10,
                  pruned: 2,
                  retainedActive: 4,
                  retentionDays: 90,
                  maxRecords: 1000,
                },
              ],
              totalBefore: 12,
              totalAfter: 10,
              totalPruned: 2,
            },
          },
          onSelfImprovementGroupUpdate: onGroupUpdate,
          onSelfImprovementCuratorUpdate: onCuratorUpdate,
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    expect(container.textContent).toContain("Self-Improvement Recommendations");
    expect(container.textContent).toContain("Operational health");
    expect(container.textContent).toContain("score 74");
    expect(container.textContent).toContain("Reviewer evals");
    expect(container.textContent).toContain("Latest reviewer eval is degraded.");
    expect(container.textContent).toContain("Dashboard smoke failures");
    expect(container.textContent).toContain("QA Test Agent");
    expect(container.textContent).toContain("Recommendation-only");
    expect(container.textContent).toContain("tests required");
    expect(container.textContent).toContain("Action Queue");
    expect(container.textContent).toContain("Unassigned");
    expect(container.textContent).toContain("Proof missing");
    expect(container.textContent).toContain("Improvement Intelligence");
    expect(container.textContent).toContain("workflow simplification");
    expect(container.textContent).toContain("Repeated verification workflow can be simplified");
    expect(container.textContent).toContain("Production readiness");
    expect(container.textContent).toContain("Retention maintenance");
    expect(container.textContent).toContain("dry run");
    expect(container.textContent).toContain("operational-health:recommendations");
    expect(container.textContent).toContain("Program Manager");
    expect(container.textContent).toContain("Owner unassigned");
    expect(container.textContent).toContain("Assign an owner immediately");
    const assignGroupButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Assign group"),
    );
    assignGroupButton?.click();
    expect(onGroupUpdate).toHaveBeenCalledWith({
      id: "sig_test",
      status: "assigned",
      assignedTargetAgentId: "telemetry-evaluation-analyst",
    });
    expect(container.textContent).toContain("Needs approval");
    expect(container.textContent).toContain("High");
    expect(container.textContent).toContain("Daily scorecards");
    expect(container.textContent).toContain("Proposal Queue");
    expect(container.textContent).toContain("Verification proposal");
    expect(container.textContent).toContain("Memory/Skill Curator Queue");
    expect(container.textContent).toContain("Pending memory/skill proposal");
    expect(container.textContent).toContain("Need workshop link");
    expect(container.textContent).toContain("no direct skill write");
    const linkWorkshopButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Link workshop"),
    );
    linkWorkshopButton?.click();
    expect(onCuratorUpdate).toHaveBeenCalledWith({
      id: "sip_memory",
      curatorStatus: "accepted_for_workshop",
      proof: "",
      workshopProposalId: "",
      workshopProposalStatus: "pending",
    });
    expect(container.textContent).toContain("Audit Ledger");
    const normalizedText = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalizedText).toContain("Reviewer eval health");
    expect(normalizedText).toContain("pass 75%");
    expect(normalizedText).toContain("schema 100%");
    expect(normalizedText).toContain("safety 75%");
    expect(normalizedText).toContain("route 100%");
    expect(normalizedText).toContain("p95 4321ms");
    expect(container.textContent).toContain("skill_workshop_pending_only:unsafe_action");
    expect(container.textContent).toContain("Checked Self-Improvement model readiness: degraded.");
    expect(container.textContent).toContain("model preflight");
    expect(container.textContent).toContain("self-improvement-models");
    expect(container.textContent).toContain("primaryRemediationHint");
    expect(container.textContent).toContain("invalidJsonDiagnostics");
    expect(container.textContent).toContain("missing_required_fields");
    expect(container.textContent).toContain("Last analysis");
    expect(container.textContent).toContain("confidence 74%");
    expect(container.textContent).toContain("confidence 90%");
    expect(container.textContent).toContain("readiness blocked");
    expect(container.textContent).toContain("ready false");
    expect(container.textContent).toContain("preflight not_required");
    expect(container.textContent).toContain("LLM analysis was requested");
    expect(container.textContent).toContain("crossCheck diagnostic missing_required_fields");
    expect(container.textContent).toContain("Q6");
    expect(container.textContent).toContain("30B");
    expect(container.textContent).toContain("262,144 ctx");
    expect(container.textContent).toContain("max 8,192");
    expect(container.textContent).toContain("temp 0.2");
    expect(container.textContent).toContain("top_p 0.95");
    expect(container.textContent).toContain("timeout 180000ms");
    expect(container.textContent).toContain("completion 1234ms");
    expect(container.textContent).toContain("source default_ollama");
    expect(container.textContent).toContain("provider default");
    expect(container.textContent).toContain("Hosted LLM review requires explicit per-run approval");
    expect(container.textContent).toContain("Check models");
    expect(container.textContent).toContain("Model readiness");
    expect(container.textContent).toContain("degraded | ready true");
    expect(container.textContent).toContain(
      "ready via crossCheck ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(container.textContent).toContain("primaryReview blocked ollama/qwen3.6:27b-q8_0");
    expect(container.textContent).toContain("Q8_0");
    expect(container.textContent).toContain("27B");
    expect(container.textContent).toContain("65,536 ctx");
    expect(container.textContent).toContain("timeout 180000ms");
    expect(container.textContent).toContain(
      "primaryReview: Local model preflight could not find qwen3.6:27b-q8_0.",
    );
    expect(container.textContent).toContain("Next: Verify Ollama is running");
    expect(container.textContent).toContain(
      "crossCheck success ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(container.textContent).toContain("preflightSources");
    expect(container.textContent).toContain("defaultOllamaFallbackAttempts");
  });

  it("renders project groups as ordered full room sections", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "main", name: "Control Director" } as never,
              { id: "polymarket-market-watch-agent", name: "Market Watch Agent" } as never,
            ],
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    const rooms = [...container.querySelectorAll<HTMLElement>(".agent-room-project")];

    expect(rooms.length).toBeGreaterThan(1);
    expect(rooms[0]?.querySelector(".agent-room-project__marker")?.textContent?.trim()).toBe(
      "Room 1",
    );
    expect(rooms[0]?.querySelector(".agent-room-project__label")?.textContent?.trim()).toBe(
      "Shared Command",
    );
    expect(rooms[1]?.querySelector(".agent-room-project__marker")?.textContent?.trim()).toBe(
      "Room 2",
    );
    expect(rooms[1]?.querySelector(".agent-room-project__label")?.textContent?.trim()).toBe(
      "Prediction Markets",
    );
    expect(rooms.every((room) => room.querySelector(".agent-room-project__workers"))).toBe(true);
  });

  it("shows the Control Director thinking-as-needed policy in Agents Room", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                model: {
                  primary: "ollama/openclaw-control-qwen36-27b:latest",
                  fallbacks: ["ollama/openclaw-control-qwen25-32b:latest"],
                },
              } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "main",
                  kind: "direct",
                  updatedAt: Date.now(),
                  status: "done",
                  displayName: "Control Director smoke",
                  thinkingDefault: "off",
                  thinkingLevel: "medium",
                  model: "openclaw-control-qwen25-32b:latest",
                  modelProvider: "ollama",
                } as never,
              ],
            },
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    expect(container.textContent).toContain("Thinking as needed");
    expect(container.textContent).toContain("Session override: medium");
    expect(container.textContent).toContain("Qwen3.6 primary configured");
    expect(container.textContent).toContain("Primary model");
    expect(container.textContent).toContain("ollama/openclaw-control-qwen36-27b:latest");
    expect(container.textContent).toContain("Rollback model");
    expect(container.textContent).toContain("ollama/openclaw-control-qwen25-32b:latest");
    expect(container.textContent).toContain("Last run model");
  });

  it("groups current Game Studio and OpenBrain agents into sensible Live Agent Workspace rooms", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "openclaw-game-director",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "main", name: "Control Director" } as never,
              { id: "openbrain-local-smoke", name: "OpenBrain Local Smoke" } as never,
              {
                id: "openclaw-game-director",
                name: "OpenClaw Game Director",
                identity: { name: "OpenClaw Game Director" },
              } as never,
              {
                id: "snes-game-director",
                name: "snes-game-director",
                identity: { name: "OpenClaw Game Director" },
              } as never,
              { id: "openclaw-level-designer", name: "OpenClaw Level Designer" } as never,
              { id: "snes-level-designer", name: "snes-level-designer" } as never,
            ],
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    expect(container.textContent).toContain("Product and Build Lab");
    expect(container.textContent).toContain("OpenBrain Local Smoke");
    expect(container.textContent).toContain("Game Studio");
    expect(container.textContent).toContain("OpenClaw Level Designer");
    expect(container.querySelector('[data-agent-id="openclaw-game-director"]')).toBeTruthy();
    expect(container.querySelector('[data-agent-id="snes-game-director"]')).toBeNull();
    expect(container.querySelector('[data-agent-id="openclaw-level-designer"]')).toBeTruthy();
    expect(container.querySelector('[data-agent-id="snes-level-designer"]')).toBeNull();
  });

  it("offers a direct dashboard room assignment control for unmapped agents", async () => {
    const container = document.createElement("div");
    const onAssignAgentRoom = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "new-specialist",
          onAssignAgentRoom,
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "main", name: "Control Director" } as never,
              { id: "new-specialist", name: "New Specialist" } as never,
            ],
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    expect(container.textContent?.replace(/\s+/g, " ")).toContain("1 unmapped agent");
    const selector = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Assign New Specialist to a workspace room"]',
    );
    expect(selector).not.toBeNull();
    expect([...selector!.options].map((option) => option.textContent?.trim())).toEqual(
      expect.arrayContaining(["Product and Build Lab", "Game Studio", "Music Studio"]),
    );
    selector!.value = "build";
    selector!.dispatchEvent(new Event("change"));
    expect(onAssignAgentRoom).toHaveBeenCalledWith("new-specialist", "build");
  });

  it("offers canonical room reassignment from the selected agent detail card", async () => {
    const container = document.createElement("div");
    const onAssignAgentRoom = vi.fn();

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "openbrain-local-smoke",
          onAssignAgentRoom,
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "main", name: "Control Director" } as never,
              { id: "openbrain-local-smoke", name: "OpenBrain Local Smoke" } as never,
            ],
          },
        }),
      ),
      container,
    );
    await waitForLazyAgentPanel();

    const selector = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Change OpenBrain Local Smoke workspace room"]',
    );
    expect(selector).not.toBeNull();
    expect(selector!.value).toBe("build");
    selector!.value = "music";
    selector!.dispatchEvent(new Event("change"));
    expect(onAssignAgentRoom).toHaveBeenCalledWith("openbrain-local-smoke", "music");
  });

  it("adds a Workflow Maps tab inside the Agents workspace", async () => {
    const container = document.createElement("div");
    const props = createProps({ activePanel: "workflows" });

    render(renderAgents(props), container);
    await waitForLazyAgentPanel();
    render(renderAgents(props), container);
    await Promise.resolve();

    expect(
      [...container.querySelectorAll(".agent-tab")].map((tab) => tab.textContent?.trim()),
    ).toContain("Agent Workflow Maps");
    expect(container.textContent).toContain("OpenClaw Agent Workflow Maps");
    expect(container.textContent).toContain("Shared Command");
    expect(container.textContent).toContain("Codex only by explicit summon");
  });

  it("renders named director pixel workers with separate titles", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "strategic-director",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                identity: { name: "Todd Stanski" },
              } as never,
              {
                id: "strategic-director",
                name: "Strategic Director",
                identity: { name: "Einstein" },
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const todd = container.querySelector<HTMLElement>('[data-agent-id="main"]');
    const einstein = container.querySelector<HTMLElement>('[data-agent-id="strategic-director"]');

    expect(todd?.querySelector(".agent-room-worker__label")?.textContent?.trim()).toBe(
      "Todd Stanski",
    );
    expect(todd?.querySelector(".agent-room-worker__title")?.textContent?.trim()).toBe(
      "Control Director",
    );
    expect(einstein?.querySelector(".agent-room-worker__label")?.textContent?.trim()).toBe(
      "Einstein",
    );
    expect(einstein?.querySelector(".agent-room-worker__title")?.textContent?.trim()).toBe(
      "Strategic Director",
    );
  });

  it("keeps the RAM availability monitor as a permanent Agents dashboard fixture", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "overview",
          runtimeStatus: createRamRuntimeStatus(),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll(".agent-room-resource")).toHaveLength(1);
    expect(container.textContent).toContain("RAM possible / available");
    expect(container.textContent).toContain("Why this much RAM is possible");
    expect(container.textContent).toContain("Process RAM seen");
  });

  it("keeps the permanent RAM monitor visible across every Agents panel", async () => {
    const panels: AgentsProps["activePanel"][] = [
      "room",
      "workflows",
      "overview",
      "files",
      "tools",
      "skills",
      "channels",
      "cron",
    ];

    for (const panel of panels) {
      const container = document.createElement("div");

      render(
        renderAgents(
          createProps({
            activePanel: panel,
            runtimeStatus: createRamRuntimeStatus(),
          }),
        ),
        container,
      );
      await waitForLazyAgentPanel();

      expect(container.querySelectorAll(".agent-room-resource"), panel).toHaveLength(1);
      expect(container.textContent, panel).toContain("RAM possible / available");
      expect(container.textContent, panel).toContain("Why this much RAM is possible");
    }
  });

  it("does not duplicate the permanent RAM monitor inside the Live Agent Workspace panel", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          runtimeStatus: createRamRuntimeStatus(),
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelectorAll(".agent-room-resource")).toHaveLength(1);
    expect(container.textContent).toContain("Live Agent Workspace");
    expect(container.textContent).toContain("RAM possible / available");
  });

  it("leads the room RAM monitor with true macOS availability instead of raw used RAM", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
            ],
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              system: {
                totalBytes: 256 * 1024 ** 3,
                freeBytes: 64 * 1024 ** 3,
                usedBytes: 192 * 1024 ** 3,
                usedRatio: 0.75,
                macosMemory: {
                  available: true,
                  pageSizeBytes: 16 * 1024,
                  freeBytes: 64 * 1024 ** 3,
                  speculativeBytes: 16 * 1024 ** 3,
                  purgeableBytes: 1 * 1024 ** 3,
                  fileBackedBytes: 96 * 1024 ** 3,
                  anonymousBytes: 28 * 1024 ** 3,
                  wiredBytes: 10 * 1024 ** 3,
                  compressedBytes: 256 * 1024 ** 2,
                  reclaimableBytes: 113 * 1024 ** 3,
                  availabilityEstimateBytes: 177 * 1024 ** 3,
                },
                processes: {
                  available: true,
                  totalRssBytes: 19 * 1024 ** 3,
                  openclawRssBytes: 1 * 1024 ** 3,
                  ollamaRssBytes: 15 * 1024 ** 3,
                  otherRssBytes: 3 * 1024 ** 3,
                  top: [],
                },
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 15 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "openclaw-control-qwen25-32b:latest",
                    model: "openclaw-control-qwen25-32b:latest",
                    sizeBytes: 15 * 1024 ** 3,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("RAM possible / available");
    expect(container.textContent).toContain("177 GB (69%)");
    expect(container.textContent).toContain("Low pressure");
    expect(container.textContent).toContain("80 GB unused now, 113 GB reclaimable cache");
    expect(container.textContent).toContain("macOS reported used");
    expect(container.textContent).toContain("192 GB / 256 GB");
    expect(container.textContent).toContain("Process RAM seen");
    expect(container.textContent).toContain("OpenClaw 1.0 GB, Ollama 15 GB, other 3.0 GB");
    expect(container.textContent).toContain("Why this much RAM is possible");
    expect(container.textContent).toContain("Unused now");
    expect(container.textContent).toContain("Reclaimable cache");
  });

  it("does not promote shared Control Director model users into duplicate directors", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "main",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                identity: { name: "Todd Stanski" },
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
              {
                id: "program-manager",
                name: "Program Manager",
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const workers = [...container.querySelectorAll<HTMLElement>(".agent-room-worker")];
    const controlTitles = workers.filter(
      (worker) =>
        worker.querySelector(".agent-room-worker__title")?.textContent?.trim() ===
          "Control Director" ||
        worker.querySelector(".agent-room-worker__label")?.textContent?.trim() ===
          "Control Director",
    );
    const programManager = container.querySelector<HTMLElement>(
      '[data-agent-id="program-manager"]',
    );

    expect(controlTitles).toHaveLength(1);
    expect(programManager?.querySelector(".agent-room-worker__label")?.textContent?.trim()).toBe(
      "Program Manager",
    );
  });

  it("keeps the Strategic Director unique when default or duplicate rows appear", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "strategic-director",
          agentsList: {
            defaultId: "strategic-director",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                identity: { name: "Todd Stanski" },
              } as never,
              {
                id: "strategic-director",
                name: "Strategic Director",
                identity: { name: "Einstein" },
              } as never,
              {
                id: "strategic-director-copy",
                name: "Strategic Director",
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const strategic = container.querySelector<HTMLElement>('[data-agent-id="strategic-director"]');
    const duplicate = container.querySelector<HTMLElement>(
      '[data-agent-id="strategic-director-copy"]',
    );
    const workers = [...container.querySelectorAll<HTMLElement>(".agent-room-worker")];
    const controlTitles = workers.filter(
      (worker) =>
        worker.querySelector(".agent-room-worker__title")?.textContent?.trim() ===
          "Control Director" ||
        worker.querySelector(".agent-room-worker__label")?.textContent?.trim() ===
          "Control Director",
    );

    expect(strategic).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(controlTitles).toHaveLength(1);
    expect(strategic?.querySelector(".agent-room-worker__label")?.textContent?.trim()).toBe(
      "Einstein",
    );
    expect(strategic?.querySelector(".agent-room-worker__title")?.textContent?.trim()).toBe(
      "Strategic Director",
    );
  });

  it("places the Memory and Knowledge Curator in Shared Command", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "memory-knowledge-curator",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "memory-knowledge-curator",
                name: "Memory & Knowledge Curator",
              } as never,
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const worker = container.querySelector<HTMLElement>(
      '[data-agent-id="memory-knowledge-curator"]',
    );
    const room = worker?.closest<HTMLElement>(".agent-room-project");

    expect(worker?.querySelector(".agent-room-worker__label")?.textContent?.trim()).toBe(
      "Memory & Knowledge Curator",
    );
    expect(room?.querySelector(".agent-room-project__label")?.textContent?.trim()).toBe(
      "Shared Command",
    );
    expect(container.textContent).toContain("memory promotion");
  });

  it("does not show stale completed smoke-test session text as current work", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          activePanel: "room",
          selectedAgentId: "automation-playbook-architect",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "automation-playbook-architect",
                name: "Automation & Playbook Architect",
              } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "agent:automation-playbook-architect:main",
                  kind: "direct",
                  status: "done",
                  updatedAt: Date.now() - 60 * 24 * 60 * 60_000,
                  displayName: "[Sat 2026-04-04 18:30 EDT] You are being smoke-tested as...",
                } as never,
              ],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const worker = container.querySelector<HTMLElement>(
      '[data-agent-id="automation-playbook-architect"]',
    );
    const task = worker?.querySelector(".agent-room-worker__task")?.textContent ?? "";

    expect(task).toContain("No active task");
    expect(task).not.toContain("smoke-tested");
  });

  it("selects the configured primary model on initial render", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const defaultSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(select?.value).toBe("openai/gpt-5.4");
      return select;
    });
    expect(defaultSelect?.selectedOptions[0]?.value).toBe("openai/gpt-5.4");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const inheritedSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(select?.value).toBe("");
      return select;
    });
    expect(inheritedSelect?.selectedOptions[0]?.textContent?.trim()).toBe(
      "Inherit default (openai/gpt-5.4)",
    );
  });

  it("remounts overview model controls when switching selected agents", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [
          { id: "alpha", model: { primary: "anthropic/claude-sonnet-4-6" } },
          { id: "beta", model: { primary: "openai/gpt-5.4" } },
        ],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const betaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(
        Array.from(select?.options ?? []).some((option) => option.value === "openai/gpt-5.4"),
      ).toBe(true);
      return select;
    });

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const alphaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(
        Array.from(select?.options ?? []).some(
          (option) => option.value === "anthropic/claude-sonnet-4-6",
        ),
      ).toBe(true);
      return select;
    });
    expect(alphaSelect).not.toBe(betaSelect);
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    let skillsTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
      (button) => button.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toBe("Skills");

    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    skillsTab = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
      (button) => button.textContent?.includes("Skills"),
    );

    expect(skillsTab?.textContent?.trim()).toContain("1");
  });

  it("keeps the Cron Jobs tab label while localizing channel refresh never state", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");
    const props = createProps({
      activePanel: "channels",
      channels: {
        snapshot: null,
        loading: false,
        error: null,
        lastSuccess: null,
      },
    });

    try {
      render(renderAgents(props), container);
      await waitForLazyAgentPanel();
      render(renderAgents(props), container);
      await Promise.resolve();

      const tabLabels = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).map(
        (button) => button.textContent?.trim(),
      );

      expect(tabLabels).toContain("Cron Jobs");
      expect(container.textContent).toContain("上次刷新：从未");
    } finally {
      await i18n.setLocale("en");
      vi.unstubAllGlobals();
    }
  });

  it("bridges Kalshi paper automation status into the agents room", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "polymarket-risk-controller",
          activePanel: "room",
          agentsList: {
            defaultId: "polymarket-risk-controller",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "polymarket-market-watch-agent", name: "Market Watch" } as never,
              { id: "polymarket-risk-controller", name: "Risk Controller" } as never,
            ],
          },
          kalshiDashboard: {
            generated_at_utc: new Date().toISOString(),
            live_order_allowed: false,
            live_readiness: {
              ok: false,
              readiness: "BLOCKED",
              live_trading_enabled: false,
              live_order_allowed: false,
              blockers: ["risk controller is not passing"],
              checks: {
                paper_log_ok: true,
                outcome_log_ok: true,
                risk_controller_ok: false,
                no_live_trading_ok: true,
                forward_paper_queue_ok: true,
                evidence_report_ok: true,
              },
            },
            accelerator: {
              scheduler: {
                scheduled_run_count: 10,
                weather_run_count: 20,
                latest_scheduled_completed_at_utc: new Date().toISOString(),
                latest_weather_timestamp_utc: new Date().toISOString(),
              },
            },
            self_improvement: {
              metrics: {
                scored_decisions: 10244,
                unresolved_paper_exposure_usd: 1200,
              },
            },
            strategy_scorecard: {
              summary: {
                scored_accepted_decisions: 10244,
                forward_paper_candidates: 0,
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Kalshi bridge: active");
    expect(container.textContent).toContain("10 scheduled");
    expect(container.textContent).toContain("20 weather");
    expect(container.textContent).toContain("Risk blocked");
    expect(container.textContent).toContain("risk controller is not passing");
  });

  it("does not count expected Kalshi live-readiness gates as needing help", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "polymarket-risk-controller",
          activePanel: "room",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "polymarket-market-watch-agent", name: "Market Watch" } as never,
              { id: "polymarket-risk-controller", name: "Risk Controller" } as never,
            ],
          },
          kalshiDashboard: {
            generated_at_utc: new Date().toISOString(),
            live_order_allowed: false,
            live_readiness: {
              ok: false,
              readiness: "BLOCKED",
              live_trading_enabled: false,
              live_order_allowed: false,
              blockers: ["no research scorecard is ready for forward paper"],
              checks: {
                paper_log_ok: true,
                outcome_log_ok: true,
                risk_controller_ok: true,
                no_live_trading_ok: true,
                forward_paper_queue_ok: true,
                evidence_report_ok: true,
                ready_scorecards: 0,
              },
            },
            accelerator: {
              scheduler: {
                scheduled_run_count: 4488,
                weather_run_count: 1236,
                latest_scheduled_completed_at_utc: new Date().toISOString(),
                latest_weather_timestamp_utc: new Date().toISOString(),
              },
            },
            self_improvement: {
              metrics: {
                scored_decisions: 13151,
                unresolved_paper_exposure_usd: 1200,
              },
            },
            strategy_scorecard: {
              summary: {
                scored_accepted_decisions: 13151,
                forward_paper_candidates: 0,
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Live gate blocked");
    expect(container.textContent).toContain("no research scorecard is ready for forward paper");
    expect(container.textContent).toContain("0 need help");
  });

  it("labels Kalshi automation bridge activity without implying agent model RAM is loaded", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "polymarket-strategy-improvement-analyst",
          activePanel: "room",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "polymarket-strategy-improvement-analyst",
                name: "Strategy Improvement Analyst",
                model: { primary: "ollama/prediction-market-strategy-qwen:latest" },
              } as never,
            ],
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              system: {
                totalBytes: 256 * 1024 ** 3,
                freeBytes: 128 * 1024 ** 3,
                usedBytes: 128 * 1024 ** 3,
                usedRatio: 0.5,
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 4 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "some-other-model:latest",
                    model: "some-other-model:latest",
                    sizeBytes: 4 * 1024 ** 3,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
          kalshiDashboard: {
            generated_at_utc: new Date().toISOString(),
            live_order_allowed: false,
            accelerator: {
              scheduler: {
                scheduled_run_count: 4488,
                weather_run_count: 1236,
                latest_scheduled_completed_at_utc: new Date().toISOString(),
                latest_weather_timestamp_utc: new Date().toISOString(),
              },
            },
            self_improvement: {
              metrics: {
                scored_decisions: 13151,
              },
            },
            strategy_scorecard: {
              summary: {
                scored_accepted_decisions: 13151,
                forward_paper_candidates: 2,
              },
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("Learning review");
    expect(container.querySelector(".agent-room-worker__ram")?.textContent?.trim()).toBe(
      "Bridge active",
    );
    expect(container.textContent).toContain("0 B - automation bridge active, no local LLM loaded");
    expect(container.querySelector(".agent-room-worker__ram")?.textContent).not.toContain(
      "RAM not loaded",
    );
  });

  it("excludes on-watch steward roles from loaded LLM coverage warnings", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "browser-session-credential-steward",
          activePanel: "room",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "main",
                name: "Control Director",
                model: { primary: "ollama/openclaw-control-qwen25-32b:latest" },
              } as never,
              {
                id: "browser-session-credential-steward",
                name: "Browser / Session / Credential Steward",
                model: { primary: "ollama/browser-steward-qwen:latest" },
              } as never,
            ],
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: Date.now(),
              system: {
                totalBytes: 256 * 1024 ** 3,
                freeBytes: 128 * 1024 ** 3,
                usedBytes: 128 * 1024 ** 3,
                usedRatio: 0.5,
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 29 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "openclaw-control-qwen25-32b:latest",
                    model: "openclaw-control-qwen25-32b:latest",
                    sizeBytes: 29 * 1024 ** 3,
                    contextLength: 32768,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("LLM active coverage");
    expect(container.textContent).toContain("1 / 1");
    expect(container.textContent).toContain("All model-active agents covered");
    expect(container.textContent).toContain("0 B - on watch, no local LLM loaded");
    expect(container.textContent).not.toContain("awake without loaded local model");
  });

  it("keeps non-running on-watch steward RAM labels accurate after recent activity", async () => {
    const container = document.createElement("div");
    const now = Date.now();

    render(
      renderAgents(
        createProps({
          selectedAgentId: "browser-session-credential-steward",
          activePanel: "room",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "browser-session-credential-steward",
                name: "Browser / Session / Credential Steward",
                model: { primary: "ollama/browser-steward-qwen:latest" },
              } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: now,
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "agent:browser-session-credential-steward:recent",
                  kind: "agent",
                  status: "done",
                  updatedAt: now,
                  startedAt: now - 1000,
                  endedAt: now,
                  displayName: "Credential boundary check",
                  model: "browser-steward-qwen:latest",
                  modelProvider: "ollama",
                } as never,
              ],
            },
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: now,
              system: {
                totalBytes: 256 * 1024 ** 3,
                freeBytes: 128 * 1024 ** 3,
                usedBytes: 128 * 1024 ** 3,
                usedRatio: 0.5,
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 29 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "openclaw-control-qwen25-32b:latest",
                    model: "openclaw-control-qwen25-32b:latest",
                    sizeBytes: 29 * 1024 ** 3,
                    contextLength: 32768,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-room-worker__ram")?.textContent?.trim()).toBe(
      "On watch",
    );
    expect(container.textContent).toContain("0 B - on watch, no local LLM loaded");
    expect(container.textContent).toContain(
      "On-watch role - model loads only when summoned; no resident RAM now",
    );
    expect(container.textContent).not.toContain("RAM not loaded");
    expect(container.textContent).not.toContain("Not loaded now - another model is resident");
    expect(container.textContent).not.toContain(
      "Unknown - model not found in local Ollama catalog",
    );
  });

  it("keeps running steward watch RAM labels calm when no local model is resident", async () => {
    const container = document.createElement("div");
    const now = Date.now();

    render(
      renderAgents(
        createProps({
          selectedAgentId: "browser-session-credential-steward",
          activePanel: "room",
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "workspace",
            agents: [
              {
                id: "browser-session-credential-steward",
                name: "Browser / Session / Credential Steward",
                model: { primary: "ollama/browser-steward-qwen:latest" },
              } as never,
            ],
          },
          sessions: {
            loading: false,
            error: null,
            result: {
              ts: now,
              path: "/tmp/sessions",
              count: 1,
              defaults: { modelProvider: null, model: null, contextTokens: null },
              sessions: [
                {
                  key: "agent:browser-session-credential-steward:running",
                  kind: "agent",
                  status: "running",
                  updatedAt: now,
                  startedAt: now - 1000,
                  displayName: "Guarding browser session handoff",
                  model: "browser-steward-qwen:latest",
                  modelProvider: "ollama",
                } as never,
              ],
            },
          },
          runtimeStatus: {
            loading: false,
            error: null,
            result: {
              ts: now,
              system: {
                totalBytes: 256 * 1024 ** 3,
                freeBytes: 128 * 1024 ** 3,
                usedBytes: 128 * 1024 ** 3,
                usedRatio: 0.5,
              },
              localModels: {
                provider: "ollama",
                available: true,
                totalLoadedBytes: 29 * 1024 ** 3,
                totalLoadedVramBytes: 0,
                count: 1,
                models: [
                  {
                    provider: "ollama",
                    name: "openclaw-control-qwen25-32b:latest",
                    model: "openclaw-control-qwen25-32b:latest",
                    sizeBytes: 29 * 1024 ** 3,
                    contextLength: 32768,
                  },
                ],
                installedAvailable: true,
                installedModels: [],
              },
              warnings: [],
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-room-worker__ram")?.textContent?.trim()).toBe(
      "On watch",
    );
    expect(container.textContent).toContain("0 B - on watch, no local LLM loaded");
    expect(container.textContent).toContain(
      "On-watch role - model loads only when summoned; no resident RAM now",
    );
    expect(container.textContent).not.toContain("RAM not loaded");
    expect(container.textContent).not.toContain("Not loaded now - another model is resident");
    expect(container.textContent).not.toContain(
      "Unknown - model not found in local Ollama catalog",
    );
  });
});

describe("renderAgentFiles", () => {
  it("renders the upgraded markdown preview structure with file metadata", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    expect(container.querySelector(".md-preview-dialog__reader.sidebar-markdown")).not.toBeNull();
    expect(container.querySelector(".md-preview-dialog__path")?.textContent?.trim()).toBe(
      "USER.md",
    );
    expect(container.querySelector(".md-preview-dialog__chip strong")?.textContent).toBe(
      "Saved Preview",
    );
    expect(container.textContent).toContain("Markdown Preview");
  });

  it("renders preview header controls as icon-only buttons with accessible labels", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".md-preview-dialog__actions button"),
    );

    expect(actions).toHaveLength(3);
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Expand preview",
      "Edit file",
      "Close preview",
    ]);
    expect(actions.map((button) => button.textContent?.trim())).toEqual(["", "", ""]);
  });

  it("resets the expanded preview button state when the dialog closes", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const dialog = container.querySelector<HTMLDialogElement>(".md-preview-dialog");
    const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel");
    const expandButton = container.querySelector<HTMLButtonElement>(".md-preview-expand-btn");

    expandButton?.click();

    expect(panel?.classList.contains("fullscreen")).toBe(true);
    expect(expandButton?.classList.contains("is-fullscreen")).toBe(true);
    expect(expandButton?.getAttribute("aria-pressed")).toBe("true");
    expect(expandButton?.getAttribute("aria-label")).toBe("Collapse preview");

    dialog?.dispatchEvent(new Event("close"));

    expect(panel?.classList.contains("fullscreen")).toBe(false);
    expect(expandButton?.classList.contains("is-fullscreen")).toBe(false);
    expect(expandButton?.getAttribute("aria-pressed")).toBe("false");
    expect(expandButton?.getAttribute("aria-label")).toBe("Expand preview");
  });
});
