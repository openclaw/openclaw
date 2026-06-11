import { html, nothing, type TemplateResult } from "lit";
import "../../styles/app-studio.css";
import type {
  AppStudioActionReceipt,
  AppStudioAppleFactsDraft,
  AppStudioBuildEngine,
  AppStudioDashboardSnapshot,
  AppStudioFlowDraft,
  AppStudioGateId,
  AppStudioProjectSummary,
  AppStudioScreen,
  AppStudioScreenImageDraft,
  AppStudioSelectedProject,
  AppStudioStageId,
} from "../controllers/app-studio-dashboard.ts";
import { icons } from "../icons.ts";

export type AppStudioDashboardProps = {
  loading: boolean;
  error: string | null;
  snapshot: AppStudioDashboardSnapshot | null;
  lastFetchAt: number | null;
  selectedAppDir: string | null;
  promptDraft: string;
  createNameDraft: string;
  createAppIdDraft: string;
  createBundleIdDraft: string;
  savingAction: string | null;
  actionStartedAt: number | null;
  actionReceipt: AppStudioActionReceipt | null;
  appleFactsDraft: AppStudioAppleFactsDraft;
  buildEngineDraft: AppStudioBuildEngine;
  screenImageDrafts: AppStudioScreenImageDraft[];
  screenImageNotesDraft: string;
  screenAnalysisDraft: string;
  flowDraft: AppStudioFlowDraft;
  onRefresh: () => void;
  onSelectProject: (appDir: string) => void;
  onPromptDraftChange: (value: string) => void;
  onCreateNameDraftChange: (value: string) => void;
  onCreateAppIdDraftChange: (value: string) => void;
  onCreateBundleIdDraftChange: (value: string) => void;
  onCreateProject: () => void;
  onApplyPrompt: () => void;
  onBuildEngineChange: (buildEngine: AppStudioBuildEngine) => void;
  onRunGate: (gate: AppStudioGateId) => void;
  onMoveScreen: (screenId: string, direction: "up" | "down") => void;
  onScreenOrderChange: (screenIds: string[]) => void;
  onScreenImageFilesChange: (files: FileList | null) => void;
  onScreenImageNotesChange: (value: string) => void;
  onImportScreenImages: () => void;
  onScreenAnalysisDraftChange: (value: string) => void;
  onApplyScreenAnalysis: () => void;
  onFlowDraftChange: (field: keyof AppStudioFlowDraft, value: string) => void;
  onAddScreenFlowEdge: () => void;
  onRemoveScreenFlowEdge: (edgeId: string) => void;
  onAppleFactChange: (field: keyof AppStudioAppleFactsDraft, value: string) => void;
  onImportAppleFacts: () => void;
  onApproveGate: (approvalId: string) => void;
  onDismissReceipt: () => void;
};

const STAGE_ORDER = ["idea", "blueprint", "build", "preview", "testflight", "app-store"];
type AppStudioStageAction = {
  gate: AppStudioGateId | null;
  action: "runGate" | "applyPrompt";
  label: string;
  busyLabel: string;
};
const STAGE_ACTIONS: Record<AppStudioStageId, AppStudioStageAction> = {
  idea: {
    gate: null,
    action: "applyPrompt",
    label: "Apply your prompt",
    busyLabel: "Applying prompt…",
  },
  blueprint: {
    gate: "model-check",
    action: "runGate",
    label: "Check AI coder",
    busyLabel: "Checking…",
  },
  build: {
    gate: "builder-task",
    action: "runGate",
    label: "Run AI build",
    busyLabel: "Building…",
  },
  preview: {
    gate: "screenshots",
    action: "runGate",
    label: "Capture preview",
    busyLabel: "Capturing…",
  },
  testflight: {
    gate: "publish-plan",
    action: "runGate",
    label: "Prepare TestFlight",
    busyLabel: "Preparing…",
  },
  "app-store": {
    gate: "app-store-ready",
    action: "runGate",
    label: "Check App Store",
    busyLabel: "Checking…",
  },
};

type AppStudioGateTone = "running" | "queued" | "blocked" | "idle" | "done";

type AppStudioGateUiState = {
  statusLabel: string;
  statusTone: AppStudioGateTone;
  actionLabel: string;
  disabled: boolean;
  disabledReason: string | null;
  recommended: boolean;
  detail: string | null;
  detailTone: AppStudioGateTone;
  isBusy: boolean;
  isQueued: boolean;
};

const GATE_WORKFLOW: Partial<Record<AppStudioGateId, readonly string[]>> = {
  "model-check": ["local-validator", "app-store-verifier", "app-builder"],
  implement: ["app-builder"],
  "builder-task": ["app-builder"],
  "validate-structure": ["local-validator"],
  "validate-build": ["local-validator"],
  repair: ["local-validator"],
  screenshots: ["local-validator"],
  "app-store-ready": ["app-store-verifier"],
  "publish-plan": ["app-store-verifier"],
  "final-verify": ["app-store-verifier"],
  ready: ["app-store-verifier"],
};

const GATE_PREFERRED: Array<{ gate: AppStudioGateId; stageId: AppStudioStageId }> = [
  { gate: "model-check", stageId: "blueprint" },
  { gate: "builder-task", stageId: "build" },
  { gate: "validate-structure", stageId: "build" },
  { gate: "validate-build", stageId: "build" },
  { gate: "repair", stageId: "build" },
  { gate: "implement", stageId: "build" },
  { gate: "screenshots", stageId: "preview" },
  { gate: "publish-plan", stageId: "testflight" },
  { gate: "app-store-ready", stageId: "app-store" },
  { gate: "final-verify", stageId: "app-store" },
  { gate: "ready", stageId: "app-store" },
];

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") {
    return null;
  }
  return value;
}

function gateStage(gate: AppStudioGateId): AppStudioStageId | null {
  for (const entry of GATE_PREFERRED) {
    if (entry.gate === gate) {
      return entry.stageId;
    }
  }
  return null;
}

function gateActionLabel(gate: AppStudioGateId): { label: string; busyLabel: string } {
  const action = Object.entries(STAGE_ACTIONS).find((entry) => entry[1].gate === gate)?.[1];
  return {
    label: action?.label ?? "Run",
    busyLabel: action?.busyLabel ?? "Running…",
  };
}

function stageActionBusy(action: AppStudioStageAction, savingAction: string | null): boolean {
  if (action.action === "applyPrompt") {
    return savingAction === "prompt";
  }
  return action.gate !== null && savingAction === `gate:${action.gate}`;
}

function stageActionLabel(action: AppStudioStageAction, savingAction: string | null): string {
  return stageActionBusy(action, savingAction) ? action.busyLabel : action.label;
}

function stageActionDisabled(
  action: AppStudioStageAction,
  selected: AppStudioSelectedProject | null,
  isWorking: boolean,
  savingAction: string | null,
): string | null {
  if (!selected) {
    return "Select an app to continue.";
  }
  if (isWorking) {
    return "Wait until current work finishes to avoid conflicts.";
  }
  if (savingAction) {
    return "Please wait for the current action to finish.";
  }
  if (
    action.action === "applyPrompt" &&
    !(selected.prompts?.length ?? selected.studio.promptHistory.length) &&
    !selected.spec?.originalRequest
  ) {
    return "Add a prompt in the prompt box first.";
  }
  return null;
}

function resolveGateLabel(snapshot: AppStudioDashboardSnapshot, gateId: AppStudioGateId): string {
  return snapshot.gates.find((gate) => gate.id === gateId)?.label ?? gateId;
}

function nextRecommendedGate(
  snapshot: AppStudioDashboardSnapshot,
  selected: AppStudioSelectedProject | null,
  props: AppStudioDashboardProps,
): { gate: AppStudioGateId; state: AppStudioGateUiState } | null {
  if (!selected) {
    return null;
  }
  const selectedStageIndex = STAGE_ORDER.indexOf(selected.stage);
  if (props.savingAction) {
    return null;
  }
  if (selected.studio.agentWorkboard.some((agent) => agent.status === "running")) {
    return null;
  }
  for (const gate of snapshot.gates) {
    const stageId = gateStage(gate.id);
    const gateStageIndex = stageId ? STAGE_ORDER.indexOf(stageId) : -1;
    if (
      stageId !== null &&
      selectedStageIndex >= 0 &&
      gateStageIndex >= 0 &&
      gateStageIndex < selectedStageIndex
    ) {
      continue;
    }
    const state = deriveGateUiState(selected, gate.id, props);
    if (state.statusTone === "running" || state.statusTone === "queued") {
      return { gate: gate.id, state };
    }
    if (state.statusTone === "idle" && gate.id === "model-check" && selected.stage === "idea") {
      return { gate: gate.id, state };
    }
    if (state.recommended || state.statusTone === "blocked") {
      return { gate: gate.id, state };
    }
    if (state.statusTone === "idle") {
      return { gate: gate.id, state };
    }
  }
  return null;
}

function runStageAction(action: AppStudioStageAction, props: AppStudioDashboardProps) {
  if (action.gate) {
    props.onRunGate(action.gate);
    return;
  }
  if (action.action === "applyPrompt") {
    props.onApplyPrompt();
  }
}

function getGateReport(
  selected: AppStudioSelectedProject | null,
  gate: AppStudioGateId,
): Record<string, unknown> | null {
  if (!selected) {
    return null;
  }
  const key = reportKeyForGate(gate);
  if (!key) {
    return null;
  }
  return asRecord(selected.latestReports[key]) ?? null;
}

function gateReadyFromReport(
  gate: AppStudioGateId,
  selected: AppStudioSelectedProject | null,
): boolean | null {
  const report = getGateReport(selected, gate);
  if (!report) {
    if (gate === "builder-task") {
      const patchReport = asRecord(selected?.latestReports.patch);
      const aiReport = asRecord(selected?.latestReports.aiBuild);
      const patchReady = coerceBoolean(patchReport?.ready);
      return patchReady ?? coerceBoolean(aiReport?.ready);
    }
    return null;
  }
  switch (gate) {
    case "model-check":
    case "implement":
    case "repair":
    case "screenshots":
    case "builder-task":
      return coerceBoolean(report.ready);
    case "validate-structure":
    case "validate-build":
      return coerceBoolean(report.readyForLocalBuild) ?? coerceBoolean(report.ready);
    case "app-store-ready":
      return (
        coerceBoolean(report.readyForAppReviewSubmission) ??
        coerceBoolean(report.readyForAppReview) ??
        coerceBoolean(report.ready)
      );
    case "publish-plan":
      return coerceBoolean(report.actionable) ?? coerceBoolean(report.ready);
    case "final-verify":
      return coerceBoolean(report.readyForAppReview) ?? coerceBoolean(report.ready);
    case "ready":
      return coerceBoolean(report.readyForAppStore) ?? coerceBoolean(report.ready);
    default:
      return coerceBoolean(report.ready);
  }
}

function gateBlockersFromReport(
  gate: AppStudioGateId,
  selected: AppStudioSelectedProject | null,
): string[] {
  const report = getGateReport(selected, gate);
  if (!report) {
    return [];
  }
  const blockedOn = stringArrayValue(report.blockedOn);
  if (blockedOn.length > 0) {
    return blockedOn;
  }
  if (gate === "publish-plan") {
    return stringArrayValue(report.blockedGates);
  }
  if (gate === "final-verify") {
    return stringArrayValue(report.blockedGates);
  }
  if (gate === "ready") {
    const gap = stringValue(report.nextMostImpactfulGap);
    return gap ? [gap] : [];
  }
  return stringArrayValue(report.nextActions);
}

function gateErrorFromReport(
  gate: AppStudioGateId,
  selected: AppStudioSelectedProject | null,
): string {
  const report = getGateReport(selected, gate);
  if (!report) {
    return "";
  }
  if (gate === "model-check") {
    return stringValue(report.error) || "Review model-readiness output for details.";
  }
  if (gate === "builder-task") {
    return stringValue(report.error);
  }
  return stringValue(report.error) || stringValue((report as { summary?: unknown }).summary);
}

function gateActionBusy(savingAction: string | null, gate: AppStudioGateId): boolean {
  return savingAction === `gate:${gate}`;
}

function workboardAgentForGate(
  board: AppStudioSelectedProject["studio"]["agentWorkboard"],
  gate: AppStudioGateId,
) {
  const agentId =
    gate === "builder-task" || gate === "model-check" || gate === "implement" || gate === "repair"
      ? "app-builder"
      : gate === "validate-structure" || gate === "validate-build" || gate === "screenshots"
        ? "local-validator"
        : "app-store-verifier";
  return board.find((agent) => agent.id === agentId);
}

function deriveGateUiState(
  selected: AppStudioSelectedProject | null,
  gate: AppStudioGateId,
  props: AppStudioDashboardProps,
): AppStudioGateUiState {
  const action = gateActionLabel(gate);
  const isBusy = gateActionBusy(props.savingAction, gate);
  const busySince = props.actionStartedAt;
  const agent = selected ? workboardAgentForGate(selected.studio.agentWorkboard, gate) : null;
  const reportReady = gateReadyFromReport(gate, selected);
  const blockers = gateBlockersFromReport(gate, selected);
  const running = agent?.status === "running" || isBusy;
  const queued = agent?.status === "queued";
  const statusTone =
    running || isBusy
      ? "running"
      : queued
        ? "queued"
        : reportReady === true
          ? "done"
          : blockers.length > 0 || agent?.status === "blocked"
            ? "blocked"
            : isBusy
              ? "running"
              : "idle";
  const detail =
    isBusy || running
      ? `Live task: ${agent?.currentTask || action.busyLabel} · ${busySince ? fmtDurationMs(Date.now() - busySince) : "starting"}`
      : reportReady === true
        ? "Done for current snapshot."
        : blockers.length > 0
          ? blockers.join(" · ")
          : agent?.currentTask && agent.currentTask.length > 0
            ? agent.currentTask
            : "Awaiting your action.";
  const blockedError = gateErrorFromReport(gate, selected);
  const isQueued = !running && queued;
  const disabled = !selected || Boolean(props.savingAction);
  const stage = gateStage(gate);
  const recommended = Boolean(
    selected &&
    stage &&
    selected.stage === stage &&
    statusTone !== "done" &&
    statusTone !== "running",
  );
  const statusLabel =
    statusTone === "running"
      ? action.busyLabel
      : statusTone === "queued"
        ? "Queued"
        : statusTone === "done"
          ? "Done"
          : statusTone === "blocked"
            ? "Blocked"
            : "Ready";
  const disabledReason =
    statusTone === "blocked" && blockedError
      ? blockedError
      : statusTone === "blocked" && blockers.length > 0
        ? `Blocked: ${blockers.join(" · ")}`
        : null;
  return {
    statusLabel,
    statusTone,
    actionLabel: isBusy ? action.busyLabel : action.label,
    disabled,
    disabledReason,
    recommended,
    detail,
    detailTone:
      statusTone === "blocked"
        ? "blocked"
        : statusTone === "done"
          ? "done"
          : statusTone === "running" || statusTone === "queued"
            ? "running"
            : "idle",
    isBusy,
    isQueued,
  };
}

let draggedScreenId: string | null = null;

function fmtTime(ts: number | null): string {
  if (!ts) {
    return "Not loaded yet";
  }
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtDurationMs(ms: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  return `${seconds}s`;
}

function fmtAgo(ts: number | null): string {
  if (!ts) {
    return "Unknown";
  }
  const elapsed = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}

function fmtIsoTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-3).join("/") || path;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function reportKeyForGate(gate: AppStudioGateId): string | null {
  switch (gate) {
    case "model-check":
      return "model";
    case "validate-structure":
    case "validate-build":
      return "validation";
    case "implement":
      return "implementation";
    case "repair":
      return "repair";
    case "screenshots":
      return "screenshot";
    case "app-store-ready":
      return "appStore";
    case "publish-plan":
      return "publishPlan";
    case "final-verify":
      return "finalVerifier";
    case "ready":
      return "readiness";
    case "builder-task":
      return "aiBuild";
  }
  return null;
}

function actionLabel(action: string | null): string {
  if (!action) {
    return "";
  }
  if (action.startsWith("gate:")) {
    const gate = action.slice("gate:".length);
    const stage = Object.values(STAGE_ACTIONS).find((candidate) => candidate.gate === gate);
    return stage?.busyLabel || "Running gate…";
  }
  switch (action) {
    case "create":
      return "Creating app scaffold…";
    case "prompt":
      return "Applying prompt and updating blueprint…";
    case "build-engine":
      return "Switching AI coder…";
    case "reorder":
      return "Reordering screens…";
    case "screen-images":
      return "Importing screen pictures…";
    case "screen-analysis":
      return "Applying picture analysis…";
    case "screen-flow":
      return "Saving screen connection map…";
    case "apple-facts":
      return "Saving Apple setup references…";
    default:
      return action.startsWith("approval:") ? "Saving approval…" : "Working…";
  }
}

function stageIndex(stage: string | undefined): number {
  const index = STAGE_ORDER.indexOf(stage ?? "idea");
  return Math.max(index, 0);
}

function stageAgentForStage(
  selected: AppStudioSelectedProject | null,
  stageId: AppStudioStageId,
): { role: string; agent: AppStudioSelectedProject["studio"]["agentWorkboard"][number] } | null {
  const board = selected?.studio.agentWorkboard ?? [];
  const stageToAgent = (() => {
    switch (stageId) {
      case "blueprint":
      case "build":
        return ["app-builder", "App Builder"];
      case "preview":
        return ["local-validator", "Local Validator"];
      case "testflight":
      case "app-store":
        return ["app-store-verifier", "App Store Verifier"];
      default:
        return null;
    }
  })();
  if (!stageToAgent) {
    return null;
  }
  const agentId = stageToAgent[0];
  const agent = board.find((entry) => entry.id === agentId);
  return agent ? { role: stageToAgent[1], agent } : null;
}

function stageWorkBadge(
  agentInfo: {
    role: string;
    agent: AppStudioSelectedProject["studio"]["agentWorkboard"][number];
  } | null,
): { label: string; tone: "running" | "queued" | "blocked" | "idle"; detail?: string } {
  if (!agentInfo) {
    return { label: "Waiting", tone: "idle" as const };
  }
  const { agent } = agentInfo;
  if (agent.status === "running") {
    return { label: `Running: ${agent.currentTask}`, tone: "running" as const };
  }
  if (agent.status === "queued") {
    return { label: `Queued: ${agent.currentTask}`, tone: "queued" as const };
  }
  if (agent.status === "blocked") {
    const blockers = agent.blockedOn.length ? `Blocked: ${agent.blockedOn.join(" · ")}` : "Blocked";
    return { label: `${agent.role} blocked`, tone: "blocked" as const, detail: blockers };
  }
  return {
    label: `${agent.currentTask} · ${agent.lastEvent}`.trim() || "Waiting",
    tone: "idle" as const,
  };
}

function renderMetric(label: string, value: string | number, detail: string, tone = "neutral") {
  return html`
    <div class="app-studio-metric app-studio-metric--${tone}">
      <span>${label}</span>
      <b>${value}</b>
      <small>${detail}</small>
    </div>
  `;
}

function renderBuildEnginePicker(
  props: AppStudioDashboardProps,
  snapshot: AppStudioDashboardSnapshot | null,
) {
  const options =
    snapshot?.buildEngineOptions && snapshot.buildEngineOptions.length > 0
      ? snapshot.buildEngineOptions
      : [
          {
            id: "local-qwen" as const,
            label: "Local Qwen Q8",
            modelRef: "ollama/qwen3.6:27b-q8_0",
            detail: "Private local coding lane on the Mac Studio.",
            privacy: "local" as const,
          },
          {
            id: "codex" as const,
            label: "Codex GPT-5.5",
            modelRef: "openai/gpt-5.5",
            detail: "Codex coding lane for stronger SwiftUI implementation passes.",
            privacy: "cloud" as const,
          },
        ];
  return html`
    <div class="app-studio-engine-picker" aria-label="Build engine">
      <div class="app-studio-engine-picker__head">
        <span class="app-studio-eyebrow">Build engine</span>
        <small
          >${props.buildEngineDraft === "codex" ? "Codex selected" : "Local Qwen selected"}</small
        >
      </div>
      <div class="app-studio-engine-options">
        ${options.map(
          (option) => html`
            <label
              class="app-studio-engine-option ${props.buildEngineDraft === option.id
                ? "app-studio-engine-option--active"
                : ""}"
            >
              <input
                type="radio"
                name="app-studio-build-engine"
                .checked=${props.buildEngineDraft === option.id}
                ?disabled=${props.savingAction === "build-engine"}
                @change=${() => props.onBuildEngineChange(option.id)}
              />
              <span>
                <b>${option.label}</b>
                <small>${option.modelRef} · ${option.privacy}</small>
                <em>${option.detail}</em>
              </span>
            </label>
          `,
        )}
      </div>
    </div>
  `;
}

function renderPendingScreenImagePreviews(images: AppStudioScreenImageDraft[]) {
  if (images.length === 0) {
    return nothing;
  }
  return html`
    <div class="app-studio-visual-preview-grid" aria-label="Selected screen pictures">
      ${images.map(
        (image) => html`
          <figure class="app-studio-visual-preview">
            <img src=${image.dataUrl} alt=${`${image.fileName} preview`} />
            <figcaption>
              <b>${image.fileName}</b>
              <small>${formatFileSize(image.sizeBytes)}</small>
            </figcaption>
          </figure>
        `,
      )}
    </div>
  `;
}

function renderImportedVisualInputs(selected: AppStudioSelectedProject | null) {
  const inputs = selected?.visualInputs ?? [];
  if (inputs.length === 0) {
    return nothing;
  }
  return html`
    <div class="app-studio-visual-imported" aria-label="Imported screen picture references">
      <b>Imported pictures</b>
      ${inputs.slice(-4).map(
        (input) => html`
          <span>
            ${input.fileName}
            <small>${formatFileSize(input.sizeBytes)} · ${input.storedPath}</small>
          </span>
        `,
      )}
    </div>
  `;
}

function renderScreenAnalysisApply(props: AppStudioDashboardProps, hasProject: boolean) {
  return html`
    <details class="app-studio-analysis-box">
      <summary>
        <span>
          <b>Apply AI picture analysis</b>
          <small>Optional advanced step for pixel-level screen mapping.</small>
        </span>
      </summary>
      <p>
        Paste the JSON from the Visual Mapper task. App Studio will merge screens, questions, and
        tap links into the blueprint.
      </p>
      <textarea
        class="app-studio-analysis-json"
        .value=${props.screenAnalysisDraft}
        placeholder='{"screens":[{"title":"Home","purpose":"Show the main dashboard"}],"connections":[{"fromTitle":"Home","toTitle":"Settings","label":"Open Settings","trigger":"Tap the Settings button"}],"questions":[]}'
        @input=${(event: Event) =>
          props.onScreenAnalysisDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
      <button
        class="btn btn--subtle"
        type="button"
        ?disabled=${!hasProject || Boolean(props.savingAction)}
        @click=${props.onApplyScreenAnalysis}
      >
        ${props.savingAction === "screen-analysis" ? "Applying…" : "Apply analysis to screens"}
      </button>
    </details>
  `;
}

function renderScreenImageImport(
  props: AppStudioDashboardProps,
  hasProject: boolean,
  selected: AppStudioSelectedProject | null,
) {
  return html`
    <div class="app-studio-visual-import">
      <div>
        <span class="app-studio-eyebrow">Optional pictures</span>
        <b>Upload screen sketches</b>
        <p>
          Add screenshots, sketches, or wireframes. App Studio stores them with the app and turns
          names or notes like “Home → Settings” into screens and links.
        </p>
      </div>
      <label class="app-studio-file-drop">
        <input
          type="file"
          accept="image/*"
          multiple
          @change=${(event: Event) =>
            props.onScreenImageFilesChange((event.currentTarget as HTMLInputElement).files)}
        />
        <span>${icons.spark}</span>
        <b
          >${props.screenImageDrafts.length || "Drop or choose"}
          image${props.screenImageDrafts.length === 1 ? "" : "s"}</b
        >
        <small>
          ${props.screenImageDrafts.length > 0
            ? props.screenImageDrafts.map((image) => image.fileName).join(" · ")
            : "PNG or JPG; optional"}
        </small>
      </label>
      ${renderPendingScreenImagePreviews(props.screenImageDrafts)}
      <textarea
        class="app-studio-visual-notes"
        .value=${props.screenImageNotesDraft}
        placeholder="Optional: Home → Settings, Home → Weekly Report, Settings → Home"
        @input=${(event: Event) =>
          props.onScreenImageNotesChange((event.currentTarget as HTMLTextAreaElement).value)}
      ></textarea>
      <button
        class="btn btn--subtle"
        type="button"
        ?disabled=${!hasProject || Boolean(props.savingAction)}
        @click=${props.onImportScreenImages}
      >
        ${props.savingAction === "screen-images" ? "Importing…" : "Import pictures to flow"}
      </button>
      ${renderImportedVisualInputs(selected)} ${renderScreenAnalysisApply(props, hasProject)}
    </div>
  `;
}

function renderProjectList(props: AppStudioDashboardProps, projects: AppStudioProjectSummary[]) {
  if (projects.length === 0) {
    return html`
      <div class="app-studio-empty-card">
        <span class="app-studio-empty-card__icon">${icons.spark}</span>
        <b>No apps yet</b>
        <p>
          Describe your first app. App Studio will create the SwiftUI scaffold and readiness files.
        </p>
      </div>
    `;
  }
  return html`
    <div class="app-studio-project-list" aria-label="App projects">
      ${projects.map(
        (project) => html`
          <button
            class="app-studio-project-card ${project.appDir === props.selectedAppDir
              ? "app-studio-project-card--active"
              : ""}"
            type="button"
            @click=${() => props.onSelectProject(project.appDir)}
          >
            <span class="app-studio-project-card__topline">
              <b>${project.appName}</b>
              <span>${project.completionGrade}/10</span>
            </span>
            <span>${project.bundleId}</span>
            <small>${project.nextAction}</small>
          </button>
        `,
      )}
    </div>
  `;
}

function renderStageRail(
  snapshot: AppStudioDashboardSnapshot,
  selected: AppStudioSelectedProject | null,
  props: AppStudioDashboardProps,
) {
  const current = stageIndex(selected?.stage);
  const isWorking = Boolean(
    selected?.studio.agentWorkboard.some((agent) => agent.status === "running"),
  );
  return html`
    <div class="app-studio-stage-rail" aria-label="App build stages">
      ${snapshot.stages.map((stage, index) => {
        const state = index < current ? "done" : index === current ? "active" : "next";
        const action = STAGE_ACTIONS[stage.id];
        const stageAgent = stageAgentForStage(selected, stage.id);
        const badge = stageWorkBadge(stageAgent);
        const stageBusy = stageActionBusy(action, props.savingAction);
        const gateUiState = action.gate ? deriveGateUiState(selected, action.gate, props) : null;
        const tone = gateUiState?.statusTone ?? badge.tone;
        const stageActionDisableReason = stageActionDisabled(
          action,
          selected,
          isWorking,
          props.savingAction,
        );
        return html`
          <div
            class="app-studio-stage app-studio-stage--${state} app-studio-stage--${tone}"
            aria-busy=${isWorking || stageBusy ? "true" : "false"}
          >
            <span>${index + 1}</span>
            <b>${stage.label}</b>
            <small>${stage.detail}</small>
            <span class="app-studio-stage__status app-studio-stage__status--${tone}">
              ${badge.tone === "running" ? html`${icons.loader} ${badge.label}` : badge.label}
            </span>
            ${gateUiState?.detail
              ? html`<small class="app-studio-stage__detail">${gateUiState.detail}</small>`
              : nothing}
            ${badge.tone === "blocked"
              ? html`<small>${badge.detail ?? "Blocked in this stage."}</small>`
              : nothing}
            <button
              class="app-studio-stage__action"
              type="button"
              ?disabled=${Boolean(stageActionDisableReason)}
              title=${stageActionDisableReason ?? ""}
              @click=${() => runStageAction(action, props)}
            >
              ${stageActionLabel(action, props.savingAction)}
            </button>
          </div>
        `;
      })}
    </div>
  `;
}

function renderScreenCard(
  screen: AppStudioScreen,
  index: number,
  screens: AppStudioScreen[],
  props: AppStudioDashboardProps,
) {
  return html`
    <article
      class="app-studio-screen-card"
      draggable="true"
      @dragstart=${(event: DragEvent) => {
        draggedScreenId = screen.id;
        event.dataTransfer?.setData("text/plain", screen.id);
      }}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        const sourceId = event.dataTransfer?.getData("text/plain") || draggedScreenId;
        draggedScreenId = null;
        if (!sourceId || sourceId === screen.id) {
          return;
        }
        const ids = screens.map((item) => item.id);
        const from = ids.indexOf(sourceId);
        const to = ids.indexOf(screen.id);
        if (from < 0 || to < 0) {
          return;
        }
        const next = [...ids];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        props.onScreenOrderChange(next);
      }}
    >
      <div class="app-studio-screen-card__handle" aria-hidden="true">${icons.arrowUpDown}</div>
      <div>
        <b>${screen.title}</b>
        <p>${screen.purpose}</p>
      </div>
      <div class="app-studio-screen-card__actions">
        <button
          class="btn btn--subtle btn--sm"
          type="button"
          ?disabled=${index === 0 || props.savingAction === "reorder"}
          @click=${() => props.onMoveScreen(screen.id, "up")}
        >
          Up
        </button>
        <button
          class="btn btn--subtle btn--sm"
          type="button"
          ?disabled=${index === screens.length - 1 || props.savingAction === "reorder"}
          @click=${() => props.onMoveScreen(screen.id, "down")}
        >
          Down
        </button>
      </div>
    </article>
  `;
}

function screenTitleById(selected: AppStudioSelectedProject, screenId: string): string {
  return selected.screens.find((screen) => screen.id === screenId)?.title ?? screenId;
}

function renderScreenFlowMap(selected: AppStudioSelectedProject, props: AppStudioDashboardProps) {
  const edges = selected.screenFlow.edges;
  const canConnect = selected.screens.length > 1;
  return html`
    <div class="app-studio-flow-map" aria-label="Screen connection map">
      <div class="app-studio-flow-map__head">
        <h3>Screen connection map</h3>
        <small>Entry: ${screenTitleById(selected, selected.screenFlow.entryScreenId)}</small>
      </div>
      <div class="app-studio-flow-editor" aria-label="Add screen connection">
        <label>
          <span>From</span>
          <select
            .value=${props.flowDraft.fromScreenId || selected.screens[0]?.id || ""}
            ?disabled=${!canConnect || Boolean(props.savingAction)}
            @change=${(event: Event) =>
              props.onFlowDraftChange(
                "fromScreenId",
                (event.currentTarget as HTMLSelectElement).value,
              )}
          >
            ${selected.screens.map(
              (screen) => html`<option value=${screen.id}>${screen.title}</option>`,
            )}
          </select>
        </label>
        <label>
          <span>To</span>
          <select
            .value=${props.flowDraft.toScreenId || selected.screens[1]?.id || ""}
            ?disabled=${!canConnect || Boolean(props.savingAction)}
            @change=${(event: Event) =>
              props.onFlowDraftChange(
                "toScreenId",
                (event.currentTarget as HTMLSelectElement).value,
              )}
          >
            ${selected.screens.map(
              (screen) => html`<option value=${screen.id}>${screen.title}</option>`,
            )}
          </select>
        </label>
        <label>
          <span>Button label</span>
          <input
            .value=${props.flowDraft.label}
            placeholder="Open Settings"
            ?disabled=${!canConnect || Boolean(props.savingAction)}
            @input=${(event: Event) =>
              props.onFlowDraftChange("label", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label>
          <span>Trigger</span>
          <input
            .value=${props.flowDraft.trigger}
            placeholder="Tap the Settings button"
            ?disabled=${!canConnect || Boolean(props.savingAction)}
            @input=${(event: Event) =>
              props.onFlowDraftChange("trigger", (event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <button
          class="btn btn--primary btn--sm"
          type="button"
          ?disabled=${!canConnect || Boolean(props.savingAction)}
          @click=${props.onAddScreenFlowEdge}
        >
          ${props.savingAction === "screen-flow" ? "Saving…" : "Add link"}
        </button>
      </div>
      ${edges.length === 0
        ? html`
            <article class="app-studio-flow-empty">
              <b>No links yet</b>
              <p>Drag screens into order or upload sketch notes like “Home → Settings”.</p>
            </article>
          `
        : html`
            <div class="app-studio-flow-list">
              ${edges.map(
                (edge) => html`
                  <article class="app-studio-flow-edge">
                    <b>${screenTitleById(selected, edge.fromScreenId)}</b>
                    <span>→</span>
                    <b>${screenTitleById(selected, edge.toScreenId)}</b>
                    <small>${edge.trigger}</small>
                    <button
                      class="btn btn--subtle btn--sm"
                      type="button"
                      ?disabled=${Boolean(props.savingAction)}
                      @click=${() => props.onRemoveScreenFlowEdge(edge.id)}
                    >
                      Remove
                    </button>
                  </article>
                `,
              )}
            </div>
          `}
    </div>
  `;
}

function renderBlueprint(selected: AppStudioSelectedProject, props: AppStudioDashboardProps) {
  return html`
    <section class="app-studio-panel app-studio-panel--blueprint">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Blueprint</span>
          <h2>Screens, data, and App Store shape</h2>
        </div>
        <span class="app-studio-path">${shortPath(selected.appDir)}</span>
      </div>
      <div class="app-studio-blueprint-grid">
        <div class="app-studio-card-group">
          <h3>Drag screens into the right order</h3>
          <div class="app-studio-screen-list">
            ${selected.screens.map((screen, index) =>
              renderScreenCard(screen, index, selected.screens, props),
            )}
          </div>
          ${renderScreenFlowMap(selected, props)}
        </div>
        <div class="app-studio-card-group">
          <h3>Data model</h3>
          ${selected.dataModel.map(
            (model) => html`
              <article class="app-studio-data-card">
                <b>${model.name}</b>
                <p>${model.purpose}</p>
                <small>${model.fields.join(" · ")}</small>
              </article>
            `,
          )}
          <h3>Privacy</h3>
          <article class="app-studio-data-card">
            <b>${selected.spec.privacyPosture.tracking ? "Tracking enabled" : "No tracking"}</b>
            <p>
              ${selected.spec.privacyPosture.collectsPersonalData
                ? "Collects personal data; review labels before App Review."
                : "Local-first privacy posture with no personal-data collection by default."}
            </p>
            <small>${selected.spec.privacyPosture.notes.join(" · ")}</small>
          </article>
        </div>
      </div>
    </section>
  `;
}

function renderAiBuildStatus(selected: AppStudioSelectedProject, props: AppStudioDashboardProps) {
  const appBuilder = selected.studio.agentWorkboard.find((agent) => agent.id === "app-builder");
  const aiBuild = asRecord(selected.latestReports.aiBuild);
  const patch = asRecord(selected.latestReports.patch);
  const connected = aiBuild?.connectedToAi === true;
  const ready = aiBuild?.ready === true || patch?.ready === true;
  const changedFiles = stringArrayValue(aiBuild?.changedFiles ?? patch?.changedFiles);
  const nextActions = stringArrayValue(aiBuild?.nextActions ?? patch?.nextActions);
  const error = stringValue(aiBuild?.error ?? patch?.error);
  const rawSha = stringValue(aiBuild?.rawOutputSha256);
  const patchReady = patch?.ready === true;
  const patchApplied = patch?.applied === true || changedFiles.length > 0;
  const rejectedChanges = arrayLength(patch?.rejectedChanges);
  const evidenceFiles = [
    aiBuild ? "ai-build-report.json" : null,
    rawSha ? "ai-build-raw-output.txt" : null,
    patch ? "patch-report.json" : null,
    patch ? "patch-transcript.json" : null,
  ].filter((item): item is string => item !== null);
  const evidenceProof = aiBuild
    ? connected
      ? patch
        ? patchReady
          ? "AI connected and the guarded patch is ready."
          : patchApplied
            ? "AI connected and applied a patch; validation still needs attention."
            : "AI connected, but the patch executor did not apply a change."
        : "AI connected; waiting for patch executor evidence."
      : "AI report exists, but it did not prove a completed AI connection."
    : "Run AI build pass to generate evidence files.";
  const isRunning = appBuilder?.status === "running";
  const tone = isRunning ? "running" : ready ? "done" : aiBuild || patch ? "blocked" : "idle";
  const primaryStatus = isRunning
    ? "Working now"
    : ready
      ? "AI build applied"
      : aiBuild || patch
        ? "Needs attention"
        : "Not run yet";
  const detail = isRunning
    ? (appBuilder?.currentTask ?? "The selected AI coder is generating a guarded patch.")
    : ready
      ? `${stringValue(aiBuild?.engine) || "Selected AI"} changed ${changedFiles.length} file(s).`
      : aiBuild || patch
        ? error || nextActions[0] || "Review AI build evidence, then rerun."
        : "Click Run AI build pass to make the selected AI coder work on this app.";

  return html`
    <section class="app-studio-panel app-studio-panel--ai-build">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">AI build status</span>
          <h2>Is the app builder actually working?</h2>
        </div>
        <span class="app-studio-ai-build__status app-studio-ai-build__status--${tone}">
          ${primaryStatus}
        </span>
      </div>

      <div class="app-studio-ai-build-grid">
        <article class="app-studio-data-card">
          <b>Selected coder</b>
          <p>${appBuilder?.modelRef ?? selected.studio.buildEngine}</p>
          <small
            >${connected ? "Connected to AI on last run" : "No completed AI connection yet"}</small
          >
        </article>
        <article class="app-studio-data-card">
          <b>Current task</b>
          <p>${detail}</p>
          <small
            >${appBuilder
              ? `Updated ${fmtIsoTime(appBuilder.updatedAt)}`
              : "Waiting for workboard"}</small
          >
        </article>
        <article class="app-studio-data-card">
          <b>Changed files</b>
          <p>${changedFiles.length ? changedFiles.join(" · ") : "No AI patch applied yet"}</p>
          <small
            >${rawSha
              ? `Raw output sha256 ${rawSha.slice(0, 12)}…`
              : "Raw output appears after an AI run"}</small
          >
        </article>
        <article class="app-studio-data-card">
          <b>Evidence artifacts</b>
          <p>
            ${evidenceFiles.length ? evidenceFiles.join(" · ") : "No AI evidence artifacts yet"}
          </p>
          <small
            >${nextActions.length
              ? nextActions.join(" · ")
              : "Next: run Build and test after a green AI patch"}</small
          >
        </article>
        <article class="app-studio-data-card app-studio-data-card--evidence">
          <b>Evidence proof</b>
          <p>${evidenceProof}</p>
          <small
            >${patch
              ? `${changedFiles.length} changed · ${rejectedChanges} rejected · ${patchReady ? "ready" : "not ready"}`
              : rawSha
                ? "Raw AI output recorded; patch report pending"
                : "Reports will appear here after the AI gate runs"}</small
          >
        </article>
      </div>

      <div class="app-studio-ai-build-actions">
        <button
          class="btn btn--primary"
          type="button"
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onRunGate("builder-task")}
        >
          ${props.savingAction === "gate:builder-task" ? "AI build running…" : "Run AI build pass"}
        </button>
        <button class="btn btn--subtle" type="button" @click=${props.onRefresh}>
          Refresh status
        </button>
      </div>
    </section>
  `;
}

function renderSimulatorTestPanel(
  selected: AppStudioSelectedProject,
  props: AppStudioDashboardProps,
) {
  const screenshot = asRecord(selected.latestReports.screenshot);
  const ready = screenshot?.ready === true;
  const path = stringValue(screenshot?.screenshotPath);
  const simulator = asRecord(screenshot?.simulator);
  const simulatorRequested = stringValue(simulator?.requestedName);
  const simulatorResolved = stringValue(simulator?.resolvedName);
  const nextActions = stringArrayValue(screenshot?.nextActions);
  const tone = ready ? "done" : screenshot ? "blocked" : "idle";
  return html`
    <section class="app-studio-panel app-studio-panel--sim-test">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Simulator test</span>
          <h2>Can we run a live app preview?</h2>
        </div>
        <span
          class="app-studio-data-card__status app-studio-ai-build__status app-studio-ai-build__status--${tone}"
        >
          ${ready ? "Preview captured" : screenshot ? "Needs preview run" : "Not tested yet"}
        </span>
      </div>
      <div class="app-studio-ai-build-grid">
        <article class="app-studio-data-card">
          <b>Simulator</b>
          <p>${simulatorResolved || simulatorRequested || "Default simulator"}</p>
          <small>${path ? "Using capture artifacts" : "No screenshot artifact yet"}</small>
        </article>
        <article class="app-studio-data-card">
          <b>Last artifact</b>
          <p>${path || "Not captured"}</p>
          <small
            >${nextActions.length ? nextActions.join(" · ") : "Next: run a screenshot gate"}</small
          >
        </article>
      </div>
      <div class="app-studio-ai-build-actions">
        <button
          class="btn btn--primary"
          type="button"
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onRunGate("screenshots")}
        >
          ${props.savingAction === "gate:screenshots"
            ? "Running preview capture…"
            : "Run preview capture"}
        </button>
        <button class="btn btn--subtle" type="button" @click=${props.onRefresh}>
          Refresh status
        </button>
      </div>
    </section>
  `;
}

function renderLiveActivity(selected: AppStudioSelectedProject, props: AppStudioDashboardProps) {
  const activity = selected.activity ?? [];
  const workingAgents = selected.studio.agentWorkboard.filter((agent) =>
    ["running", "blocked"].includes(agent.status),
  );
  const recentAgents = workingAgents.length
    ? workingAgents
    : [...selected.studio.agentWorkboard]
        .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 3);
  const busyLabel = actionLabel(props.savingAction);
  const busyDuration =
    props.savingAction && props.actionStartedAt
      ? ` • ${fmtDurationMs(Date.now() - props.actionStartedAt)}`
      : "";
  const lastChecked = props.lastFetchAt ? fmtAgo(props.lastFetchAt) : "never";
  const hasLiveWork =
    props.savingAction !== null ||
    selected.studio.agentWorkboard.some((agent) => agent.status === "running");
  return html`
    <section class="app-studio-panel app-studio-panel--live">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Live updates</span>
          <h2>What is happening right now</h2>
        </div>
        <div class="app-studio-live-chip-wrap">
          <span
            class="app-studio-live-chip ${hasLiveWork || props.savingAction ? "app-studio-live-chip--on" : ""}"
          >
            ${props.savingAction ? `${busyLabel}${busyDuration}` : `Last checked ${lastChecked}`}
          </span>
          <span
            class="app-studio-chip app-studio-live-chip-subline"
            ?hidden=${!props.lastFetchAt}
          >
            Updated ${props.lastFetchAt ? fmtTime(props.lastFetchAt) : "—"}
          </span>
        </div>
      </div>
      <div class="app-studio-live-grid">
        <div class="app-studio-live-column">
          <h3>Current workers</h3>
          ${
            recentAgents.length
              ? recentAgents.map(
                  (agent) => html`
                    <article
                      class="app-studio-live-row app-studio-live-row--${agent.status}"
                      data-stage=${agent.id}
                    >
                      <div>
                        <b>${agent.label}</b>
                        <p>${agent.currentTask}</p>
                        <small>${agent.lastEvent} · Updated ${fmtIsoTime(agent.updatedAt)}</small>
                      </div>
                      <span
                        >${agent.status}
                        ${agent.blockedOn.length ? `· ${agent.blockedOn.length}` : ""}
                      </span>
                    </article>
                  `,
                )
              : html`
                  <article class="app-studio-live-row">
                    <div>
                      <b>Idle</b>
                      <p>Workboard is currently idle.</p>
                      <small>Waiting for your next gate run.</small>
                    </div>
                  </article>
                `
          }
        <div class="app-studio-live-column">
          <h3>Recent evidence</h3>
          ${
            activity.length
              ? activity.slice(0, 6).map(
                  (event) => html`
                    <article class="app-studio-live-row">
                      <div>
                        <b>${event.stage}</b>
                        <p>${event.summary}</p>
                        <small>${event.result} · ${fmtAgo(Date.parse(event.at))}</small>
                      </div>
                    </article>
                  `,
                )
              : html`
                  <article class="app-studio-live-row">
                    <div>
                      <b>No evidence yet</b>
                      <p>Create an app or run a gate to start the live event history.</p>
                      <small>Waiting for App Studio activity</small>
                    </div>
                  </article>
                `
          }
        </div>
      </div>
    </section>
  `;
}

function renderAgentWorkboard(selected: AppStudioSelectedProject) {
  const running = selected.studio.agentWorkboard.find((agent) => agent.status === "running");
  const queued = selected.studio.agentWorkboard.find((agent) => agent.status === "queued");
  const activeLabel = running
    ? `Working: ${running.label}`
    : queued
      ? `Queued: ${queued.label}`
      : `Active: ${selected.studio.buildEngine === "codex" ? "Codex" : "Local Qwen"}`;
  return html`
    <section class="app-studio-panel app-studio-panel--agents">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Agent workboard</span>
          <h2>Exactly what each agent is doing</h2>
        </div>
        <span class="app-studio-chip">${activeLabel}</span>
      </div>
      <div class="app-studio-agent-grid">
        ${selected.studio.agentWorkboard.map(
          (agent) => html`
            <article class="app-studio-agent-card app-studio-agent-card--${agent.status}">
              <div class="app-studio-agent-card__top">
                <div>
                  <b>${agent.label}</b>
                  <small>${agent.role}</small>
                </div>
                <span>${agent.status}</span>
              </div>
              <p>${agent.currentTask}</p>
              <dl>
                <div>
                  <dt>Model/tool</dt>
                  <dd>${agent.modelRef}</dd>
                </div>
                <div>
                  <dt>Inputs</dt>
                  <dd>${agent.inputs.join(" · ") || "None"}</dd>
                </div>
                <div>
                  <dt>Outputs</dt>
                  <dd>${agent.outputs.join(" · ") || "None"}</dd>
                </div>
                <div>
                  <dt>Blocked on</dt>
                  <dd>${agent.blockedOn.join(" · ") || "Nothing"}</dd>
                </div>
              </dl>
              <small class="app-studio-agent-card__event"
                >${agent.lastEvent} · Updated ${fmtIsoTime(agent.updatedAt)}</small
              >
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderGateGrid(
  snapshot: AppStudioDashboardSnapshot,
  selected: AppStudioSelectedProject | null,
  props: AppStudioDashboardProps,
) {
  const gateCards = snapshot.gates.map((gate) => {
    const state = deriveGateUiState(selected, gate.id, props);
    return html`
      <article
        class="app-studio-gate-card app-studio-gate-card--${state.statusTone}${state.recommended
          ? " app-studio-gate-card--recommended"
          : ""}"
      >
        <div>
          <b>${gate.label}</b>
          <p>${gate.detail}</p>
          <span
            class="app-studio-gate-card__status app-studio-gate-card__status--${state.statusTone}"
          >
            ${gate.requiresApproval ? "Approval gate · " : ""} ${state.statusLabel}
          </span>
          <small
            class="app-studio-gate-card__detail app-studio-gate-card__detail--${state.detailTone}"
          >
            ${state.detail}
          </small>
          ${state.disabledReason
            ? html`
                <small class="app-studio-gate-card__detail app-studio-gate-card__blocked"
                  >${state.disabledReason}</small
                >
              `
            : nothing}
        </div>
        <button
          class="btn btn--primary btn--sm"
          type="button"
          ?disabled=${state.disabled}
          title=${state.disabledReason ?? ""}
          @click=${() => props.onRunGate(gate.id)}
        >
          ${state.actionLabel}
        </button>
      </article>
    `;
  });
  return html`
    <section class="app-studio-panel">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Build gates</span>
          <h2>Run only the check you need next</h2>
        </div>
        <button class="btn btn--subtle btn--sm" type="button" @click=${props.onRefresh}>
          Refresh
        </button>
      </div>
      <div class="app-studio-gate-grid">${gateCards}</div>
    </section>
  `;
}

function renderAppleField(
  props: AppStudioDashboardProps,
  field: keyof AppStudioAppleFactsDraft,
  label: string,
  placeholder: string,
) {
  return html`
    <label class="app-studio-field">
      <span>${label}</span>
      <input
        .value=${props.appleFactsDraft[field]}
        placeholder=${placeholder}
        @input=${(event: Event) =>
          props.onAppleFactChange(field, (event.currentTarget as HTMLInputElement).value)}
      />
    </label>
  `;
}

function renderAppleFacts(
  props: AppStudioDashboardProps,
  selected: AppStudioSelectedProject | null,
) {
  return html`
    <section class="app-studio-panel app-studio-panel--apple">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Apple setup</span>
          <h2>Paste references, not secrets</h2>
        </div>
        <span class="app-studio-chip">Needed before TestFlight</span>
      </div>
      <div class="app-studio-apple-grid">
        ${renderAppleField(props, "appStoreConnectAppId", "App Store Connect app ID", "1234567890")}
        ${renderAppleField(props, "sku", "SKU", "habitforge-ios")}
        ${renderAppleField(props, "teamId", "Apple Team ID", "ABCDE12345")}
        ${renderAppleField(
          props,
          "apiKeyProfileRef",
          "API key profile ref",
          "openclaw-appstore-api",
        )}
        ${renderAppleField(props, "signingIdentity", "Signing identity", "Apple Distribution: ...")}
        ${renderAppleField(
          props,
          "provisioningProfile",
          "Provisioning profile",
          "App Store profile name",
        )}
        ${renderAppleField(props, "supportUrl", "Support URL", "https://example.com/support")}
        ${renderAppleField(
          props,
          "privacyUrl",
          "Privacy Policy URL",
          "https://example.com/privacy",
        )}
        ${renderAppleField(props, "reviewContactName", "Review contact name", "First Last")}
        ${renderAppleField(
          props,
          "reviewContactEmail",
          "Review contact email",
          "review@example.com",
        )}
        ${renderAppleField(props, "reviewContactPhone", "Review contact phone", "+1...")}
      </div>
      <div class="app-studio-panel__actions">
        <button
          class="btn btn--primary"
          type="button"
          ?disabled=${!selected || Boolean(props.savingAction)}
          @click=${props.onImportAppleFacts}
        >
          ${props.savingAction === "apple-facts" ? "Saving…" : "Save Apple facts"}
        </button>
      </div>
    </section>
  `;
}

function renderApprovals(
  props: AppStudioDashboardProps,
  selected: AppStudioSelectedProject | null,
) {
  if (!selected) {
    return nothing;
  }
  return html`
    <section class="app-studio-panel app-studio-panel--approvals">
      <div class="app-studio-panel__head">
        <div>
          <span class="app-studio-eyebrow">Human approval</span>
          <h2>Final actions stay owner-controlled</h2>
        </div>
        <span class="app-studio-chip">No auto-submit</span>
      </div>
      <div class="app-studio-approval-list">
        ${selected.studio.approvals.map(
          (approval) => html`
            <article class="app-studio-approval app-studio-approval--${approval.status}">
              <div>
                <b>${approval.label}</b>
                <p>
                  ${approval.status === "approved"
                    ? `Approved ${approval.approvedAt ?? ""}`
                    : "Blocked until you explicitly approve it."}
                </p>
              </div>
              <button
                class="btn btn--subtle btn--sm"
                type="button"
                ?disabled=${approval.status === "approved" || Boolean(props.savingAction)}
                @click=${() => props.onApproveGate(approval.id)}
              >
                ${props.savingAction === `approval:${approval.id}` ? "Approving…" : "Approve"}
              </button>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderReceipt(receipt: AppStudioActionReceipt, onDismiss: () => void) {
  return html`
    <div class="app-studio-receipt" role="status">
      <button
        type="button"
        class="app-studio-receipt__close"
        @click=${onDismiss}
        aria-label="Dismiss"
      >
        ${icons.x}
      </button>
      <b>${receipt.title}</b>
      <p>${receipt.detail}</p>
      <small>${receipt.next}</small>
    </div>
  `;
}

function renderSelectedProject(
  snapshot: AppStudioDashboardSnapshot,
  props: AppStudioDashboardProps,
) {
  const selected = snapshot.selectedProject;
  const nextGate = nextRecommendedGate(snapshot, selected, props);
  if (!selected) {
    return html`
      <section class="app-studio-panel app-studio-panel--empty">
        <span>${icons.spark}</span>
        <h2>Start with one sentence.</h2>
        <p>
          App Studio creates an iOS SwiftUI scaffold, then walks you through model checks, local
          validation, screenshots, metadata, and App Store publish planning.
        </p>
      </section>
    `;
  }
  return html`
    ${renderStageRail(snapshot, selected, props)}
    <section class="app-studio-hero app-studio-hero--selected">
      <div>
        <span class="app-studio-eyebrow">${selected.stage}</span>
        <h1>${selected.appName}</h1>
        <p>${selected.spec.goal}</p>
        <div class="app-studio-hero__meta">
          <span>${selected.bundleId}</span>
          <span>${selected.spec.appleCategory}</span>
          <span>${shortPath(selected.appDir)}</span>
        </div>
      </div>
      ${nextGate
        ? html`
            <aside class="app-studio-hero__next">
              <b>Next move</b>
              <p>${resolveGateLabel(snapshot, nextGate.gate)}</p>
              <button
                class="btn btn--subtle"
                type="button"
                ?disabled=${nextGate.state.disabled}
                title=${nextGate.state.disabledReason ?? "Run the highest-priority next step"}
                @click=${() => props.onRunGate(nextGate.gate)}
              >
                ${nextGate.state.actionLabel}
              </button>
            </aside>
          `
        : nothing}
      <div class="app-studio-metrics">
        ${renderMetric("Completion Grade", selected.completionGrade, "0-10 build readiness")}
        ${renderMetric("Criticality", selected.criticality, "next gap severity", "critical")}
        ${renderMetric("Next", selected.nextAction, "highest-priority build gap", "wide")}
      </div>
    </section>
    ${renderLiveActivity(selected, props)} ${renderAiBuildStatus(selected, props)}
    ${renderSimulatorTestPanel(selected, props)} ${renderAgentWorkboard(selected)}
    ${renderBlueprint(selected, props)} ${renderGateGrid(snapshot, selected, props)}
    ${renderAppleFacts(props, selected)} ${renderApprovals(props, selected)}
  `;
}

function renderPromptBar(
  props: AppStudioDashboardProps,
  snapshot: AppStudioDashboardSnapshot | null,
  hasProject: boolean,
  selected: AppStudioSelectedProject | null,
): TemplateResult {
  return html`
    <section class="app-studio-prompt-shell" aria-label="App prompt">
      <div class="app-studio-prompt-shell__copy">
        <span class="app-studio-eyebrow">Prompt-first app builder</span>
        <h1>Describe the app. OpenClaw builds the path to App Review.</h1>
        <p>
          Keep the first pass simple. Use prompts for changes. Use the gates when the app is ready
          for Xcode, TestFlight, or App Store evidence.
        </p>
      </div>
      <div class="app-studio-prompt-card">
        <textarea
          .value=${props.promptDraft}
          placeholder="Example: Create a private habit tracker with streaks, reminders, and no account signup."
          @input=${(event: Event) =>
            props.onPromptDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="app-studio-create-fields">
          <label>
            <span>App name</span>
            <input
              .value=${props.createNameDraft}
              placeholder="Optional"
              @input=${(event: Event) =>
                props.onCreateNameDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            <span>App ID</span>
            <input
              .value=${props.createAppIdDraft}
              placeholder="Optional"
              @input=${(event: Event) =>
                props.onCreateAppIdDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label>
            <span>Bundle ID</span>
            <input
              .value=${props.createBundleIdDraft}
              placeholder="com.yourllc.app"
              @input=${(event: Event) =>
                props.onCreateBundleIdDraftChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
        </div>
        ${renderBuildEnginePicker(props, snapshot)}
        ${renderScreenImageImport(props, hasProject, selected)}
        <div class="app-studio-prompt-card__actions">
          <button
            class="btn btn--primary"
            type="button"
            ?disabled=${Boolean(props.savingAction)}
            @click=${props.onCreateProject}
          >
            ${props.savingAction === "create" ? "Creating…" : "Build new app"}
          </button>
          <button
            class="btn btn--subtle"
            type="button"
            ?disabled=${!hasProject || Boolean(props.savingAction)}
            @click=${props.onApplyPrompt}
          >
            ${props.savingAction === "prompt" ? "Applying…" : "Apply to selected app"}
          </button>
        </div>
      </div>
    </section>
  `;
}

export function renderAppStudioDashboard(props: AppStudioDashboardProps) {
  const snapshot = props.snapshot;
  const selected = snapshot?.selectedProject ?? null;
  return html`
    <div class="app-studio">
      <div class="app-studio-toolbar">
        <span>Last checked: ${fmtTime(props.lastFetchAt)}</span>
        <button class="btn btn--subtle btn--sm" type="button" @click=${props.onRefresh}>
          ${props.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${props.actionReceipt ? renderReceipt(props.actionReceipt, props.onDismissReceipt) : nothing}
      ${renderPromptBar(props, snapshot, Boolean(selected), selected)}
      <div class="app-studio-layout">
        <aside class="app-studio-sidebar">
          <h2>Your apps</h2>
          ${snapshot ? renderProjectList(props, snapshot.projects) : renderProjectList(props, [])}
        </aside>
        <div class="app-studio-main">
          ${snapshot
            ? renderSelectedProject(snapshot, props)
            : html`
                <section class="app-studio-panel app-studio-panel--empty">
                  <span>${icons.loader}</span>
                  <h2>${props.loading ? "Loading App Studio…" : "Connect to load App Studio."}</h2>
                  <p>When connected, App Studio shows projects, gates, and next gaps.</p>
                </section>
              `}
        </div>
      </div>
    </div>
  `;
}
