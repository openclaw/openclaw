import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_APP_STUDIO_APPLE_FACTS,
  DEFAULT_APP_STUDIO_BUILD_ENGINE,
  DEFAULT_APP_STUDIO_FLOW_DRAFT,
} from "../controllers/app-studio-dashboard.ts";
import type { AppStudioDashboardProps } from "./app-studio-dashboard.ts";
import { renderAppStudioDashboard } from "./app-studio-dashboard.ts";

function baseProps(overrides: Partial<AppStudioDashboardProps> = {}): AppStudioDashboardProps {
  return {
    loading: false,
    error: null,
    snapshot: null,
    lastFetchAt: null,
    selectedAppDir: null,
    promptDraft: "Create a private habit tracker.",
    createNameDraft: "",
    createAppIdDraft: "",
    createBundleIdDraft: "",
    savingAction: null,
    actionStartedAt: null,
    actionReceipt: null,
    appleFactsDraft: { ...DEFAULT_APP_STUDIO_APPLE_FACTS },
    buildEngineDraft: DEFAULT_APP_STUDIO_BUILD_ENGINE,
    screenImageDrafts: [],
    screenImageNotesDraft: "",
    screenAnalysisDraft: "",
    flowDraft: { ...DEFAULT_APP_STUDIO_FLOW_DRAFT },
    onRefresh: vi.fn(),
    onSelectProject: vi.fn(),
    onPromptDraftChange: vi.fn(),
    onCreateNameDraftChange: vi.fn(),
    onCreateAppIdDraftChange: vi.fn(),
    onCreateBundleIdDraftChange: vi.fn(),
    onCreateProject: vi.fn(),
    onApplyPrompt: vi.fn(),
    onBuildEngineChange: vi.fn(),
    onRunGate: vi.fn(),
    onMoveScreen: vi.fn(),
    onScreenOrderChange: vi.fn(),
    onScreenImageFilesChange: vi.fn(),
    onScreenImageNotesChange: vi.fn(),
    onImportScreenImages: vi.fn(),
    onScreenAnalysisDraftChange: vi.fn(),
    onApplyScreenAnalysis: vi.fn(),
    onFlowDraftChange: vi.fn(),
    onAddScreenFlowEdge: vi.fn(),
    onRemoveScreenFlowEdge: vi.fn(),
    onAppleFactChange: vi.fn(),
    onImportAppleFacts: vi.fn(),
    onApproveGate: vi.fn(),
    onDismissReceipt: vi.fn(),
    ...overrides,
  };
}

function renderStudio(props: AppStudioDashboardProps, container: HTMLElement) {
  render(renderAppStudioDashboard(props), container);
}

const snapshot: NonNullable<AppStudioDashboardProps["snapshot"]> = {
  schemaVersion: 1,
  checkedAt: "2026-05-24T12:00:00.000Z",
  defaultPrompt: "Create a private app.",
  nextAction: "Run App Studio build gates",
  buildEngineOptions: [
    {
      id: "local-qwen",
      label: "Local Qwen Q8",
      modelRef: "ollama/qwen3.6:27b-q8_0",
      detail: "Private local coding lane.",
      privacy: "local",
    },
    {
      id: "codex",
      label: "Codex GPT-5.5",
      modelRef: "openai/gpt-5.5",
      detail: "Codex coding lane.",
      privacy: "cloud",
    },
  ],
  stages: [
    { id: "idea", label: "Idea", detail: "Say what the app should do." },
    { id: "blueprint", label: "Blueprint", detail: "Review screens." },
    { id: "build", label: "Build", detail: "Validate locally." },
    { id: "preview", label: "Preview", detail: "Capture screenshots." },
    { id: "testflight", label: "TestFlight", detail: "Prepare upload." },
    { id: "app-store", label: "App Store", detail: "Submit." },
  ],
  gates: [
    { id: "model-check", label: "Check AI coder", detail: "Verify Qwen.", requiresApproval: false },
    {
      id: "builder-task",
      label: "Run AI build pass",
      detail: "Connect selected AI coder.",
      requiresApproval: false,
    },
    {
      id: "validate-structure",
      label: "Check project files",
      detail: "Validate.",
      requiresApproval: false,
    },
    {
      id: "repair",
      label: "Repair validation failure",
      detail: "Repair.",
      requiresApproval: false,
    },
    { id: "publish-plan", label: "Prepare publish plan", detail: "Plan.", requiresApproval: true },
    { id: "final-verify", label: "Run final verifier", detail: "Verify.", requiresApproval: false },
  ],
  projects: [
    {
      appId: "habit-forge",
      appName: "Habit Forge",
      appDir: "/tmp/generated-apps/habit-forge",
      bundleId: "com.mindfire.habitforge",
      updatedAt: "2026-05-24T12:00:00.000Z",
      stage: "build",
      completionGrade: 6,
      criticality: 9,
      nextAction: "Run Build and test",
      readyToBuild: false,
      readyForAppStore: false,
    },
  ],
  selectedProject: {
    appId: "habit-forge",
    appName: "Habit Forge",
    appDir: "/tmp/generated-apps/habit-forge",
    bundleId: "com.mindfire.habitforge",
    updatedAt: "2026-05-24T12:00:00.000Z",
    stage: "build",
    completionGrade: 6,
    criticality: 9,
    nextAction: "Run Build and test",
    readyToBuild: false,
    readyForAppStore: false,
    spec: {
      schemaVersion: 1,
      appId: "habit-forge",
      appName: "Habit Forge",
      moduleName: "HabitForge",
      bundleId: "com.mindfire.habitforge",
      originalRequest: "Create a private habit tracker.",
      goal: "Track habits privately.",
      audience: "iPhone users",
      appleCategory: "Productivity",
      screens: [
        { id: "home", title: "Home", purpose: "Show today's habits." },
        { id: "insights", title: "Insights", purpose: "Show weekly progress." },
      ],
      screenFlow: {
        entryScreenId: "home",
        edges: [
          {
            id: "home-to-insights",
            fromScreenId: "home",
            toScreenId: "insights",
            label: "Open Insights",
            trigger: "Tap “Open Insights”",
          },
        ],
      },
      dataModel: [{ name: "Habit", purpose: "Stored habit", fields: ["title", "streak"] }],
      acceptanceCriteria: ["Works offline"],
      unresolvedQuestions: [],
      privacyPosture: {
        collectsPersonalData: false,
        tracking: false,
        networkAccess: false,
        notes: ["Local only"],
      },
    },
    studio: {
      schemaVersion: 1,
      appId: "habit-forge",
      appDir: "/tmp/generated-apps/habit-forge",
      createdAt: "2026-05-24T12:00:00.000Z",
      updatedAt: "2026-05-24T12:00:00.000Z",
      buildEngine: "codex",
      promptHistory: [{ id: "p1", prompt: "Create", at: "2026-05-24", summary: "Create" }],
      visualInputs: [
        {
          id: "home-image",
          fileName: "home-screen.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          storedPath: "DesignInputs/screens/home-screen.png",
          importedAt: "2026-05-24T12:00:00.000Z",
          notes: "Home → Insights",
        },
      ],
      agentWorkboard: [
        {
          id: "app-builder",
          label: "App Builder",
          role: "Mutates SwiftUI code from prompts.",
          modelRef: "openai/gpt-5.5",
          status: "queued",
          currentTask: "Codex is queued to implement the next prompt.",
          inputs: ["product-spec.json"],
          outputs: ["SwiftUI source changes"],
          blockedOn: [],
          lastEvent: "Codex selected from the dashboard.",
          updatedAt: "2026-05-24T12:00:00.000Z",
        },
        {
          id: "local-validator",
          label: "Local Validator",
          role: "Runs validation gates.",
          modelRef: "xcodebuild/xcodegen/simctl",
          status: "idle",
          currentTask: "Waiting for a validation gate.",
          inputs: ["Project files"],
          outputs: ["ios-validation-report.json"],
          blockedOn: ["Run a validation gate"],
          lastEvent: "Validation lane initialized.",
          updatedAt: "2026-05-24T12:00:00.000Z",
        },
      ],
      approvals: [{ id: "testflight-upload", label: "Upload to TestFlight", status: "blocked" }],
      appleFacts: { appStoreConnectAppId: "", sku: "", teamId: "", apiKeyProfileRef: "" },
      xcodeHandoff: { recommended: false, reason: "Stay in App Studio." },
    },
    screens: [
      { id: "home", title: "Home", purpose: "Show today's habits." },
      { id: "insights", title: "Insights", purpose: "Show weekly progress." },
    ],
    screenFlow: {
      entryScreenId: "home",
      edges: [
        {
          id: "home-to-insights",
          fromScreenId: "home",
          toScreenId: "insights",
          label: "Open Insights",
          trigger: "Tap “Open Insights”",
        },
      ],
    },
    dataModel: [{ name: "Habit", purpose: "Stored habit", fields: ["title", "streak"] }],
    prompts: [{ id: "p1", prompt: "Create", at: "2026-05-24", summary: "Create" }],
    visualInputs: [
      {
        id: "home-image",
        fileName: "home-screen.png",
        mimeType: "image/png",
        sizeBytes: 2048,
        storedPath: "DesignInputs/screens/home-screen.png",
        importedAt: "2026-05-24T12:00:00.000Z",
        notes: "Home → Insights",
      },
    ],
    activity: [
      {
        at: "2026-05-24T12:00:00.000Z",
        stage: "create",
        result: "created",
        summary: "Generated native iOS SwiftUI scaffold.",
      },
    ],
    appStoreConnect: { sku: "habit-forge-ios" },
    metadata: { privacyUrl: "https://example.com/privacy" },
    latestReports: {
      validation: { readyForLocalBuild: true },
      model: null,
      aiBuild: null,
      patch: null,
      repair: null,
      publishPlan: null,
      finalVerifier: null,
    },
  },
};

describe("renderAppStudioDashboard", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders the prompt-first App Studio shell", () => {
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(baseProps(), container);

    expect(container.textContent).toContain("Prompt-first app builder");
    expect(container.textContent).toContain("Codex GPT-5.5");
    expect(container.textContent).toContain("Build new app");
    expect(container.textContent).toContain("No apps yet");
  });

  it("renders selected app metrics, gates, drag-order controls, and Apple facts", () => {
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(
      baseProps({ snapshot, selectedAppDir: "/tmp/generated-apps/habit-forge" }),
      container,
    );

    expect(container.textContent).toContain("Habit Forge");
    expect(container.textContent).toContain("Live updates");
    expect(container.textContent).toContain("What is happening right now");
    expect(container.textContent).toContain("Agent workboard");
    expect(container.textContent).toContain("App Builder");
    expect(container.textContent).toContain("openai/gpt-5.5");
    expect(container.textContent).toContain("Completion Grade");
    expect(container.textContent).toContain("Criticality");
    expect(container.textContent).toContain("Run Build and test");
    expect(container.textContent).toContain("Check AI coder");
    expect(container.textContent).toContain("Run AI build pass");
    expect(container.textContent).toContain("Run AI build");
    expect(container.textContent).toContain("Evidence proof");
    expect(container.textContent).toContain("Run AI build pass to generate evidence files.");
    expect(container.textContent).toContain("Generated native iOS SwiftUI scaffold.");
    expect(container.textContent).toContain("Repair validation failure");
    expect(container.textContent).toContain("Run final verifier");
    expect(container.textContent).toContain("Drag screens into the right order");
    expect(container.textContent).toContain("Optional pictures");
    expect(container.textContent).toContain("Imported pictures");
    expect(container.textContent).toContain("home-screen.png");
    expect(container.textContent).toContain("Apply AI picture analysis");
    expect(container.textContent).toContain("Screen connection map");
    expect(container.textContent).toContain("Home");
    expect(container.textContent).toContain("Insights");
    expect(container.textContent).toContain("Tap “Open Insights”");
    expect(container.textContent).toContain("App Store Connect app ID");
    expect(container.textContent).toContain("Final actions stay owner-controlled");
  });

  it("wires prompt and gate actions", () => {
    const onPromptDraftChange = vi.fn();
    const onRunGate = vi.fn();
    const onBuildEngineChange = vi.fn();
    const onScreenImageNotesChange = vi.fn();
    const onImportScreenImages = vi.fn();
    const onScreenAnalysisDraftChange = vi.fn();
    const onApplyScreenAnalysis = vi.fn();
    const onFlowDraftChange = vi.fn();
    const onAddScreenFlowEdge = vi.fn();
    const onRemoveScreenFlowEdge = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(
      baseProps({
        snapshot,
        selectedAppDir: "/tmp/generated-apps/habit-forge",
        onPromptDraftChange,
        onRunGate,
        onBuildEngineChange,
        onScreenImageNotesChange,
        onImportScreenImages,
        onScreenAnalysisDraftChange,
        onApplyScreenAnalysis,
        onFlowDraftChange,
        onAddScreenFlowEdge,
        onRemoveScreenFlowEdge,
        screenImageDrafts: [
          {
            fileName: "settings-wireframe.png",
            mimeType: "image/png",
            sizeBytes: 1536,
            dataUrl: "data:image/png;base64,cHJldmlldw==",
          },
        ],
      }),
      container,
    );

    expect(container.querySelector<HTMLImageElement>(".app-studio-visual-preview img")?.alt).toBe(
      "settings-wireframe.png preview",
    );

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    textarea!.value = "Add reminders.";
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPromptDraftChange).toHaveBeenCalledWith("Add reminders.");

    const gateButton = container.querySelector<HTMLButtonElement>(".app-studio-gate-card button");
    expect(gateButton).not.toBeUndefined();
    gateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRunGate).toHaveBeenCalled();

    const codexRadio = Array.from(
      container.querySelectorAll<HTMLInputElement>(".app-studio-engine-option input"),
    ).find((input) => input.parentElement?.textContent?.includes("Codex"));
    expect(codexRadio).not.toBeUndefined();
    codexRadio!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onBuildEngineChange).toHaveBeenCalledWith("codex");

    const visualNotes = container.querySelector<HTMLTextAreaElement>(".app-studio-visual-notes");
    expect(visualNotes).not.toBeNull();
    visualNotes!.value = "Home → Insights";
    visualNotes!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onScreenImageNotesChange).toHaveBeenCalledWith("Home → Insights");

    const importButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Import pictures"),
    );
    expect(importButton).not.toBeUndefined();
    importButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onImportScreenImages).toHaveBeenCalled();

    const analysisJson = container.querySelector<HTMLTextAreaElement>(".app-studio-analysis-json");
    expect(analysisJson).not.toBeNull();
    analysisJson!.value = '{"screens":[{"title":"Settings"}],"connections":[]}';
    analysisJson!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onScreenAnalysisDraftChange).toHaveBeenCalledWith(
      '{"screens":[{"title":"Settings"}],"connections":[]}',
    );

    const applyAnalysis = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Apply analysis"),
    );
    expect(applyAnalysis).not.toBeUndefined();
    applyAnalysis!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onApplyScreenAnalysis).toHaveBeenCalled();

    const flowLabel = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
      (input) => input.placeholder === "Open Settings",
    );
    expect(flowLabel).not.toBeUndefined();
    flowLabel!.value = "Open Insights";
    flowLabel!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFlowDraftChange).toHaveBeenCalledWith("label", "Open Insights");

    const addLink = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Add link"),
    );
    expect(addLink).not.toBeUndefined();
    addLink!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAddScreenFlowEdge).toHaveBeenCalled();

    const removeLink = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeLink).not.toBeUndefined();
    removeLink!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRemoveScreenFlowEdge).toHaveBeenCalledWith("home-to-insights");
  });

  it("supports idea-stage progression and next-move guidance", () => {
    const onApplyPrompt = vi.fn();
    const onRunGate = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(
      baseProps({
        snapshot: {
          ...snapshot,
          selectedProject: {
            ...snapshot.selectedProject!,
            stage: "idea",
          },
        },
        selectedAppDir: "/tmp/generated-apps/habit-forge",
        onApplyPrompt,
        onRunGate,
      }),
      container,
    );

    const ideaButton = container.querySelector<HTMLButtonElement>(
      ".app-studio-stage-rail .app-studio-stage__action",
    );
    expect(ideaButton).not.toBeNull();
    expect(ideaButton?.textContent).toContain("Apply your prompt");
    ideaButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onApplyPrompt).toHaveBeenCalled();

    const nextMoveButton = container.querySelector<HTMLButtonElement>(
      ".app-studio-hero__next button",
    );
    expect(nextMoveButton).not.toBeNull();
    nextMoveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onRunGate).toHaveBeenCalled();
  });
});
