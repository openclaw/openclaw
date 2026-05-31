import { html, nothing } from "lit";
import {
  applySnesJsonPatch,
  addSnesCustomTileBrush,
  addSnesProjectScene,
  appendSnesAgentDispatchRecord,
  appendSnesAgentResultRecord,
  appendSnesProjectVersion,
  applySnesImportedTileset,
  buildSnesReadiness,
  buildSnesPreviewRom,
  createBlankSnesStudioProject,
  createClassicPlatformerStylePack,
  createDefaultSnesStudioProject,
  diffSnesAgentPatchProposal,
  diffSnesProjectVersions,
  duplicateSnesProjectScene,
  createSnesEmulatorValidationReport,
  createSnesEmulatorReplayParityProof,
  createSnesEmulatorReplayRunPack,
  createSnesEmulatorScreenshotComparison,
  createFxpakExportManifest,
  createSnesAgentPatchProposalForSurface,
  createSnesAgentDispatchRecord,
  createSnesAgentPatchProposalFromResult,
  createSnesAgentTeamPlan,
  createSnesAgentTeamReadinessPlan,
  createSnesAiBuildPlan,
  createSnesAiAuthoringPrompts,
  createSnesAgentTaskBlueprints,
  createSnesAiProductionGatewayPlan,
  createSnesAiProductionRun,
  createSnesAssetPipelineReport,
  createSnesAudioManifest,
  createSnesBuildPipeline,
  createSnesCodexTaskPacket,
  createSnesCutsceneTimeline,
  createSnesEmulatorBootProof,
  createSnesEmulatorBootPlan,
  createSnesFxpakExportPackage,
  createSnesFxpakCopyDryRun,
  createSnesFxpakCopyProof,
  createSnesFxpakMountedExportValidation,
  createSnesGatewayAgentHandoff,
  createSnesGeneratedObjectSummary,
  createSnesGuidedBuildChecklist,
  createSnesHardwareQaBundle,
  createSnesLevelTransitionPlan,
  createSnesLocalAgentPatchResponse,
  createSnesOnePromptGameReport,
  createSnesPromptSpriteAsset,
  createSnesProjectBundle,
  createSnesProjectFromTemplate,
  createSnesProjectTemplates,
  createSnesProjectVersion,
  createSnesRuntimeEventPlan,
  compileSnesRuntimeProject,
  createSnesSaveManifest,
  defaultSnesAgentProviderForSurface,
  createSnesSpriteOamBudgetReport,
  createSnesCollisionPhysicsPlan,
  createSnesSpc700ExportPlan,
  createSnesSuperFxProfileReport,
  createSnesSramSerializationReport,
  createSnesSramImage,
  createSnesSramPowerCycleProof,
  createSnesAiGapReport,
  fillSnesAiGaps,
  importSnesIndexedTileAsset,
  importSnesRgbaTileAsset,
  moveSnesSceneEntity,
  normalizeSnesStudioProject,
  paintSnesSceneCell,
  paintSnesSceneRect,
  parseSnesProjectDocument,
  parseSnesAgentDispatchQueue,
  parseSnesAgentResultQueue,
  parseSnesProjectVersionHistory,
  parseSnesIndexedTilePixels,
  parseSnesAgentPatchProposalResponse,
  removeSnesProjectScene,
  repairSnesProjectForPlayablePreview,
  renderSnesRuntimeFrame,
  readSnesSaveSlot,
  runSnesRuntimeReplay,
  runSnesAgentDispatchRecord,
  resolveSnesVisualStyleFromPrompt,
  simulateSnesEventScripts,
  stepSnesRuntimeFrame,
  summarizeSnesAgentTeamBlockers,
  SNES_RUNTIME_VIEWPORT,
  SNES_AGENT_DISPATCH_EVENT,
  SNES_AGENT_DISPATCH_QUEUE_KEY,
  SNES_AGENT_RESULT_EVENT,
  SNES_AGENT_RESULT_QUEUE_KEY,
  SNES_IMPORTED_TILE_BRUSH_BASE,
  SNES_STUDIO_EDIT_GRID,
  stableProjectJson,
  validateSnesPreviewRomArtifact,
  validateSnesSramImage,
  writeSnesSaveSlot,
  selectSnesFxpakMountedVolume,
  SNES_CLASSIC_PLATFORMER_STYLE_PRESET,
  type SnesAgentDispatchRecord,
  type SnesAgentRoleReadiness,
  type SnesAgentTeamMember,
  type SnesAgentTeamReadiness,
  type SnesAgentTeamReadinessReport,
  type SnesAgentTeamRun,
  type SnesAgentResultRecord,
  type SnesAgentPatchProposal,
  type SnesAgentProvider,
  type SnesAiAuthoringSurface,
  type SnesAiGap,
  type SnesBudgetMeter,
  type SnesCollisionMaterial,
  type SnesEnemyBehavior,
  type SnesEnemyBehaviorKind,
  type SnesEmulatorKind,
  type SnesFxpakMountedVolumeProbe,
  type SnesGatewayAgentHandoff,
  type SnesLevelChapter,
  type SnesPreviewControllerInput,
  type SnesPreviewRomValidationCheck,
  type SnesPreviewSimulationState,
  type SnesRuntimeInputFrame,
  type SnesRuntimeParityReport,
  type SnesRuntimeProject,
  type SnesRuntimeReplay,
  type SnesProjectVersion,
  type SnesEventSimulationResult,
  type SnesEventScript,
  type SnesScreenAreaSelection,
  type SnesGamePartLock,
  type SnesSceneEntityKind,
  type SnesSramSlotValues,
  type SnesStudioProject,
  type SnesTileBrush,
} from "../../../../packages/snes-studio-core/src/index.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY = "openclaw:snes-studio:project:v1";
const VERSION_HISTORY_KEY = `${STORAGE_KEY}:versions`;
const UNDO_STACK_KEY = `${STORAGE_KEY}:undo`;
const REDO_STACK_KEY = `${STORAGE_KEY}:redo`;
const SNES_AGENT_STREAM_EVENT = "openclaw:snes-studio:agent-stream";
const SNES_AGENT_STREAM_QUEUE_KEY = "openclaw:snes-studio:agent-stream-queue:v1";
const DEFAULT_AGENT_GATEWAY_SESSION_KEY = "agent:main:dashboard:snes-studio";
const SNES_AGENT_GATEWAY_SESSION_KEY = "openclaw:snes-studio:gateway-session:v1";

type SnesGatewayClient = {
  request: <T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
};

type SnesGatewayAgentsListResult = {
  agents?: Array<{ id?: string; workspace?: string; model?: unknown }>;
};

type SnesGatewayAgentsCreateResult = {
  ok?: boolean;
  agentId?: string;
  name?: string;
};

type SnesGatewayAgentsRuntimeStatusResult = {
  localModels?: {
    available?: boolean;
    error?: string;
    installedAvailable?: boolean;
    installedError?: string;
    count?: number;
    models?: Array<{ model?: string; name?: string }>;
    installedModels?: Array<{ model?: string; name?: string }>;
  };
  warnings?: string[];
};

type HostUpdate = {
  requestUpdate?: () => void;
  client?: SnesGatewayClient | null;
  connected?: boolean | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
};

type SnesLiveAiReadinessStatus = "ready" | "no-client" | "disconnected" | "unauthorized";

type SnesLiveAiReadiness = {
  status: SnesLiveAiReadinessStatus;
  title: string;
  detail: string;
  gatewayConnected: boolean;
  authenticated: boolean;
  agentRpcAvailable: boolean;
  codexRouteReady: boolean;
  openClawWorkerReady: boolean;
  e2eEnabled: boolean;
  blockers: string[];
  nextActions: string[];
};

function isGatewayLiveReady(host: HostUpdate): host is HostUpdate & { client: SnesGatewayClient } {
  return Boolean(host.client && host.connected === true);
}

function isUnauthorizedGatewayError(host: HostUpdate) {
  const text = `${host.lastErrorCode ?? ""} ${host.lastError ?? ""}`.toLowerCase();
  return text.includes("unauthorized") || text.includes("401");
}

function probeSnesLiveAiReadiness(host: HostUpdate): SnesLiveAiReadiness {
  if (!host.client) {
    return {
      status: "no-client",
      title: "Open through Dashboard",
      detail:
        "SNES Studio has no Dashboard Gateway client yet. Open it through the OpenClaw Dashboard, then retry.",
      gatewayConnected: false,
      authenticated: false,
      agentRpcAvailable: false,
      codexRouteReady: false,
      openClawWorkerReady: false,
      e2eEnabled: false,
      blockers: ["No Dashboard Gateway client is available."],
      nextActions: ["Open SNES Studio from the OpenClaw Dashboard."],
    };
  }
  if (host.connected !== true) {
    const error = host.lastError?.trim();
    const code = host.lastErrorCode?.trim();
    const errorDetail = error ? ` Last Gateway error: ${error}${code ? ` (${code})` : ""}.` : "";
    const unauthorized = isUnauthorizedGatewayError(host);
    return {
      status: unauthorized ? "unauthorized" : "disconnected",
      title: unauthorized ? "Needs Dashboard login" : "Gateway offline",
      detail: `The Dashboard Gateway WebSocket is not connected.${errorDetail} Local game building still works; hardware equipment is not required for this step. The OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E flag is only for automated smoke proof, not dashboard use.`,
      gatewayConnected: false,
      authenticated: false,
      agentRpcAvailable: false,
      codexRouteReady: false,
      openClawWorkerReady: false,
      e2eEnabled: false,
      blockers: [
        unauthorized
          ? "Dashboard authentication failed or expired."
          : "Dashboard Gateway WebSocket is not connected.",
      ],
      nextActions: [
        unauthorized ? "Open Dashboard Login, then retry." : "Reconnect Dashboard, then retry.",
      ],
    };
  }
  return {
    status: "ready",
    title: "Dashboard Gateway ready",
    detail:
      "Dashboard Gateway is connected and authenticated. SNES Studio checks the live Codex/OpenClaw team automatically and reports any unavailable role. Automated smoke E2E remains opt-in to avoid accidental model spend.",
    gatewayConnected: true,
    authenticated: true,
    agentRpcAvailable: true,
    codexRouteReady: true,
    openClawWorkerReady: true,
    e2eEnabled: false,
    blockers: [],
    nextActions: ["Wait for automatic live team status, or use Check Again."],
  };
}

type SnesStudioPanel =
  | "project"
  | "prompt"
  | "scene"
  | "assets"
  | "story"
  | "logic"
  | "export"
  | "agents";
type SnesStudioMode = "make" | "edit" | "play" | "ship";
type SnesAiGameStageProvider = "auto-team" | SnesAgentProvider;
type SnesCreateTarget =
  | SnesAiAuthoringSurface
  | "selected-object"
  | "background-music"
  | "beats-drums"
  | "melody-vocal"
  | "sound-fx"
  | "game-logic"
  | "build-fix";
type SnesObjectCardFilter = "all" | "levels" | "characters" | "story" | "audio" | "hardware";
type SnesAgentStreamRecord = {
  id: string;
  recordId?: string;
  createdAt: string;
  requestedAgent: SnesAgentProvider;
  surface: SnesAiAuthoringSurface;
  status: "streaming" | "complete" | "error";
  chunk?: string;
  responseText?: string;
};
type SnesGeneratedObjectFilter = "all" | "entities" | "story" | "audio" | "hardware";
type SnesButtonAuditStatus = "verified" | "tested" | "blocked";
type SnesLiveAgentProofState = {
  status: "idle" | "running" | "passed" | "needs-setup" | "failed";
  title: string;
  detail: string;
  checkedAt?: string;
  recordId?: string;
};
type SnesSoundEffectDraft = SnesStudioProject["assets"]["audio"]["soundEffects"][number];
type SnesAudioInstrument = SnesSoundEffectDraft["steps"][number]["instrument"];
type SnesEditableObjectCard =
  | ReturnType<typeof createSnesGeneratedObjectSummary>[number]
  | {
      id: "game";
      kind: "game";
      label: string;
      editPanel: SnesStudioPanel;
      detail: string;
    }
  | {
      id: string;
      kind: "level";
      label: string;
      editPanel: "scene";
      detail: string;
    };
type SnesRuntimeProofGate = {
  code: string;
  gap: string;
  label: string;
  userProof: string;
};
type SnesAiActionFeedback = {
  status: "working" | "ready" | "review" | "error";
  title: string;
  detail: string;
  provider: SnesAgentProvider;
  target: string;
  createdAt: string;
};
type SnesDraggedPart = {
  id: string;
  kind: SnesEditableObjectCard["kind"];
  label: string;
} | null;
type SnesSceneEntityDraft = SnesStudioProject["scenes"][number]["entities"][number];
type SnesSelectedSceneThing = {
  scene: SnesStudioProject["scenes"][number];
  entity: SnesSceneEntityDraft;
};
type SnesArcadeAreaDragStart = {
  xPercent: number;
  yPercent: number;
} | null;
type SnesDirectEntityDrag = {
  entityId: string;
  pointerId: number | null;
  sceneId: string;
  undoRecorded: boolean;
  moved: boolean;
} | null;
type SnesAreaEditMode = "move" | "resize";
type SnesAreaEditDrag = {
  mode: SnesAreaEditMode;
  pointerId: number | null;
  startArea: SnesScreenAreaSelection;
  startPointer: {
    xPercent: number;
    yPercent: number;
  };
  moveContent: boolean;
} | null;
type SnesPendingAreaPreview = {
  id: string;
  prompt: string;
  area: SnesScreenAreaSelection;
  provider: SnesAgentProvider;
  summary: string;
  changed: string[];
  suggestedTest: string;
  createdAt: string;
};
type SnesGuidedGameStep =
  | "idea"
  | "game-plan"
  | "build-level"
  | "make-things"
  | "playtest"
  | "export";
type SnesGuidedThingKind =
  | "hero"
  | "enemy"
  | "item"
  | "powerup"
  | "block"
  | "platform"
  | "door"
  | "goal"
  | "hazard"
  | "coin-trail"
  | "music"
  | "level";
type SnesGuidedReceipt = {
  title: string;
  detail: string;
  next: string;
} | null;
type SnesSoundBindingKey = "level-music" | "jump" | "pickup" | "hit" | "boss" | "door";
type SnesHelpTermId =
  | "snes-game-file"
  | "save-memory"
  | "flash-cart"
  | "superfx"
  | "lorom"
  | "mode-1"
  | "level-square"
  | "palette"
  | "bump-map"
  | "sprite"
  | "sprite-size"
  | "oam"
  | "vram"
  | "cgram"
  | "spc700"
  | "bank"
  | "checksum";

const helpTerms: Record<
  SnesHelpTermId,
  { label: string; definition: string; why: string; careNow: string }
> = {
  "snes-game-file": {
    label: "SNES game file",
    definition: "The file your Super Nintendo emulator or flash cart loads.",
    why: "It is the final playable output of your project.",
    careNow: "You only need this when you test or export.",
  },
  "save-memory": {
    label: "save memory",
    definition: "The small saved-game area used to remember progress.",
    why: "It keeps player progress safe between sessions.",
    careNow: "You only need this when your game has saves.",
  },
  "flash-cart": {
    label: "flash cart",
    definition: "A cartridge adapter that loads your SNES game file from a microSD card.",
    why: "It lets your game run on real SNES hardware.",
    careNow: "You only need this when exporting for hardware.",
  },
  superfx: {
    label: "SuperFX",
    definition: "An enhancement chip used by some SNES games for faster special effects.",
    why: "It matters for Star Fox or Doom-style projects.",
    careNow: "Leave it off until your game needs those effects.",
  },
  lorom: {
    label: "LoROM",
    definition: "A common way SNES games organize data inside the cartridge file.",
    why: "It affects where code, art, levels, and saves are packed.",
    careNow: "Usually no. Export checks it for you.",
  },
  "mode-1": {
    label: "Mode 1",
    definition: "A standard SNES background display setup for layered 2D scenes.",
    why: "It is a strong default for platformers and adventures.",
    careNow: "Usually no. Build uses this default unless you open Expert Details.",
  },
  "level-square": {
    label: "level square",
    definition: "One small editable square in the level grid.",
    why: "Drawing these creates ground, water, danger, and paths.",
    careNow: "Yes. Click or drag on them to build the scene.",
  },
  palette: {
    label: "palette",
    definition: "A limited set of colors the SNES can use for art.",
    why: "It keeps pixel art compatible with the hardware.",
    careNow: "Only when polishing art colors.",
  },
  "bump-map": {
    label: "where the player bumps",
    definition: "The invisible rules for what blocks, hurts, or carries the hero.",
    why: "It makes jumping, walls, water, and hazards feel correct.",
    careNow: "Only when a level feels wrong in Test.",
  },
  sprite: {
    label: "sprite",
    definition: "A movable picture such as the hero, enemy, coin, or door.",
    why: "Most active game things are sprites.",
    careNow: "Yes. Drag these on the canvas.",
  },
  "sprite-size": {
    label: "sprite size",
    definition: "How much SNES sprite space a character or item uses.",
    why: "Too many large sprites can flicker or exceed hardware limits.",
    careNow: "Only if Export says the game needs fixes.",
  },
  oam: {
    label: "OAM",
    definition: "The SNES list of sprites to draw this frame.",
    why: "It limits how many moving things can appear at once.",
    careNow: "Only in Expert Details.",
  },
  vram: {
    label: "VRAM",
    definition: "The SNES video memory that holds level art.",
    why: "It limits how much art can be visible.",
    careNow: "Only in Expert Details.",
  },
  cgram: {
    label: "CGRAM",
    definition: "The SNES color memory.",
    why: "It limits the number of colors available at once.",
    careNow: "Only in Expert Details.",
  },
  spc700: {
    label: "SPC700",
    definition: "The SNES sound processor.",
    why: "It plays music and sound effects.",
    careNow: "Only when editing advanced audio.",
  },
  bank: {
    label: "bank",
    definition: "A chunk of SNES game-file space.",
    why: "Banks keep big games organized under hardware limits.",
    careNow: "Only in Expert Details.",
  },
  checksum: {
    label: "checksum",
    definition: "A number used to verify the exported file is not corrupted.",
    why: "It helps emulators and hardware trust the game file.",
    careNow: "Only when exporting.",
  },
};

const audioInstrumentOptions: SnesAudioInstrument[] = ["pulse", "noise", "sample"];

function createDefaultConsoleLines() {
  return [
    "SNES Studio ready. Create a game, test it, then export a SNES game file.",
    "Hardware setup ready: flash cart export, 128 GB FAT32 card, and save memory protection.",
  ];
}

let project = loadProject();
let agentDispatchQueue = loadAgentDispatchQueue();
let agentResultQueue = loadAgentResultQueue();
let agentStreamRecords = loadAgentStreamQueue();
let projectVersions = loadProjectVersions();
let consoleLines = createDefaultConsoleLines();
let selectedMode: SnesStudioMode = "make";
let aiGameStageProvider: SnesAiGameStageProvider = "auto-team";
let selectedGuidedStep: SnesGuidedGameStep = "idea";
let guidedThingPromptDraft =
  "Create a slow turtle enemy called Shell Walker that patrols a short safe path.";
let guidedReceipt: SnesGuidedReceipt = null;
let selectedScreenArea: SnesScreenAreaSelection | null = project.selectedScreenArea ?? null;
let arcadeAreaDragStart: SnesArcadeAreaDragStart = null;
let arcadeAreaPromptDraft = "Add a coin trail here.";
let pendingAreaPreview: SnesPendingAreaPreview | null = null;
let showExpertStudio = false;
let selectedCreateTarget: SnesCreateTarget = "full-game";
let objectCardFilter: SnesObjectCardFilter = "all";
let objectCardSearchDraft = "";
let selectedPanel: SnesStudioPanel = "project";
let selectedSceneIndex = 0;
let lastSnapshotAt: string | null = null;
let pendingAgentProposal: SnesAgentPatchProposal | null = null;
let pendingInlineReviewObjectId = "";
let lastAiActionFeedback: SnesAiActionFeedback | null = null;
let lastAppliedFullGamePrompt = "";
const initialAiPromptCatalog = createSnesAiAuthoringPrompts(project);
let aiPromptDrafts = Object.fromEntries(
  initialAiPromptCatalog.map((entry) => [entry.surface, entry.placeholder]),
) as Record<SnesAiAuthoringSurface, string>;
let aiProviderBySurface = Object.fromEntries(
  initialAiPromptCatalog.map((entry) => [
    entry.surface,
    defaultSnesAgentProviderForSurface(entry.surface),
  ]),
) as Record<SnesAiAuthoringSurface, SnesAgentProvider>;
let agentPatchDraft = "";
let assetImportHeight = 8;
let assetImportName = "Checker Tiles";
let assetImportPixels = Array.from({ length: 128 }, (_, index) =>
  index % 2 === 0 ? "1" : "2",
).join(" ");
let assetImportQuantizePng = true;
let assetImportWidth = 16;
let customBrushName = "Spike Hazard";
let customBrushSolid = true;
let customBrushTile = 4;
let draggedEntityId: string | null = null;
type SnesScenePalettePiece = "hero" | "enemy" | "item" | "door" | "goal" | "guide";
let draggedPalettePiece: SnesScenePalettePiece | null = null;
let draggedGuidedThingKind: SnesGuidedThingKind | null = null;
let draggedPart: SnesDraggedPart = null;
let directEntityDrag: SnesDirectEntityDrag = null;
let areaEditDrag: SnesAreaEditDrag = null;
let soundBindings: Partial<Record<SnesSoundBindingKey, string>> = {};
let emulatorSelectionDraft = "";
let fxpakProbe: SnesFxpakMountedVolumeProbe = {
  mounted: false,
  volumePath: "/Volumes/FXPAK",
  fileSystem: "FAT32",
  cardSizeGb: 128,
  freeBytes: 512 * 1024 * 1024,
  existingSavePresent: true,
};
let templateDetailDraft = "short polished first level, starter enemy, collectible, save point";
let projectImportDraft = "";
let redoStack: string[] = loadHistoryStack(REDO_STACK_KEY);
let selectedBrushSize = 1;
let selectedPaintMode: "collision" | "tile" = "tile";
let selectedCollisionMaterial: SnesCollisionMaterial = 1;
let selectedTileBrush: SnesTileBrush = 1;
let spritePromptDraft = "Create an armored blue robot hero with a readable 16x16 silhouette.";
let undoStack: string[] = loadHistoryStack(UNDO_STACK_KEY);
let agentResultListenerInstalled = false;
let keyboardShortcutsInstalled = false;
let keyboardShortcutHost: HostUpdate | null = null;
let lastAgentSyncAt: string | null = null;
let lastAgentStreamAt: string | null = null;
let showRecoveryPanel = false;
let focusedGeneratedObjectId: string | null = null;
let generatedObjectFilter: SnesGeneratedObjectFilter = "all";
let previewSimulationState: SnesPreviewSimulationState | null = null;
type SnesPlaytestFeedbackTone = "ready" | "move" | "reward" | "warning" | "event";
type SnesPlaytestFeedback = {
  tone: SnesPlaytestFeedbackTone;
  title: string;
  detail: string;
};
type SnesPlaytestMomentTone = "reward" | "challenge" | "goal" | "change";
type SnesPlaytestMoment = {
  tone: SnesPlaytestMomentTone;
  title: string;
  detail: string;
  actionLabel?: string;
  entity?: SnesStudioProject["scenes"][number]["entities"][number];
};
let lastPlaytestFeedback: SnesPlaytestFeedback | null = null;
type SnesLivePlaytestInputKey = keyof Required<SnesPreviewControllerInput>;
let livePlaytestInput: Required<SnesPreviewControllerInput> = {
  jump: false,
  left: false,
  right: false,
};
let livePlaytestFrame = 0;
let livePlaytestRunning = false;
let livePlaytestAnimationFrame: number | null = null;
let livePlaytestLastTimestamp: number | null = null;
let livePlaytestAccumulatorMs = 0;
let livePlaytestDroppedFrames = 0;
let livePlaytestRenderedFrames = 0;
let livePlaytestFps = 0;
let livePlaytestFpsWindowStart: number | null = null;
let lastRuntimeParityReport: SnesRuntimeParityReport | null = null;
let lastRuntimeReplayInputs: SnesRuntimeInputFrame[] = [];
let agentGatewaySessionKey = loadAgentGatewaySessionKey();
let agentTeamRun: SnesAgentTeamRun | null = null;
let agentTeamAutoCheckStarted = false;
let agentTeamReadinessReport: SnesAgentTeamReadinessReport | null = null;
let lastEventSimulation: SnesEventSimulationResult | null = null;
let sramSimulationSummary = "";
let audioPreviewSummary = "";
let cutscenePreviewSummary = "";

function createDefaultLiveAgentProofState(): SnesLiveAgentProofState {
  return {
    status: "idle",
    title: "Checking automatically",
    detail: "SNES Studio checks live Codex/OpenClaw availability when Dashboard Gateway is ready.",
  };
}

function createDefaultLiveAiProductionProofState(): SnesLiveAgentProofState {
  return {
    status: "idle",
    title: "Gateway production route not verified",
    detail:
      "Build With OpenClaw creates a local editable draft now. Run live production check to verify Codex Architect, OpenClaw workers, and Codex QA through Gateway.",
  };
}

let liveAgentProofState = createDefaultLiveAgentProofState();
let liveAiProductionProofState = createDefaultLiveAiProductionProofState();

const beginnerPromptChips: Array<{ label: string; prompt: string }> = [
  {
    label: "Sky robots",
    prompt:
      'Build "Sky Robot Quest", a bright beginner SNES platformer with a hero, floating coins, simple robots, one friendly guide, and a short first level.',
  },
  {
    label: "Forest adventure",
    prompt:
      'Build "Forest Key Adventure", an easy exploration game with a brave kid hero, locked gates, forest enemies, helpful guide dialogue, and progress saves.',
  },
  {
    label: "Space rescue",
    prompt:
      'Build "Space Rescue Run", a polished action game with a pilot hero, rescue items, gentle enemy patterns, clear dialogue, and hardware-safe export settings.',
  },
];

const promptBrushPresets: Array<{ label: string; prompt: string }> = [
  {
    label: "Forest",
    prompt: "Paint a friendly forest level with safe ledges, a key, a guide path, and gems.",
  },
  {
    label: "Sky",
    prompt: "Paint a bright sky level with cloud platforms, coins, and a simple jump path.",
  },
  {
    label: "Cave",
    prompt: "Paint a cave level with walls, ledges, a key, and a safe route to the exit.",
  },
  {
    label: "Water",
    prompt: "Paint a river level with water, coins, and safe solid ground.",
  },
  {
    label: "Lava",
    prompt: "Paint a lava hazard level with safe ledges, warning spikes, and a gem reward.",
  },
  {
    label: "Tower",
    prompt: "Paint a vertical tower level with climbing ledges, a key, and a short route.",
  },
];

const buttonAuditItems: Array<{
  label: string;
  status: SnesButtonAuditStatus;
  evidence: string;
}> = [
  {
    label: "Create Game with OpenClaw/Codex",
    status: "verified",
    evidence: "UI test and browser smoke create an editable playable project.",
  },
  {
    label: "Focused Create & Edit prompts",
    status: "verified",
    evidence: "UI test and browser smoke create editable component content with undo proof.",
  },
  {
    label: "Ask Gateway Agent prompts",
    status: "tested",
    evidence: "UI test sends a text-box prompt directly to the configured Gateway session.",
  },
  {
    label: "Test Game controls",
    status: "verified",
    evidence: "Start, movement, jump, run, and reset controls are UI-tested.",
  },
  {
    label: "Generated entity drag/drop",
    status: "verified",
    evidence: "UI and browser smoke move a generated thing onto the level canvas.",
  },
  {
    label: "Prompt brush presets",
    status: "tested",
    evidence: "Preset painting test verifies bump rules and item output.",
  },
  {
    label: "Build/export actions",
    status: "tested",
    evidence: "Preview game file, manifest, project bundle, QA, and proof buttons are covered.",
  },
  {
    label: "Real emulator and flash cart actions",
    status: "blocked",
    evidence: "Need installed emulator and mounted FAT32 flash cart card for verification.",
  },
];

const runtimeProofGates: SnesRuntimeProofGate[] = [
  {
    code: "UPLOAD_OFFSETS",
    gap: "Renderer",
    label: "Mode 1 upload order",
    userProof: "CGRAM, CHR, and BG1 tilemap upload before play.",
  },
  {
    code: "UPLOAD_OPCODES",
    gap: "Renderer",
    label: "ROM asset upload loop",
    userProof: "Runtime reads compiled graphics data from the ROM.",
  },
  {
    code: "CONTROLLER_SCROLL_LOOP",
    gap: "Gameplay",
    label: "Controller input",
    userProof: "Joypad state updates player X and BG1 scroll.",
  },
  {
    code: "PLAYER_PHYSICS_LOOP",
    gap: "Gameplay",
    label: "Player physics",
    userProof: "Jump, gravity, and ground collision are in the ROM loop.",
  },
  {
    code: "PLAYER_OAM_LOOP",
    gap: "Sprites",
    label: "Player sprite OAM",
    userProof: "Sprite 0 is written from player WRAM.",
  },
  {
    code: "ENTITY_OAM_LOOP",
    gap: "Sprites",
    label: "Enemy/item/NPC OAM",
    userProof: "Preview entities are copied into OAM slots.",
  },
  {
    code: "SCENE_RUNTIME_TABLE",
    gap: "Levels",
    label: "Multi-level table",
    userProof: "Every editable level is indexed in ROM metadata.",
  },
  {
    code: "SCENE_EDIT_LAYERS",
    gap: "Levels",
    label: "Tile/collision layers",
    userProof: "Compiled tile and collision layer checksums are embedded.",
  },
  {
    code: "SRAM_HEADER_BOOTSTRAP",
    gap: "Saves",
    label: "SRAM header bootstrap",
    userProof: "Versioned save header write is present in LoROM SRAM code.",
  },
];

const gamePartMap: Array<{
  label: string;
  surface: SnesAiAuthoringSurface;
  panel: SnesStudioPanel;
  detail: (project: SnesStudioProject) => string;
}> = [
  {
    label: "Whole Game",
    surface: "full-game",
    panel: "prompt",
    detail: (draft) => draft.name,
  },
  {
    label: "Levels",
    surface: "level",
    panel: "scene",
    detail: (draft) => `${draft.scenes.length} editable`,
  },
  {
    label: "Hero",
    surface: "player",
    panel: "scene",
    detail: (draft) =>
      draft.scenes.flatMap((scene) => scene.entities).find((entity) => entity.kind === "player")
        ?.name ?? "needs hero",
  },
  {
    label: "Enemies",
    surface: "enemies",
    panel: "scene",
    detail: (draft) =>
      `${draft.scenes.flatMap((scene) => scene.entities).filter((entity) => entity.kind === "enemy").length} ready`,
  },
  {
    label: "Items",
    surface: "items",
    panel: "scene",
    detail: (draft) =>
      `${draft.scenes.flatMap((scene) => scene.entities).filter((entity) => entity.kind === "item").length} ready`,
  },
  {
    label: "Story",
    surface: "dialogue",
    panel: "story",
    detail: (draft) => `${draft.dialogue.length} lines`,
  },
  {
    label: "Audio",
    surface: "audio",
    panel: "assets",
    detail: (draft) =>
      `${draft.assets.audio.musicTracks.length + draft.assets.audio.soundEffects.length} sounds`,
  },
  {
    label: "Saves",
    surface: "save",
    panel: "export",
    detail: (draft) => (draft.save.enabled ? `${draft.save.fields.length} save fields` : "off"),
  },
  {
    label: "Export",
    surface: "export",
    panel: "export",
    detail: (draft) => createFxpakExportManifest(draft).romPath,
  },
];

export function resetSnesStudioStateForTests() {
  project = normalizeSnesStudioProject(createDefaultSnesStudioProject());
  agentDispatchQueue = [];
  agentResultQueue = [];
  agentStreamRecords = [];
  projectVersions = [];
  consoleLines = createDefaultConsoleLines();
  selectedMode = "make";
  aiGameStageProvider = "auto-team";
  selectedGuidedStep = "idea";
  guidedThingPromptDraft =
    "Create a slow turtle enemy called Shell Walker that patrols a short safe path.";
  guidedReceipt = null;
  selectedScreenArea = null;
  arcadeAreaDragStart = null;
  arcadeAreaPromptDraft = "Add a coin trail here.";
  pendingAreaPreview = null;
  showExpertStudio = false;
  selectedCreateTarget = "full-game";
  objectCardFilter = "all";
  objectCardSearchDraft = "";
  selectedPanel = "project";
  selectedSceneIndex = 0;
  lastSnapshotAt = null;
  pendingAgentProposal = null;
  pendingInlineReviewObjectId = "";
  lastAiActionFeedback = null;
  lastAppliedFullGamePrompt = "";
  const promptCatalog = createSnesAiAuthoringPrompts(project);
  aiPromptDrafts = Object.fromEntries(
    promptCatalog.map((entry) => [entry.surface, entry.placeholder]),
  ) as Record<SnesAiAuthoringSurface, string>;
  aiProviderBySurface = Object.fromEntries(
    promptCatalog.map((entry) => [
      entry.surface,
      defaultSnesAgentProviderForSurface(entry.surface),
    ]),
  ) as Record<SnesAiAuthoringSurface, SnesAgentProvider>;
  agentPatchDraft = "";
  assetImportHeight = 8;
  assetImportName = "Checker Tiles";
  assetImportPixels = Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? "1" : "2")).join(
    " ",
  );
  assetImportWidth = 16;
  customBrushName = "Spike Hazard";
  customBrushSolid = true;
  customBrushTile = 4;
  draggedEntityId = null;
  draggedPalettePiece = null;
  draggedGuidedThingKind = null;
  draggedPart = null;
  directEntityDrag = null;
  areaEditDrag = null;
  soundBindings = {};
  emulatorSelectionDraft = "";
  fxpakProbe = {
    mounted: false,
    volumePath: "/Volumes/FXPAK",
    fileSystem: "FAT32",
    cardSizeGb: 128,
    freeBytes: 512 * 1024 * 1024,
    existingSavePresent: true,
  };
  templateDetailDraft = "short polished first level, starter enemy, collectible, save point";
  projectImportDraft = "";
  redoStack = [];
  selectedBrushSize = 1;
  selectedPaintMode = "tile";
  selectedCollisionMaterial = 1;
  selectedTileBrush = 1;
  spritePromptDraft = "Create an armored blue robot hero with a readable 16x16 silhouette.";
  undoStack = [];
  lastAgentSyncAt = null;
  lastAgentStreamAt = null;
  showRecoveryPanel = false;
  focusedGeneratedObjectId = null;
  generatedObjectFilter = "all";
  stopLivePlaytestTimer();
  previewSimulationState = null;
  lastPlaytestFeedback = null;
  agentGatewaySessionKey = DEFAULT_AGENT_GATEWAY_SESSION_KEY;
  agentTeamRun = null;
  agentTeamAutoCheckStarted = false;
  agentTeamReadinessReport = null;
  lastEventSimulation = null;
  sramSimulationSummary = "";
  audioPreviewSummary = "";
  liveAgentProofState = createDefaultLiveAgentProofState();
  liveAiProductionProofState = createDefaultLiveAiProductionProofState();
}

function selectPanel(host: HostUpdate, panel: SnesStudioPanel) {
  selectedPanel = panel;
  if (panel === "prompt") {
    selectedMode = "make";
  } else if (panel === "export") {
    selectedMode = "ship";
  } else if (panel === "scene" || panel === "assets" || panel === "story" || panel === "logic") {
    selectedMode = "edit";
  }
  host.requestUpdate?.();
}

function panelForSurface(surface: SnesAiAuthoringSurface): SnesStudioPanel {
  if (surface === "audio") {
    return "assets";
  }
  if (surface === "dialogue") {
    return "story";
  }
  if (surface === "save" || surface === "export") {
    return "export";
  }
  if (surface === "full-game") {
    return "project";
  }
  return "scene";
}

function loadProject(): SnesStudioProject {
  const stored = getSafeLocalStorage()?.getItem(STORAGE_KEY);
  if (!stored) {
    return normalizeSnesStudioProject(createDefaultSnesStudioProject());
  }
  try {
    const parsed = JSON.parse(stored) as SnesStudioProject;
    if (parsed?.schemaVersion === 1 && parsed.profile && parsed.assets && parsed.scenes) {
      return normalizeSnesStudioProject(parsed);
    }
  } catch {
    // Fall through to a clean project; corrupt local editor state must not brick the dashboard.
  }
  return normalizeSnesStudioProject(createDefaultSnesStudioProject());
}

function loadAgentDispatchQueue(): SnesAgentDispatchRecord[] {
  try {
    return parseSnesAgentDispatchQueue(
      getSafeLocalStorage()?.getItem(SNES_AGENT_DISPATCH_QUEUE_KEY) ?? null,
    );
  } catch {
    getSafeLocalStorage()?.removeItem(SNES_AGENT_DISPATCH_QUEUE_KEY);
    return [];
  }
}

function saveAgentDispatchQueue() {
  getSafeLocalStorage()?.setItem(SNES_AGENT_DISPATCH_QUEUE_KEY, JSON.stringify(agentDispatchQueue));
}

function loadAgentResultQueue(): SnesAgentResultRecord[] {
  try {
    return parseSnesAgentResultQueue(
      getSafeLocalStorage()?.getItem(SNES_AGENT_RESULT_QUEUE_KEY) ?? null,
    );
  } catch {
    getSafeLocalStorage()?.removeItem(SNES_AGENT_RESULT_QUEUE_KEY);
    return [];
  }
}

function saveAgentResultQueue() {
  getSafeLocalStorage()?.setItem(SNES_AGENT_RESULT_QUEUE_KEY, JSON.stringify(agentResultQueue));
}

function parseAgentStreamRecord(value: unknown): SnesAgentStreamRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const requestedAgent = record.requestedAgent === "codex" ? "codex" : "openclaw";
  const surface = String(record.surface ?? "full-game") as SnesAiAuthoringSurface;
  const knownSurfaces = new Set<SnesAiAuthoringSurface>([
    "full-game",
    "level",
    "player",
    "enemies",
    "items",
    "audio",
    "dialogue",
    "save",
    "export",
  ]);
  if (!id || !knownSurfaces.has(surface)) {
    return null;
  }
  const status =
    record.status === "complete" || record.status === "error" ? record.status : "streaming";
  return {
    id,
    recordId: typeof record.recordId === "string" ? record.recordId : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    requestedAgent,
    surface,
    status,
    chunk: typeof record.chunk === "string" ? record.chunk : undefined,
    responseText: typeof record.responseText === "string" ? record.responseText : undefined,
  };
}

function loadAgentStreamQueue(): SnesAgentStreamRecord[] {
  try {
    const parsed = JSON.parse(
      getSafeLocalStorage()?.getItem(SNES_AGENT_STREAM_QUEUE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) => {
          const record = parseAgentStreamRecord(entry);
          return record ? [record] : [];
        })
      : [];
  } catch {
    getSafeLocalStorage()?.removeItem(SNES_AGENT_STREAM_QUEUE_KEY);
    return [];
  }
}

function saveAgentStreamQueue() {
  getSafeLocalStorage()?.setItem(SNES_AGENT_STREAM_QUEUE_KEY, JSON.stringify(agentStreamRecords));
}

function normalizeAgentGatewaySessionKey(value: string) {
  const trimmed = value.trim();
  return trimmed || DEFAULT_AGENT_GATEWAY_SESSION_KEY;
}

function loadAgentGatewaySessionKey() {
  return normalizeAgentGatewaySessionKey(
    getSafeLocalStorage()?.getItem(SNES_AGENT_GATEWAY_SESSION_KEY) ?? "",
  );
}

function saveAgentGatewaySessionKey() {
  getSafeLocalStorage()?.setItem(SNES_AGENT_GATEWAY_SESSION_KEY, agentGatewaySessionKey);
}

function updateAgentGatewaySessionKey(host: HostUpdate, value: string) {
  agentGatewaySessionKey = normalizeAgentGatewaySessionKey(value);
  saveAgentGatewaySessionKey();
  host.requestUpdate?.();
}

function upsertAgentStreamRecord(host: HostUpdate, record: SnesAgentStreamRecord) {
  agentStreamRecords = [
    record,
    ...agentStreamRecords.filter((existing) => existing.id !== record.id),
  ].slice(0, 12);
  saveAgentStreamQueue();
  lastAgentStreamAt = new Date().toLocaleTimeString();
  host.requestUpdate?.();
}

function markAgentRunStream(
  host: HostUpdate,
  record: SnesAgentDispatchRecord,
  status: SnesAgentStreamRecord["status"],
  chunk: string,
  responseText?: string,
) {
  upsertAgentStreamRecord(host, {
    id: `run-${record.id}`,
    recordId: record.id,
    createdAt: new Date().toISOString(),
    requestedAgent: record.requestedAgent,
    surface: record.surface,
    status,
    chunk,
    responseText,
  });
}

function ingestAgentStreamRecord(host: HostUpdate, value: unknown) {
  const record = parseAgentStreamRecord(value);
  if (!record) {
    return;
  }
  agentStreamRecords = [
    record,
    ...agentStreamRecords.filter((existing) => existing.id !== record.id),
  ].slice(0, 12);
  saveAgentStreamQueue();
  lastAgentStreamAt = new Date().toLocaleTimeString();
  if (record.status === "complete" && record.responseText) {
    try {
      pendingAgentProposal = parseSnesAgentPatchProposalResponse(record.responseText, project);
      selectedPanel = "prompt";
      pushConsole(host, `Imported streamed ${record.requestedAgent} ${record.surface} patch.`);
      return;
    } catch {
      pushConsole(host, "Stream completed, but returned patch JSON needs manual review.");
    }
  }
  host.requestUpdate?.();
}

function syncAgentQueuesFromStorage(host: HostUpdate, announce = false) {
  agentDispatchQueue = loadAgentDispatchQueue();
  agentResultQueue = loadAgentResultQueue();
  agentStreamRecords = loadAgentStreamQueue();
  lastAgentSyncAt = new Date().toLocaleTimeString();
  if (announce) {
    pushConsole(
      host,
      `Synced ${agentDispatchQueue.length} queued task${agentDispatchQueue.length === 1 ? "" : "s"}, ${agentResultQueue.length} returned patch${agentResultQueue.length === 1 ? "" : "es"}, and ${agentStreamRecords.length} stream event${agentStreamRecords.length === 1 ? "" : "s"}.`,
    );
  } else {
    host.requestUpdate?.();
  }
}

function refreshAgentResults(host: HostUpdate) {
  syncAgentQueuesFromStorage(host);
  pushConsole(
    host,
    `Loaded ${agentResultQueue.length} OpenClaw/Codex result${agentResultQueue.length === 1 ? "" : "s"}.`,
  );
}

function ensureAgentResultListener(host: HostUpdate) {
  if (agentResultListenerInstalled || typeof globalThis.addEventListener !== "function") {
    return;
  }
  agentResultListenerInstalled = true;
  globalThis.addEventListener(SNES_AGENT_RESULT_EVENT, (event: Event) => {
    try {
      const [record] = parseSnesAgentResultQueue(JSON.stringify([(event as CustomEvent).detail]));
      if (!record) {
        return;
      }
      agentResultQueue = appendSnesAgentResultRecord(agentResultQueue, record);
      saveAgentResultQueue();
      host.requestUpdate?.();
    } catch {
      // Ignore malformed external agent events; the manual JSON import remains available.
    }
  });
  globalThis.addEventListener(SNES_AGENT_STREAM_EVENT, (event: Event) => {
    ingestAgentStreamRecord(host, (event as CustomEvent).detail);
  });
  globalThis.addEventListener("storage", (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (
      storageEvent.key === SNES_AGENT_RESULT_QUEUE_KEY ||
      storageEvent.key === SNES_AGENT_DISPATCH_QUEUE_KEY ||
      storageEvent.key === SNES_AGENT_STREAM_QUEUE_KEY
    ) {
      syncAgentQueuesFromStorage(host);
    }
  });
}

function loadProjectVersions(): SnesProjectVersion[] {
  try {
    return parseSnesProjectVersionHistory(
      getSafeLocalStorage()?.getItem(VERSION_HISTORY_KEY) ?? null,
    );
  } catch {
    getSafeLocalStorage()?.removeItem(VERSION_HISTORY_KEY);
    return [];
  }
}

function saveProjectVersions() {
  getSafeLocalStorage()?.setItem(VERSION_HISTORY_KEY, JSON.stringify(projectVersions));
}

function loadHistoryStack(key: string): string[] {
  try {
    const parsed = JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry === "string").slice(0, 30)
      : [];
  } catch {
    getSafeLocalStorage()?.removeItem(key);
    return [];
  }
}

function saveHistoryStacks() {
  getSafeLocalStorage()?.setItem(UNDO_STACK_KEY, JSON.stringify(undoStack.slice(0, 30)));
  getSafeLocalStorage()?.setItem(REDO_STACK_KEY, JSON.stringify(redoStack.slice(0, 30)));
}

function saveProject() {
  selectedSceneIndex = Math.min(selectedSceneIndex, Math.max(0, project.scenes.length - 1));
  project.updatedAt = new Date().toISOString();
  getSafeLocalStorage()?.setItem(STORAGE_KEY, JSON.stringify(project));
}

function selectedScene() {
  selectedSceneIndex = Math.min(selectedSceneIndex, Math.max(0, project.scenes.length - 1));
  return project.scenes[selectedSceneIndex];
}

function fullGamePromptLooksUserAuthored() {
  const prompt = surfacePromptDraft("full-game").trim();
  return prompt.length > 0 && !targetSurfaceDefaults().has(prompt);
}

function shouldCreateFullGamePromptBeforePlay() {
  const prompt = surfacePromptDraft("full-game").trim();
  if (!fullGamePromptLooksUserAuthored() || prompt === lastAppliedFullGamePrompt) {
    return false;
  }
  return (
    selectedCreateTarget === "full-game" || selectedMode === "make" || sceneIsEmptyStarterCanvas()
  );
}

function sceneNeedsPlayableTestContent() {
  const scene = selectedScene();
  if (!scene) {
    return true;
  }
  const hasHero = scene.entities.some((entity) => entity.kind === "player");
  const hasAnyThingToTest = scene.entities.some((entity) => entity.kind !== "player");
  return !hasHero || !hasAnyThingToTest || scene.collisionTiles === 0;
}

function sceneIsEmptyStarterCanvas() {
  const scene = selectedScene();
  if (!scene) {
    return true;
  }
  return (
    scene.entities.length === 0 &&
    scene.collisionTiles === 0 &&
    scene.tilemap.every((tile) => tile === 0)
  );
}

function rememberUndo() {
  undoStack = [stableProjectJson(project), ...undoStack].slice(0, 30);
  redoStack = [];
  saveHistoryStacks();
}

function restoreProjectFromJson(json: string) {
  const parsed = JSON.parse(json) as SnesStudioProject;
  if (parsed?.schemaVersion !== 1 || !parsed.profile || !parsed.assets || !parsed.scenes) {
    throw new Error("Stored SNES Studio history entry is not a valid project.");
  }
  project = normalizeSnesStudioProject(parsed);
  pendingAgentProposal = null;
  saveProject();
  saveHistoryStacks();
}

function restoreProjectVersion(host: HostUpdate, version: SnesProjectVersion) {
  rememberUndo();
  restoreProjectFromJson(version.projectJson);
  selectedPanel = "project";
  pushConsole(host, `Restored version ${version.reason} from ${version.createdAt}.`);
}

function undoProjectChange(host: HostUpdate) {
  const previous = undoStack[0];
  if (!previous) {
    pushConsole(host, "Nothing to undo.");
    return;
  }
  undoStack = undoStack.slice(1);
  redoStack = [stableProjectJson(project), ...redoStack].slice(0, 30);
  restoreProjectFromJson(previous);
  saveHistoryStacks();
  pushConsole(host, `Undid project change. Restored ${project.name}.`);
}

function redoProjectChange(host: HostUpdate) {
  const next = redoStack[0];
  if (!next) {
    pushConsole(host, "Nothing to redo.");
    return;
  }
  redoStack = redoStack.slice(1);
  undoStack = [stableProjectJson(project), ...undoStack].slice(0, 30);
  restoreProjectFromJson(next);
  saveHistoryStacks();
  pushConsole(host, `Redid project change. Restored ${project.name}.`);
}

function updateProject(host: HostUpdate, mutate: (draft: SnesStudioProject) => void) {
  rememberUndo();
  mutate(project);
  project = normalizeSnesStudioProject(project);
  saveProject();
  host.requestUpdate?.();
}

function pushConsole(host: HostUpdate, line: string) {
  consoleLines = [`${new Date().toLocaleTimeString()} ${line}`, ...consoleLines].slice(0, 8);
  host.requestUpdate?.();
}

function inputValue(event: Event): string {
  return (event.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value;
}

function inputNumber(event: Event): number {
  const value = Number(inputValue(event));
  return Number.isFinite(value) ? value : 0;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']"),
  );
}

function handleSnesStudioShortcut(event: KeyboardEvent) {
  const host = keyboardShortcutHost ?? {};
  const modifier = event.metaKey || event.ctrlKey;
  if (!modifier || isEditableKeyboardTarget(event.target)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "k") {
    event.preventDefault();
    selectedPanel = "prompt";
    pushConsole(host, "Shortcut opened AI Creator.");
  } else if (key === "b" && event.shiftKey) {
    event.preventDefault();
    finishPlayableDraft(host);
  } else if (key === "b") {
    event.preventDefault();
    createGameFromPrompt(host);
  } else if (key === "enter" && pendingAgentProposal) {
    event.preventDefault();
    approveAgentPatch(host);
  } else if (key === "z" && event.shiftKey) {
    event.preventDefault();
    redoProjectChange(host);
  } else if (key === "z") {
    event.preventDefault();
    undoProjectChange(host);
  }
}

function ensureKeyboardShortcuts(host: HostUpdate) {
  keyboardShortcutHost = host;
  if (keyboardShortcutsInstalled || typeof globalThis.addEventListener !== "function") {
    return;
  }
  keyboardShortcutsInstalled = true;
  globalThis.addEventListener("keydown", handleSnesStudioShortcut);
}

type DecodedRgbaImage = {
  width: number;
  height: number;
  rgba: number[];
};

function fileBaseName(file: File): string {
  return file.name.replace(/\.[^.]+$/u, "").trim() || file.name || "PNG Tileset";
}

function assertPngTilesetFile(file: File) {
  const hasPngName = /\.png$/iu.test(file.name);
  const hasPngType = file.type === "image/png";
  if (!hasPngName && !hasPngType) {
    throw new Error("Import a PNG tileset file.");
  }
}

function readRgbaFromImageSource(
  source: CanvasImageSource,
  width: number,
  height: number,
): DecodedRgbaImage {
  if (width <= 0 || height <= 0) {
    throw new Error("PNG tileset dimensions must be positive.");
  }
  if (width % 8 !== 0 || height % 8 !== 0) {
    throw new Error("PNG tileset dimensions must be multiples of 8 pixels.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Browser canvas image decoding is unavailable.");
  }
  context.drawImage(source, 0, 0);
  return {
    width,
    height,
    rgba: Array.from(context.getImageData(0, 0, width, height).data),
  };
}

async function decodePngTilesetFile(file: File): Promise<DecodedRgbaImage> {
  assertPngTilesetFile(file);
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);
    try {
      return readRgbaFromImageSource(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("PNG tileset decode failed."));
    });
    image.src = objectUrl;
    if (typeof image.decode === "function") {
      await image.decode().catch(() => loaded);
    } else {
      await loaded;
    }
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    return readRgbaFromImageSource(image, width, height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function surfacePromptDraft(surface: SnesAiAuthoringSurface): string {
  const existing = aiPromptDrafts[surface];
  if (existing) {
    return existing;
  }
  return (
    createSnesAiAuthoringPrompts(project).find((entry) => entry.surface === surface)?.placeholder ??
    ""
  );
}

function setAiActionFeedback(host: HostUpdate, feedback: Omit<SnesAiActionFeedback, "createdAt">) {
  lastAiActionFeedback = {
    ...feedback,
    createdAt: new Date().toISOString(),
  };
  host.requestUpdate?.();
}

function clearAiActionFeedback(host: HostUpdate) {
  lastAiActionFeedback = null;
  host.requestUpdate?.();
}

function updateAiPrompt(surface: SnesAiAuthoringSurface, value: string) {
  aiPromptDrafts = { ...aiPromptDrafts, [surface]: value };
  pendingAgentProposal = null;
  pendingInlineReviewObjectId = "";
}

function applyPromptChip(host: HostUpdate, prompt: string) {
  updateAiPrompt("full-game", prompt);
  selectedMode = "make";
  selectedPanel = "prompt";
  pushConsole(host, "Loaded a beginner prompt. Press Build My Game to generate it.");
}

function renderBeginnerPromptChips(host: HostUpdate, className = "") {
  return html`
    <div
      class=${`snes-prompt-chips${className ? ` ${className}` : ""}`}
      aria-label="Beginner prompt ideas"
    >
      ${beginnerPromptChips.map(
        (chip) => html`
          <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
            ${chip.label}
          </button>
        `,
      )}
    </div>
  `;
}

function applyPromptBrushPreset(host: HostUpdate, preset: (typeof promptBrushPresets)[number]) {
  updateAiPrompt("level", preset.prompt);
  paintLevelFromPrompt(host);
  pushConsole(host, `Applied ${preset.label} prompt brush.`);
}

function setAiProvider(
  host: HostUpdate,
  surface: SnesAiAuthoringSurface,
  provider: SnesAgentProvider,
) {
  aiProviderBySurface = { ...aiProviderBySurface, [surface]: provider };
  pushConsole(host, `${provider === "openclaw" ? "OpenClaw" : "Codex"} selected for ${surface}.`);
}

function selectedSceneThing(): SnesSelectedSceneThing | null {
  if (!focusedGeneratedObjectId?.includes(":")) {
    return null;
  }
  const [sceneId, entityId] = focusedGeneratedObjectId.split(":");
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  const entity = scene?.entities.find((candidate) => candidate.id === entityId);
  return scene && entity ? { scene, entity } : null;
}

function selectedThingSurface(entity: SnesSceneEntityDraft): SnesAiAuthoringSurface {
  if (entity.kind === "player") return "player";
  if (entity.kind === "enemy") return "enemies";
  if (entity.kind === "item") return "items";
  if (entity.kind === "npc") return "dialogue";
  return "level";
}

function selectedThingLabel(entity: SnesSceneEntityDraft): string {
  if (entity.kind === "player") return "Hero";
  if (entity.kind === "enemy") return "Enemy";
  if (entity.kind === "item") return "Item";
  if (entity.name.toLowerCase().includes("door")) return "Door";
  if (entity.name.toLowerCase().includes("goal")) return "Goal";
  if (entity.kind === "npc") return "Guide";
  return "Thing";
}

function aiGameStageSurface(): SnesAiAuthoringSurface {
  const selected = selectedSceneThing();
  return selected ? selectedThingSurface(selected.entity) : "full-game";
}

function aiGameStageResolvedProvider(surface: SnesAiAuthoringSurface = aiGameStageSurface()) {
  const defaultProvider = defaultSnesAgentProviderForSurface(surface);
  if (aiGameStageProvider === "openclaw") {
    return "openclaw";
  }
  if (aiGameStageProvider === "codex") {
    return surface === "export" ? "codex" : defaultProvider;
  }
  return defaultProvider;
}

function aiGameStageProviderLabel(provider: SnesAiGameStageProvider = aiGameStageProvider) {
  if (provider === "auto-team") return "Cost-aware Auto Team";
  return provider === "openclaw" ? "OpenClaw Workers" : "Codex Review Gate";
}

function setAiGameStageProvider(host: HostUpdate, provider: SnesAiGameStageProvider) {
  aiGameStageProvider = provider;
  const surface = aiGameStageSurface();
  aiProviderBySurface = { ...aiProviderBySurface, [surface]: aiGameStageResolvedProvider(surface) };
  pushConsole(
    host,
    `${aiGameStageProviderLabel(provider)} selected for the next AI production gate.`,
  );
}

function aiGameStagePromptLabel() {
  const selected = selectedSceneThing();
  return selected
    ? `Tell AI how to change this ${selectedThingLabel(selected.entity).toLowerCase()}`
    : "What SNES game do you want to make?";
}

function aiGameStagePromptPlaceholder() {
  const selected = selectedSceneThing();
  if (!selected) {
    return "Example: Make a cozy sky platformer with a robot hero, gentle enemies, gems, music, saves, and one beginner level.";
  }
  if (selected.entity.kind === "player") {
    return "Example: Make the hero jump higher and move a little faster.";
  }
  if (selected.entity.kind === "enemy") {
    return "Example: Make this enemy slower, patrol less, and easy to dodge.";
  }
  if (selected.entity.kind === "item") {
    return "Example: Turn this into a key that opens the next door.";
  }
  return "Example: Make this clearer and more useful to the player.";
}

function aiGameStagePromptDraft() {
  return surfacePromptDraft(aiGameStageSurface());
}

function updateAiGameStagePrompt(value: string) {
  updateAiPrompt(aiGameStageSurface(), value);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function defaultBehaviorForEntity(entity: SnesSceneEntityDraft): SnesEnemyBehavior {
  return {
    kind: entity.behavior?.kind ?? "patrol",
    speed: entity.behavior?.speed ?? 1,
    patrolStartX: entity.behavior?.patrolStartX ?? Math.max(0, entity.x - 48),
    patrolEndX: entity.behavior?.patrolEndX ?? Math.min(255, entity.x + 48),
    aggroRange: entity.behavior?.aggroRange ?? 56,
    guardDirection: entity.behavior?.guardDirection ?? -1,
  };
}

function quotedPromptName(prompt: string): string | null {
  const match = prompt.match(/["“]([^"”]{2,40})["”]/u);
  return match?.[1]?.trim() ?? null;
}

function promptWantsVisualChange(promptLower: string) {
  return [
    "look",
    "style",
    "graphic",
    "graphics",
    "round",
    "rounder",
    "color",
    "colorful",
    "shine",
    "sparkle",
    "sprite",
    "classic",
    "snes",
    "mario",
  ].some((term) => promptLower.includes(term));
}

function classicVisualRecipeForEntity(kind: SnesSceneEntityKind, promptLower = "") {
  if (kind === "enemy") {
    return promptLower.includes("fly") || promptLower.includes("drone")
      ? "round colorful flying enemy with bold outline and two-frame wing animation"
      : "round colorful patrol enemy with bold outline and readable feet";
  }
  if (kind === "item") {
    return promptLower.includes("key")
      ? "bright golden key item with sparkle highlight"
      : "sparkling gold collectible with bright highlight";
  }
  if (kind === "npc") {
    return "friendly guide sprite with clear outline and warm colors";
  }
  return "cheerful readable platform hero with bold outline, red cap, blue suit, and jump pose";
}

function applyPromptToSelectedThing(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) {
    createGameFromPrompt(host);
    return;
  }
  const surface = selectedThingSurface(selected.entity);
  const provider = aiGameStageResolvedProvider(surface);
  const prompt = surfacePromptDraft(surface).trim();
  const lower = prompt.toLowerCase();
  const changed: string[] = [];
  const selectedId = selected.entity.id;
  const selectedName = selected.entity.name;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes.find((scene) => scene.id === selected.scene.id);
    const entity = draftScene?.entities.find((candidate) => candidate.id === selectedId);
    if (!entity) {
      return;
    }
    const promptName = quotedPromptName(prompt);
    if (promptName) {
      entity.name = promptName;
      changed.push("renamed it");
    }
    if (lower.includes("left")) {
      entity.x = clampInteger(entity.x - 16, 0, (draftScene?.widthMetatiles ?? 16) * 16 - 8);
      changed.push("moved it left");
    }
    if (lower.includes("right")) {
      entity.x = clampInteger(entity.x + 16, 0, (draftScene?.widthMetatiles ?? 16) * 16 - 8);
      changed.push("moved it right");
    }
    if (lower.includes("up") || lower.includes("higher")) {
      entity.y = clampInteger(entity.y - 16, 0, (draftScene?.heightMetatiles ?? 12) * 16 - 8);
      changed.push("moved it higher");
    }
    if (lower.includes("down") || lower.includes("lower")) {
      entity.y = clampInteger(entity.y + 16, 0, (draftScene?.heightMetatiles ?? 12) * 16 - 8);
      changed.push("moved it lower");
    }
    if (entity.kind === "player") {
      if (lower.includes("jump") || lower.includes("higher")) {
        draft.physics.jumpVelocity = clampInteger(draft.physics.jumpVelocity - 2, -24, -4);
        changed.push("raised hero jump");
      }
      if (lower.includes("shorter jump") || lower.includes("less jump")) {
        draft.physics.jumpVelocity = clampInteger(draft.physics.jumpVelocity + 2, -24, -4);
        changed.push("softened hero jump");
      }
      if (lower.includes("fast")) {
        draft.physics.moveSpeed = clampInteger(draft.physics.moveSpeed + 1, 1, 8);
        changed.push("increased hero speed");
      }
      if (lower.includes("slow")) {
        draft.physics.moveSpeed = clampInteger(draft.physics.moveSpeed - 1, 1, 8);
        changed.push("reduced hero speed");
      }
    } else if (entity.kind === "enemy") {
      const behavior = defaultBehaviorForEntity(entity);
      if (lower.includes("slow")) {
        behavior.speed = clampInteger(behavior.speed - 1, 1, 8);
        changed.push("slowed enemy patrol");
      }
      if (lower.includes("fast")) {
        behavior.speed = clampInteger(behavior.speed + 1, 1, 8);
        changed.push("sped up enemy patrol");
      }
      if (lower.includes("chase")) {
        behavior.kind = "chase";
        behavior.aggroRange = Math.max(behavior.aggroRange, 80);
        changed.push("made it chase nearby heroes");
      } else if (lower.includes("guard")) {
        behavior.kind = "guard";
        changed.push("made it guard");
      } else if (lower.includes("patrol") || lower.includes("walk")) {
        behavior.kind = "patrol";
        changed.push("made it patrol");
      }
      if (lower.includes("short") || lower.includes("less")) {
        behavior.patrolStartX = clampInteger(
          entity.x - 24,
          0,
          (draftScene?.widthMetatiles ?? 16) * 16 - 8,
        );
        behavior.patrolEndX = clampInteger(
          entity.x + 24,
          0,
          (draftScene?.widthMetatiles ?? 16) * 16 - 8,
        );
        changed.push("shortened its patrol");
      }
      entity.behavior = behavior;
    } else if (entity.kind === "item") {
      if (lower.includes("key")) {
        entity.name = promptName ?? "Key";
        changed.push("made it a key item");
      } else if (lower.includes("health") || lower.includes("heart")) {
        entity.name = promptName ?? "Health Pickup";
        changed.push("made it restore health");
      } else if (lower.includes("coin") || lower.includes("gem")) {
        entity.name = promptName ?? "Gem";
        changed.push("made it a score pickup");
      }
    }
    if (promptWantsVisualChange(lower)) {
      const style = resolveSnesVisualStyleFromPrompt(prompt || "classic colorful SNES platformer");
      entity.visualRecipe = classicVisualRecipeForEntity(entity.kind, lower);
      entity.metaspriteTiles = Math.max(entity.metaspriteTiles, entity.kind === "item" ? 2 : 8);
      draft.visualStylePreset = style.visualStylePreset;
      draft.artDirection = style.artDirection;
      draft.assetProvenance = style.assetProvenance;
      draft.styleWarnings = style.styleWarnings;
      changed.push("updated its classic visual recipe");
    }
  });
  hotReloadRuntimeAfterEdit(
    host,
    "AI changed one thing",
    `${aiGameStageProviderLabel()} changed only ${selectedName}. The 60 Hz playtest is updated now.`,
  );
  setAiActionFeedback(host, {
    status: "ready",
    title: "Selected thing changed",
    detail: `${provider === "openclaw" ? "OpenClaw Agent" : "Codex"} applied a scoped change to ${selectedName}: ${changed.length > 0 ? changed.join(", ") : "kept the scope safe and ready to test"}.`,
    provider,
    target: selectedThingLabel(selected.entity),
  });
  guidedReceipt = {
    title: "Selected thing changed",
    detail: `${aiGameStageProviderLabel(provider)} changed only ${selectedName}: ${changed.length > 0 ? changed.join(", ") : "scope stayed safe"}.`,
    next: "Playtest now to feel the change.",
  };
  pushConsole(host, `Scoped AI change applied to ${selectedName}.`);
}

function changeSelectedThingLookWithAi(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) return;
  const prompt =
    selected.entity.kind === "enemy"
      ? "Make this enemy rounder and colorful with a classic SNES platformer look."
      : selected.entity.kind === "item"
        ? "Make this item shine with a classic colorful SNES platformer look."
        : selected.entity.kind === "player"
          ? "Make the hero clearer, colorful, and readable like an original classic SNES platformer character."
          : "Make this guide clearer and colorful with an original classic SNES platformer look.";
  updateAiPrompt(selectedThingSurface(selected.entity), prompt);
  applyPromptToSelectedThing(host);
}

function runAiGameStageCommand(host: HostUpdate) {
  const selected = selectedSceneThing();
  const surface = selected ? selectedThingSurface(selected.entity) : "full-game";
  aiProviderBySurface = { ...aiProviderBySurface, [surface]: aiGameStageResolvedProvider(surface) };
  if (selected) {
    applyPromptToSelectedThing(host);
    return;
  }
  createGameFromPrompt(host);
}

function scrollGuidedStepIntoView(step: SnesGuidedGameStep) {
  const selector =
    step === "playtest"
      ? ".snes-guided-playtest"
      : step === "export"
        ? ".snes-guided-export"
        : ".snes-guided-workspace";
  const scroll = () => {
    const element = globalThis.document?.querySelector<HTMLElement>(selector);
    if (typeof element?.scrollIntoView === "function") {
      element.scrollIntoView({ block: "start", behavior: "auto" });
    }
  };
  globalThis.requestAnimationFrame?.(() => globalThis.requestAnimationFrame?.(scroll));
  globalThis.setTimeout?.(scroll, 48);
}

function setGuidedStep(host: HostUpdate, step: SnesGuidedGameStep) {
  selectedGuidedStep = step;
  selectedMode =
    step === "export" ? "ship" : step === "playtest" ? "play" : step === "idea" ? "make" : "edit";
  if (step === "build-level" || step === "playtest") {
    selectedPanel = "scene";
  } else if (step === "export") {
    selectedPanel = "export";
  } else {
    selectedPanel = "prompt";
  }
  host.requestUpdate?.();
  scrollGuidedStepIntoView(step);
}

function guidedStepItems(): Array<{
  id: SnesGuidedGameStep;
  label: string;
  detail: string;
  status: "current" | "done" | "next";
}> {
  const order: SnesGuidedGameStep[] = [
    "idea",
    "game-plan",
    "build-level",
    "make-things",
    "playtest",
    "export",
  ];
  const labels: Record<SnesGuidedGameStep, { label: string; detail: string }> = {
    idea: { label: "Idea", detail: "Your prompt" },
    "game-plan": { label: "Game Plan", detail: "AI made the game" },
    "build-level": { label: "Build Levels", detail: "Playable chapters" },
    "make-things": { label: "Make Things", detail: "Hero, enemies, rewards" },
    playtest: { label: "Play & Change", detail: "Select the emulator" },
    export: { label: "Create Game File", detail: "Export when ready" },
  };
  const currentIndex = order.indexOf(selectedGuidedStep);
  const hasPlayableDraft = lastAppliedFullGamePrompt.trim().length > 0 || previewSimulationState;
  return order.map((id, index) => ({
    id,
    ...labels[id],
    status:
      id === selectedGuidedStep
        ? "current"
        : hasPlayableDraft && index < Math.max(currentIndex, 1)
          ? "done"
          : "next",
  }));
}

function guidedThingSurface(kind: SnesGuidedThingKind): SnesAiAuthoringSurface {
  if (kind === "hero") return "player";
  if (kind === "enemy") return "enemies";
  if (kind === "item" || kind === "powerup" || kind === "coin-trail") return "items";
  if (kind === "music") return "audio";
  if (kind === "level" || kind === "platform" || kind === "block" || kind === "hazard") {
    return "level";
  }
  return "level";
}

function guidedThingLibraryKind(
  kind: SnesGuidedThingKind,
): NonNullable<SnesStudioProject["thingLibrary"]>[number]["kind"] {
  if (kind === "platform") return "block";
  if (kind === "coin-trail") return "item";
  if (kind === "level" || kind === "music") return "item";
  return kind;
}

function guidedThingLabel(kind: SnesGuidedThingKind) {
  const labels: Record<SnesGuidedThingKind, string> = {
    hero: "Hero",
    enemy: "Enemy",
    item: "Item",
    powerup: "Powerup",
    block: "Block",
    platform: "Platform",
    door: "Door",
    goal: "Goal",
    hazard: "Danger",
    "coin-trail": "Coin Trail",
    music: "Music",
    level: "Level",
  };
  return labels[kind];
}

function guidedThingKindFromPrompt(prompt: string): SnesGuidedThingKind {
  const lower = prompt.toLowerCase();
  if (lower.includes("music") || lower.includes("song") || lower.includes("theme")) return "music";
  if (lower.includes("level") || lower.includes("stage") || lower.includes("map")) return "level";
  if (lower.includes("hero") || lower.includes("player") || lower.includes("character")) {
    return "hero";
  }
  if (lower.includes("boss") || lower.includes("enemy") || lower.includes("turtle")) return "enemy";
  if (lower.includes("power") || lower.includes("mushroom") || lower.includes("upgrade")) {
    return "powerup";
  }
  if (lower.includes("coin trail") || lower.includes("trail")) return "coin-trail";
  if (lower.includes("coin") || lower.includes("gem") || lower.includes("key")) return "item";
  if (lower.includes("door") || lower.includes("pipe") || lower.includes("portal")) return "door";
  if (lower.includes("goal") || lower.includes("flag") || lower.includes("finish")) return "goal";
  if (lower.includes("spike") || lower.includes("lava") || lower.includes("hazard"))
    return "hazard";
  if (lower.includes("platform")) return "platform";
  if (lower.includes("block") || lower.includes("ground")) return "block";
  return "enemy";
}

function guidedThingNameFromPrompt(prompt: string, kind: SnesGuidedThingKind) {
  const quoted = quotedPromptName(prompt);
  if (quoted) return quoted;
  const lower = prompt.toLowerCase();
  if (kind === "enemy" && (lower.includes("turtle") || lower.includes("shell"))) {
    return "Shell Walker";
  }
  if (kind === "enemy" && lower.includes("boss")) return "First Boss";
  if (kind === "hero" && lower.includes("robot")) return "Robot Hero";
  if (kind === "item" && lower.includes("gem")) return "Gem";
  if (kind === "item" && lower.includes("key")) return "Key";
  if (kind === "powerup") return "Powerup";
  if (kind === "music") return "Main Theme";
  if (kind === "level") return `Level ${project.scenes.length + 1}`;
  return guidedThingLabel(kind);
}

function markGuidedAiResult(
  host: HostUpdate,
  provider: SnesAgentProvider,
  scope: SnesAiAuthoringSurface | "selected-thing" | "thing-library",
  summary: string,
  changed: string[],
  suggestedTest: string,
) {
  project.aiCommandResult = {
    provider,
    scope,
    summary,
    changed,
    unchanged: ["Expert hardware settings stayed protected."],
    undoToken: undoStack[0] ? "latest-undo" : undefined,
    suggestedTest,
  };
  guidedReceipt = {
    title: summary,
    detail: `${aiGameStageProviderLabel(provider)} changed ${changed.join(", ")}.`,
    next: suggestedTest,
  };
  saveProject();
  host.requestUpdate?.();
}

async function createGuidedPlatformerDraft(host: HostUpdate) {
  const prompt = surfacePromptDraft("full-game").trim();
  if (!prompt) {
    updateAiPrompt(
      "full-game",
      'Make "Sky Robot Quest", a story-driven robot platformer with three levels, gems, a rival drone, a hidden key, and a mountain ending.',
    );
  }
  aiProviderBySurface = { ...aiProviderBySurface, "full-game": aiGameStageResolvedProvider() };
  if (!createPlayableDraftFromPrompt(host, "create")) {
    return;
  }
  selectedGuidedStep = "game-plan";
  selectedMode = "edit";
  selectedPanel = "prompt";
  previewSimulationState = initializeRuntimeState();
  const liveOpenClawReady =
    isGatewayLiveReady(host) && liveAiProductionProofState.status === "passed";
  markGuidedAiResult(
    host,
    "openclaw",
    "full-game",
    liveOpenClawReady ? "Live OpenClaw-ready game built" : "Local OpenClaw fallback game built",
    [
      "a Codex blueprint",
      "OpenClaw-filled text boxes",
      "Codex quality review",
      "a story map",
      "level chapters",
      "a hero",
      "villain and enemies",
      "items and rules",
      "a playable first level",
    ],
    liveOpenClawReady
      ? "Live OpenClaw workers are ready; SNES Studio is also requesting the staged Codex/OpenClaw production review."
      : "Used local OpenClaw fallback because live proof has not passed yet. You can still play, edit, and export.",
  );
  if (liveOpenClawReady) {
    await runLiveAiProductionProof(host);
  }
}

function addGuidedThingToLevel(
  host: HostUpdate,
  kind: SnesGuidedThingKind,
  position?: { x: number; y: number },
  prompt = guidedThingPromptDraft,
) {
  const scene = selectedScene();
  if (!scene) return null;
  const name = guidedThingNameFromPrompt(prompt, kind);
  const safeId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || guidedThingLabel(kind);
  const createdId = `${safeId}-${Date.now()}`;
  if (kind === "hero" || kind === "enemy" || kind === "item" || kind === "powerup") {
    const entityKind: SnesSceneEntityKind =
      kind === "hero" ? "player" : kind === "enemy" ? "enemy" : "item";
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (!draftScene) return;
      if (kind === "hero") {
        draftScene.entities = draftScene.entities.filter((entity) => entity.kind !== "player");
      }
      draftScene.entities.push({
        id: createdId,
        kind: entityKind,
        name,
        x: position?.x ?? (kind === "hero" ? 32 : kind === "enemy" ? 176 : 128),
        y: position?.y ?? (kind === "item" || kind === "powerup" ? 112 : 176),
        metaspriteTiles: kind === "item" || kind === "powerup" ? 2 : 8,
        visualRecipe: classicVisualRecipeForEntity(entityKind, prompt.toLowerCase()),
        behavior:
          kind === "enemy"
            ? {
                kind: "patrol",
                speed: 1,
                patrolStartX: Math.max(0, (position?.x ?? 176) - 32),
                patrolEndX: Math.min(draftScene.widthMetatiles * 16 - 1, (position?.x ?? 176) + 32),
                aggroRange: 56,
                guardDirection: -1,
              }
            : undefined,
      });
    });
    focusedGeneratedObjectId = `${scene.id}:${createdId}`;
    return name;
  }
  if (kind === "door" || kind === "goal") {
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (!draftScene) return;
      draftScene.entities.push({
        id: createdId,
        kind: kind === "goal" ? "item" : "npc",
        name,
        x: position?.x ?? (kind === "goal" ? 224 : 192),
        y: position?.y ?? (kind === "goal" ? 112 : 160),
        metaspriteTiles: kind === "goal" ? 2 : 4,
        visualRecipe: classicVisualRecipeForEntity(
          kind === "goal" ? "item" : "npc",
          prompt.toLowerCase(),
        ),
      });
    });
    focusedGeneratedObjectId = `${scene.id}:${createdId}`;
    return name;
  }
  if (kind === "coin-trail") {
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (!draftScene) return;
      const startX = position?.x ?? 96;
      for (let index = 0; index < 5; index += 1) {
        draftScene.entities.push({
          id: `${createdId}-${index + 1}`,
          kind: "item",
          name: `${name} ${index + 1}`,
          x: startX + index * 24,
          y: position?.y ?? 112,
          metaspriteTiles: 2,
        });
      }
    });
    return name;
  }
  const activeScene = selectedScene();
  const sceneWidth = activeScene?.widthMetatiles ?? SNES_STUDIO_EDIT_GRID.width;
  const sceneHeight = activeScene?.heightMetatiles ?? SNES_STUDIO_EDIT_GRID.height;
  const column = clampInteger(Math.floor((position?.x ?? 112) / 16), 0, sceneWidth - 1);
  const row = clampInteger(Math.floor((position?.y ?? 160) / 16), 0, sceneHeight - 1);
  const tile = kind === "hazard" ? 4 : 1;
  const collision = kind === "hazard" ? 2 : 1;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes[selectedSceneIndex];
    if (!draftScene) return;
    const width = kind === "hazard" ? 2 : 4;
    for (let offset = 0; offset < width; offset += 1) {
      const nextColumn = clampInteger(column + offset, 0, draftScene.widthMetatiles - 1);
      const index = row * draftScene.widthMetatiles + nextColumn;
      draftScene.tilemap[index] = tile;
      draftScene.collisionMap[index] = collision as SnesCollisionMaterial;
    }
    draftScene.collisionTiles = draftScene.collisionMap.filter((cell) => cell > 0).length;
  });
  return name;
}

function createGuidedThingFromPrompt(host: HostUpdate) {
  const prompt = guidedThingPromptDraft.trim();
  if (!prompt) {
    guidedReceipt = {
      title: "Tell AI what to make",
      detail: "Type a hero, enemy, item, level, music, block, goal, or powerup idea first.",
      next: "Example: Create a slow turtle enemy called Shell Walker.",
    };
    host.requestUpdate?.();
    return;
  }
  const kind = guidedThingKindFromPrompt(prompt);
  const name = guidedThingNameFromPrompt(prompt, kind);
  const provider = aiGameStageResolvedProvider(guidedThingSurface(kind));
  if (kind === "music") {
    updateProject(host, (draft) => {
      draft.assets.audio.musicTracks = [
        ...draft.assets.audio.musicTracks,
        {
          id: `music-${Date.now()}`,
          name,
          tempo: prompt.toLowerCase().includes("fast") ? 146 : 126,
          patternRows: 96,
          estimatedBytes: 6144,
        },
      ];
    });
  } else if (kind === "level") {
    updateAiPrompt("level", prompt);
    addLevel(host);
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (draftScene) {
        draftScene.name = name;
      }
      draft.levelPlan = {
        id: `level-plan-${Date.now()}`,
        name,
        summary: prompt,
        chunks: ["safe start", "one readable jump", "reward", "finish"],
        goal: "Reach the end after testing the route.",
      };
    });
    paintLevelFromPrompt(host);
  } else {
    addGuidedThingToLevel(host, kind, undefined, prompt);
  }
  updateProject(host, (draft) => {
    const entryKind = guidedThingLibraryKind(kind);
    const existing = draft.thingLibrary ?? [];
    draft.thingLibrary = [
      ...existing,
      {
        id: `thing-${Date.now()}`,
        kind: entryKind,
        name,
        prompt,
        behavior:
          kind === "enemy"
            ? "Patrols a short readable path."
            : kind === "powerup"
              ? "Changes the hero when collected."
              : kind === "hazard"
                ? "Hurts the hero on contact."
                : "Ready to place, test, and tune.",
      },
    ];
  });
  previewSimulationState = null;
  selectedGuidedStep = "playtest";
  selectedMode = "play";
  selectedPanel = "scene";
  startPreviewPlaytest(host, false, true);
  markGuidedAiResult(
    host,
    provider,
    kind === "music" ? "audio" : kind === "level" ? "level" : "thing-library",
    `${name} created`,
    [guidedThingLabel(kind).toLowerCase(), "editable library entry", "playtest update"],
    "Playtest now. If it feels wrong, click it or ask AI to change it.",
  );
}

function duplicateSelectedThing(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) return;
  const copyId = `${selected.entity.id}-copy-${Date.now().toString(36)}`;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes.find((scene) => scene.id === selected.scene.id);
    const entity = draftScene?.entities.find((candidate) => candidate.id === selected.entity.id);
    if (!draftScene || !entity) return;
    draftScene.entities.push({
      ...entity,
      id: copyId,
      name: `${entity.name} Copy`,
      x: clampInteger(entity.x + 24, 0, draftScene.widthMetatiles * 16 - 8),
    });
  });
  focusedGeneratedObjectId = `${selected.scene.id}:${copyId}`;
  pushConsole(host, `Duplicated ${selected.entity.name}.`);
}

function deleteSelectedThing(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) return;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes.find((scene) => scene.id === selected.scene.id);
    if (!draftScene) return;
    draftScene.entities = draftScene.entities.filter((entity) => entity.id !== selected.entity.id);
  });
  focusedGeneratedObjectId = null;
  pushConsole(host, `Deleted ${selected.entity.name}.`);
}

function updateSelectedEntityField(
  host: HostUpdate,
  field: "name" | "x" | "y",
  value: string | number,
) {
  const selected = selectedSceneThing();
  if (!selected) return;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes.find((scene) => scene.id === selected.scene.id);
    const entity = draftScene?.entities.find((candidate) => candidate.id === selected.entity.id);
    if (!entity || !draftScene) return;
    if (field === "name") {
      entity.name = String(value).slice(0, 48);
      return;
    }
    const limit =
      field === "x" ? draftScene.widthMetatiles * 16 - 8 : draftScene.heightMetatiles * 16 - 8;
    entity[field] = clampInteger(Number(value), 0, limit);
  });
}

function updateHeroPhysics(host: HostUpdate, field: "moveSpeed" | "jumpVelocity", value: number) {
  updateProject(host, (draft) => {
    draft.physics[field] =
      field === "moveSpeed" ? clampInteger(value, 1, 8) : clampInteger(value, -24, -4);
  });
  lastPlaytestFeedback = {
    tone: "ready",
    title: field === "moveSpeed" ? "Hero speed changed" : "Hero jump changed",
    detail: "Press Test Now to feel the gameplay change.",
  };
}

function updateSelectedEnemyBehavior(
  host: HostUpdate,
  field: "kind" | "speed" | "patrolStartX" | "patrolEndX" | "aggroRange",
  value: string | number,
) {
  const selected = selectedSceneThing();
  if (!selected || selected.entity.kind !== "enemy") return;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes.find((scene) => scene.id === selected.scene.id);
    const entity = draftScene?.entities.find((candidate) => candidate.id === selected.entity.id);
    if (!entity || entity.kind !== "enemy") return;
    const behavior = defaultBehaviorForEntity(entity);
    if (field === "kind") {
      behavior.kind = value as SnesEnemyBehaviorKind;
    } else if (field === "speed") {
      behavior.speed = clampInteger(Number(value), 1, 8);
    } else if (field === "patrolStartX") {
      behavior.patrolStartX = clampInteger(
        Number(value),
        0,
        (draftScene?.widthMetatiles ?? 16) * 16 - 8,
      );
    } else if (field === "patrolEndX") {
      behavior.patrolEndX = clampInteger(
        Number(value),
        0,
        (draftScene?.widthMetatiles ?? 16) * 16 - 8,
      );
    } else {
      behavior.aggroRange = clampInteger(Number(value), 16, 240);
    }
    entity.behavior = behavior;
  });
}

function setAudioByteBudget(draft: SnesStudioProject, totalBytes: number) {
  const audio = draft.assets.audio;
  const authoredBytes =
    audio.aramReservedBytes +
    audio.musicTracks.reduce((sum, track) => sum + track.estimatedBytes, 0) +
    audio.soundEffects.reduce((sum, effect) => sum + effect.estimatedBytes, 0);
  draft.assets.audioBytes = totalBytes;
  audio.sampleBytes = Math.max(0, totalBytes - authoredBytes);
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${value} B`;
}

function bytesToBlobPart(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatMeterValue(meter: SnesBudgetMeter): string {
  if (meter.unit === "bytes") {
    return `${formatBytes(meter.used)} / ${formatBytes(meter.limit)}`;
  }
  return `${meter.used} / ${meter.limit} ${meter.unit}`;
}

function formatPatchValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (!rendered) {
    return "null";
  }
  return rendered.length > 92 ? `${rendered.slice(0, 89)}...` : rendered;
}

function formatEventAction(action: SnesEventScript["actions"][number]): string {
  if (action.type === "give-item") {
    return `Give item ${action.itemId}`;
  }
  if (action.type === "set-flag") {
    return `Set flag ${action.flag}`;
  }
  return `Show dialogue ${action.cutsceneId}`;
}

function addEntity(host: HostUpdate, kind: SnesSceneEntityKind) {
  const scene = selectedScene();
  if (!scene) {
    return;
  }
  updateProject(host, () => {
    const draftScene = project.scenes[selectedSceneIndex];
    if (!draftScene) {
      return;
    }
    const count = draftScene.entities.filter((entity) => entity.kind === kind).length + 1;
    draftScene.entities.push({
      id: `${kind}-${Date.now()}`,
      kind,
      name:
        kind === "enemy"
          ? `Patrol Enemy ${count}`
          : kind === "item"
            ? `Collectible ${count}`
            : `NPC ${count}`,
      x: 64 + count * 48,
      y: kind === "item" ? 112 : 176,
      metaspriteTiles: kind === "item" ? 2 : 8,
    });
  });
  pushConsole(host, `Added ${kind} entity to ${scene.name}.`);
}

function addScenePalettePiece(
  host: HostUpdate,
  piece: SnesScenePalettePiece,
  position?: { x: number; y: number },
) {
  const scene = selectedScene();
  if (!scene) {
    return;
  }
  const pieceConfig: Record<
    SnesScenePalettePiece,
    {
      baseName: string;
      kind: SnesSceneEntityKind;
      metaspriteTiles: number;
      defaultX: number;
      defaultY: number;
    }
  > = {
    hero: {
      baseName: "Player Start",
      kind: "player",
      metaspriteTiles: 8,
      defaultX: 32,
      defaultY: 176,
    },
    enemy: {
      baseName: "Patrol Enemy",
      kind: "enemy",
      metaspriteTiles: 8,
      defaultX: 144,
      defaultY: 176,
    },
    item: {
      baseName: "Collectible",
      kind: "item",
      metaspriteTiles: 2,
      defaultX: 112,
      defaultY: 112,
    },
    door: {
      baseName: "Door",
      kind: "npc",
      metaspriteTiles: 4,
      defaultX: 192,
      defaultY: 160,
    },
    goal: {
      baseName: "Goal",
      kind: "item",
      metaspriteTiles: 2,
      defaultX: 224,
      defaultY: 112,
    },
    guide: {
      baseName: "Guide",
      kind: "npc",
      metaspriteTiles: 4,
      defaultX: 144,
      defaultY: 176,
    },
  };
  const config = pieceConfig[piece];
  let createdFocusId: string | null = null;
  updateProject(host, (draft) => {
    const draftScene = draft.scenes[selectedSceneIndex];
    if (!draftScene) {
      return;
    }
    const count =
      draftScene.entities.filter((entity) => entity.name.startsWith(config.baseName)).length + 1;
    const entity = {
      id: `${config.baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
      kind: config.kind,
      name: `${config.baseName} ${count}`,
      x: position?.x ?? config.defaultX + Math.min(count - 1, 3) * 24,
      y: position?.y ?? config.defaultY,
      metaspriteTiles: config.metaspriteTiles,
    };
    draftScene.entities.push(entity);
    createdFocusId = `${draftScene.id}:${entity.id}`;
  });
  focusedGeneratedObjectId = createdFocusId;
  selectedCreateTarget = "selected-object";
  hotReloadRuntimeAfterEdit(
    host,
    `${config.baseName} added`,
    "This new game thing is now in the 60 Hz playtest.",
  );
  pushConsole(host, `Added ${config.baseName.toLowerCase()} to ${scene.name}.`);
}

function defaultEnemyBehaviorForEntity(
  entity: SnesStudioProject["scenes"][number]["entities"][number],
): SnesEnemyBehavior {
  return {
    kind: "patrol",
    speed: 1,
    patrolStartX: Math.max(0, entity.x - 32),
    patrolEndX: entity.x + 32,
    aggroRange: 48,
    guardDirection: 1,
  };
}

function updateEnemyBehavior(
  host: HostUpdate,
  entityIndex: number,
  mutate: (behavior: SnesEnemyBehavior) => void,
) {
  updateProject(host, (draft) => {
    const entity = draft.scenes[selectedSceneIndex]?.entities[entityIndex];
    if (!entity || entity.kind !== "enemy") {
      return;
    }
    entity.behavior = entity.behavior ?? defaultEnemyBehaviorForEntity(entity);
    mutate(entity.behavior);
  });
}

function selectTileBrush(host: HostUpdate, tile: SnesTileBrush) {
  selectedTileBrush = tile;
  selectedPaintMode = "tile";
  pushConsole(host, `Selected tile brush ${tile}.`);
}

function selectPaintMode(host: HostUpdate, mode: typeof selectedPaintMode) {
  selectedPaintMode = mode;
  pushConsole(host, `Selected ${mode} paint mode.`);
}

function selectBrushSize(host: HostUpdate, size: number) {
  selectedBrushSize = Math.max(1, Math.min(4, Math.round(size)));
  pushConsole(host, `Selected ${selectedBrushSize}x${selectedBrushSize} brush.`);
}

function selectCollisionMaterial(host: HostUpdate, material: SnesCollisionMaterial) {
  selectedCollisionMaterial = material;
  selectedPaintMode = "collision";
  const label =
    material === 0
      ? "passable"
      : material === 1
        ? "solid"
        : material === 2
          ? "hazard"
          : material === 3
            ? "one-way"
            : "water";
  pushConsole(host, `Selected ${label} collision material.`);
}

type SnesBeginnerBrush = {
  id: "danger" | "erase" | "ground" | "water";
  label: string;
  detail: string;
};

function beginnerBrushes(): SnesBeginnerBrush[] {
  return [
    { id: "ground", label: "Ground", detail: "The hero stands here." },
    { id: "danger", label: "Danger", detail: "Hurts the hero." },
    { id: "water", label: "Water", detail: "Slows or changes movement." },
    { id: "erase", label: "Erase", detail: "Clear a square." },
  ];
}

function currentBeginnerBrushId(): SnesBeginnerBrush["id"] {
  if (selectedPaintMode === "collision" && selectedCollisionMaterial === 2) {
    return "danger";
  }
  if (selectedPaintMode === "collision" && selectedCollisionMaterial === 4) {
    return "water";
  }
  if (selectedPaintMode === "tile" && selectedTileBrush === 0) {
    return "erase";
  }
  return "ground";
}

function currentBeginnerBrushLabel() {
  const current = currentBeginnerBrushId();
  return beginnerBrushes().find((brush) => brush.id === current)?.label ?? "Ground";
}

function selectBeginnerBrush(host: HostUpdate, brush: SnesBeginnerBrush["id"]) {
  if (brush === "ground") {
    selectTileBrush(host, 1);
    return;
  }
  if (brush === "erase") {
    selectTileBrush(host, 0);
    return;
  }
  if (brush === "danger") {
    selectCollisionMaterial(host, 2);
    return;
  }
  selectCollisionMaterial(host, 4);
}

function importedTileBrushes(): Array<[number, string]> {
  let tile = SNES_IMPORTED_TILE_BRUSH_BASE;
  return [
    ...project.assets.customTileBrushes.map((brush): [number, string] => [brush.tile, brush.name]),
    ...project.assets.importedTilesets.flatMap((tileset) =>
      Array.from({ length: tileset.uniqueTileCount }, (_, index): [number, string] => [
        tile++,
        `${tileset.name} ${index + 1}`,
      ]),
    ),
  ];
}

function paintSceneCell(host: HostUpdate, cellIndex: number) {
  try {
    const scene = selectedScene();
    const tile =
      selectedPaintMode === "collision" ? (scene?.tilemap[cellIndex] ?? 0) : selectedTileBrush;
    const collisionMaterial =
      selectedPaintMode === "collision"
        ? selectedCollisionMaterial
        : selectedTileBrush === 1 || selectedTileBrush === 2
          ? 1
          : 0;
    const column = cellIndex % SNES_STUDIO_EDIT_GRID.width;
    const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
    rememberUndo();
    project =
      selectedBrushSize === 1
        ? paintSnesSceneCell(
            project,
            selectedSceneIndex,
            cellIndex,
            tile,
            collisionMaterial > 0,
            collisionMaterial as SnesCollisionMaterial,
          )
        : paintSnesSceneRect(
            project,
            selectedSceneIndex,
            column,
            row,
            selectedBrushSize,
            selectedBrushSize,
            tile,
            collisionMaterial > 0,
            collisionMaterial as SnesCollisionMaterial,
          );
    saveProject();
    pushConsole(
      host,
      selectedPaintMode === "collision"
        ? `Painted ${selectedBrushSize}x${selectedBrushSize} collision brush at cell ${cellIndex} with material ${collisionMaterial}.`
        : `Painted ${selectedBrushSize}x${selectedBrushSize} tile brush at cell ${cellIndex} with tile ${selectedTileBrush}.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Tile paint failed.");
  }
}

function fillCurrentLayer(host: HostUpdate) {
  try {
    if (selectedPaintMode === "collision") {
      updateProject(host, (draft) => {
        const scene = draft.scenes[selectedSceneIndex];
        if (!scene) {
          return;
        }
        scene.collisionMap = Array.from(
          { length: SNES_STUDIO_EDIT_GRID.cells },
          () => selectedCollisionMaterial,
        );
        scene.collisionTiles = selectedCollisionMaterial > 0 ? SNES_STUDIO_EDIT_GRID.cells : 0;
      });
      pushConsole(host, `Filled collision layer with material ${selectedCollisionMaterial}.`);
      return;
    }
    const collisionMaterial = selectedTileBrush === 1 || selectedTileBrush === 2 ? 1 : 0;
    rememberUndo();
    project = paintSnesSceneRect(
      project,
      selectedSceneIndex,
      0,
      0,
      SNES_STUDIO_EDIT_GRID.width,
      SNES_STUDIO_EDIT_GRID.height,
      selectedTileBrush,
      collisionMaterial > 0,
      collisionMaterial as SnesCollisionMaterial,
    );
    saveProject();
    pushConsole(host, `Filled tile layer with tile ${selectedTileBrush}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Layer fill failed.");
  }
}

function clearCurrentLayer(host: HostUpdate) {
  try {
    rememberUndo();
    project = paintSnesSceneRect(
      project,
      selectedSceneIndex,
      0,
      0,
      SNES_STUDIO_EDIT_GRID.width,
      SNES_STUDIO_EDIT_GRID.height,
      0,
      false,
      0,
    );
    saveProject();
    pushConsole(host, "Cleared the active edit grid to passable air.");
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Layer clear failed.");
  }
}

function fillGroundBand(host: HostUpdate) {
  try {
    rememberUndo();
    project = paintSnesSceneRect(
      project,
      selectedSceneIndex,
      0,
      8,
      SNES_STUDIO_EDIT_GRID.width,
      4,
      1,
      true,
      1,
    );
    saveProject();
    pushConsole(host, "Filled the lower collision band with solid ground tiles.");
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Rectangle fill failed.");
  }
}

function paintLevelFromPrompt(host: HostUpdate) {
  try {
    const prompt =
      `${surfacePromptDraft("level")} ${surfacePromptDraft("full-game")}`.toLowerCase();
    rememberUndo();
    project = paintSnesSceneRect(
      project,
      selectedSceneIndex,
      0,
      0,
      SNES_STUDIO_EDIT_GRID.width,
      12,
      0,
      false,
      0,
    );
    project = paintSnesSceneRect(
      project,
      selectedSceneIndex,
      0,
      9,
      SNES_STUDIO_EDIT_GRID.width,
      3,
      1,
      true,
      1,
    );
    if (prompt.includes("forest") || prompt.includes("jungle")) {
      project = paintSnesSceneRect(project, selectedSceneIndex, 1, 7, 4, 1, 2, true, 3);
      project = paintSnesSceneRect(project, selectedSceneIndex, 7, 6, 4, 1, 2, true, 3);
      project = paintSnesSceneRect(project, selectedSceneIndex, 13, 7, 2, 1, 2, true, 3);
    }
    if (prompt.includes("sky") || prompt.includes("cloud") || prompt.includes("space")) {
      project = paintSnesSceneRect(project, selectedSceneIndex, 2, 5, 4, 1, 2, true, 3);
      project = paintSnesSceneRect(project, selectedSceneIndex, 8, 4, 3, 1, 2, true, 3);
      project = paintSnesSceneRect(project, selectedSceneIndex, 13, 5, 3, 1, 2, true, 3);
    }
    if (prompt.includes("cave") || prompt.includes("underground")) {
      project = paintSnesSceneRect(
        project,
        selectedSceneIndex,
        0,
        0,
        SNES_STUDIO_EDIT_GRID.width,
        1,
        1,
        true,
        1,
      );
      project = paintSnesSceneRect(project, selectedSceneIndex, 0, 1, 1, 8, 1, true, 1);
      project = paintSnesSceneRect(project, selectedSceneIndex, 15, 1, 1, 8, 1, true, 1);
    }
    if (prompt.includes("water") || prompt.includes("ocean") || prompt.includes("river")) {
      project = paintSnesSceneRect(
        project,
        selectedSceneIndex,
        0,
        8,
        SNES_STUDIO_EDIT_GRID.width,
        1,
        4,
        true,
        4,
      );
    }
    if (prompt.includes("hazard") || prompt.includes("lava") || prompt.includes("spike")) {
      project = paintSnesSceneRect(project, selectedSceneIndex, 3, 8, 3, 1, 4, true, 2);
      project = paintSnesSceneRect(project, selectedSceneIndex, 10, 8, 2, 1, 4, true, 2);
    }
    if (prompt.includes("climb") || prompt.includes("tower") || prompt.includes("vertical")) {
      project = paintSnesSceneRect(project, selectedSceneIndex, 2, 6, 5, 1, 2, true, 3);
      project = paintSnesSceneRect(project, selectedSceneIndex, 9, 4, 5, 1, 2, true, 3);
    }
    const scene = project.scenes[selectedSceneIndex];
    if (scene && (prompt.includes("coin") || prompt.includes("gem") || prompt.includes("key"))) {
      const hasPromptItem = scene.entities.some((entity) => entity.id === "prompt-item");
      if (!hasPromptItem) {
        scene.entities.push({
          id: "prompt-item",
          kind: "item",
          name: prompt.includes("key") ? "Prompt Key" : "Prompt Gem",
          x: 112,
          y: 112,
          metaspriteTiles: 2,
        });
      }
    }
    project = normalizeSnesStudioProject(project);
    saveProject();
    selectedPanel = "scene";
    pushConsole(host, "Painted a playable level layout from the prompt.");
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Prompt level paint failed.");
  }
}

function importIndexedTileset(host: HostUpdate) {
  try {
    const importResult = importSnesIndexedTileAsset({
      name: assetImportName,
      width: assetImportWidth,
      height: assetImportHeight,
      pixels: parseSnesIndexedTilePixels(assetImportPixels),
    });
    rememberUndo();
    project = applySnesImportedTileset(project, importResult);
    saveProject();
    pushConsole(
      host,
      `Imported ${importResult.name}: ${importResult.uniqueTileCount}/${importResult.sourceTileCount} unique SNES 4bpp tiles, ${formatBytes(importResult.chrSizeBytes)} CHR.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Indexed tile import failed.");
  }
}

function generatePromptSprite(host: HostUpdate, kind: SnesSceneEntityKind = "player") {
  try {
    const sprite = createSnesPromptSpriteAsset(spritePromptDraft, kind);
    rememberUndo();
    project = applySnesImportedTileset(project, sprite.importResult);
    const scene = project.scenes[selectedSceneIndex];
    if (scene) {
      const sameKindCount = scene.entities.filter((entity) => entity.kind === kind).length;
      const entity = {
        ...sprite.defaultEntity,
        id: `${sprite.defaultEntity.id}-${sameKindCount + 1}`,
        x: sprite.defaultEntity.x + sameKindCount * 32,
      };
      scene.entities.push(entity);
      focusedGeneratedObjectId = `${scene.id}:${entity.id}`;
    }
    if (sprite.animation) {
      project.animations = [
        ...project.animations.filter((animation) => animation.id !== sprite.animation?.id),
        sprite.animation,
      ];
    }
    project.assets.spriteTiles = Math.max(
      project.assets.spriteTiles,
      project.assets.spriteTiles + sprite.importResult.uniqueTileCount,
    );
    project = normalizeSnesStudioProject(project);
    saveProject();
    selectedPanel = "scene";
    pushConsole(
      host,
      `Generated ${sprite.importResult.uniqueTileCount} SNES 4bpp sprite tile${sprite.importResult.uniqueTileCount === 1 ? "" : "s"} for ${sprite.defaultEntity.name}.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Prompt sprite generation failed.");
  }
}

async function importPngTilesetFile(host: HostUpdate, file: File) {
  try {
    const decoded = await decodePngTilesetFile(file);
    const importResult = importSnesRgbaTileAsset(
      {
        name: assetImportName.trim() || fileBaseName(file),
        width: decoded.width,
        height: decoded.height,
        rgba: decoded.rgba,
      },
      undefined,
      { quantize: assetImportQuantizePng },
    );
    rememberUndo();
    project = applySnesImportedTileset(project, importResult);
    saveProject();
    pushConsole(
      host,
      `Imported PNG ${file.name}: ${importResult.uniqueTileCount}/${importResult.sourceTileCount} unique SNES 4bpp tiles, ${formatBytes(importResult.chrSizeBytes)} CHR${importResult.quantized ? ", palette quantized" : ""}.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "PNG tileset import failed.");
  } finally {
    host.requestUpdate?.();
  }
}

async function importPngTilesetInput(host: HostUpdate, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  try {
    await importPngTilesetFile(host, file);
  } finally {
    input.value = "";
  }
}

async function dropPngTileset(host: HostUpdate, event: DragEvent) {
  event.preventDefault();
  const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
  const file = files.find(
    (candidate) => candidate.type === "image/png" || /\.png$/iu.test(candidate.name),
  );
  if (!file) {
    pushConsole(host, "Drop a PNG tileset file.");
    return;
  }
  await importPngTilesetFile(host, file);
}

function addCustomBrush(host: HostUpdate) {
  try {
    rememberUndo();
    project = addSnesCustomTileBrush(project, {
      name: customBrushName,
      tile: customBrushTile,
      solid: customBrushSolid,
    });
    saveProject();
    pushConsole(host, `Added custom brush ${customBrushName}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Custom brush creation failed.");
  }
}

function addSpriteAnimation(host: HostUpdate) {
  updateProject(host, (draft) => {
    const index = draft.animations.length + 1;
    draft.animations.push({
      id: `custom-animation-${Date.now()}`,
      name: `Animation ${index}`,
      entityKind: "player",
      loop: true,
      frames: [
        {
          id: `custom-animation-${Date.now()}-frame-1`,
          durationTicks: 8,
          tileIndex: 0,
          xOffset: 0,
          yOffset: 0,
        },
      ],
    });
  });
  pushConsole(host, "Added editable sprite animation timeline.");
}

function removeSpriteAnimation(host: HostUpdate, animationIndex: number) {
  updateProject(host, (draft) => {
    draft.animations.splice(animationIndex, 1);
  });
  pushConsole(host, `Removed sprite animation ${animationIndex + 1}.`);
}

function addAnimationFrame(host: HostUpdate, animationIndex: number) {
  updateProject(host, (draft) => {
    const animation = draft.animations[animationIndex];
    if (!animation) {
      return;
    }
    const previous = animation.frames.at(-1);
    animation.frames.push({
      id: `${animation.id}-frame-${Date.now()}`,
      durationTicks: previous?.durationTicks ?? 8,
      tileIndex: (previous?.tileIndex ?? 0) + 1,
      xOffset: previous?.xOffset ?? 0,
      yOffset: previous?.yOffset ?? 0,
    });
  });
  pushConsole(host, `Added frame to animation ${animationIndex + 1}.`);
}

function duplicateAnimationFrame(host: HostUpdate, animationIndex: number, frameIndex: number) {
  updateProject(host, (draft) => {
    const animation = draft.animations[animationIndex];
    const frame = animation?.frames[frameIndex];
    if (!animation || !frame) {
      return;
    }
    animation.frames.splice(frameIndex + 1, 0, {
      ...frame,
      id: `${animation.id}-frame-${Date.now()}`,
    });
  });
  pushConsole(host, `Duplicated frame ${frameIndex + 1}.`);
}

function removeAnimationFrame(host: HostUpdate, animationIndex: number, frameIndex: number) {
  const animation = project.animations[animationIndex];
  if (!animation || animation.frames.length <= 1) {
    pushConsole(host, "Animation timelines must keep at least one frame.");
    return;
  }
  updateProject(host, (draft) => {
    draft.animations[animationIndex]?.frames.splice(frameIndex, 1);
  });
  pushConsole(host, `Removed frame ${frameIndex + 1}.`);
}

function moveAnimationFrame(
  host: HostUpdate,
  animationIndex: number,
  frameIndex: number,
  direction: -1 | 1,
) {
  updateProject(host, (draft) => {
    const frames = draft.animations[animationIndex]?.frames;
    if (!frames) {
      return;
    }
    const nextIndex = frameIndex + direction;
    if (nextIndex < 0 || nextIndex >= frames.length) {
      return;
    }
    const [frame] = frames.splice(frameIndex, 1);
    if (frame) {
      frames.splice(nextIndex, 0, frame);
    }
  });
  pushConsole(host, `Moved animation frame ${frameIndex + 1}.`);
}

function setEntityMetaspritePreset(host: HostUpdate, entityIndex: number, metaspriteTiles: number) {
  updateProject(host, (draft) => {
    const entity = draft.scenes[selectedSceneIndex]?.entities[entityIndex];
    if (entity) {
      entity.metaspriteTiles = metaspriteTiles;
    }
  });
  pushConsole(host, `Applied ${metaspriteTiles}-tile metasprite preset.`);
}

function addLevel(host: HostUpdate) {
  rememberUndo();
  project = addSnesProjectScene(project);
  selectedSceneIndex = project.scenes.length - 1;
  saveProject();
  selectedPanel = "scene";
  pushConsole(host, `Added ${project.scenes[selectedSceneIndex]?.name ?? "new level"}.`);
}

function duplicateLevel(host: HostUpdate) {
  try {
    rememberUndo();
    project = duplicateSnesProjectScene(project, selectedSceneIndex);
    selectedSceneIndex = project.scenes.length - 1;
    saveProject();
    selectedPanel = "scene";
    pushConsole(host, `Duplicated level to ${project.scenes[selectedSceneIndex]?.name}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Level duplication failed.");
  }
}

function removeLevel(host: HostUpdate) {
  try {
    rememberUndo();
    const removed = selectedScene()?.name ?? "level";
    project = removeSnesProjectScene(project, selectedSceneIndex);
    selectedSceneIndex = Math.min(selectedSceneIndex, project.scenes.length - 1);
    saveProject();
    pushConsole(host, `Removed ${removed}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Level removal failed.");
  }
}

function moveEntityToCell(host: HostUpdate, cellIndex: number) {
  if (draggedPalettePiece) {
    const column = cellIndex % SNES_STUDIO_EDIT_GRID.width;
    const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
    addScenePalettePiece(host, draggedPalettePiece, {
      x: column * 16 + 8,
      y: row * 16 + 8,
    });
    pushConsole(host, `Dropped new ${draggedPalettePiece} onto cell ${cellIndex}.`);
    draggedPalettePiece = null;
    draggedGuidedThingKind = null;
    draggedEntityId = null;
    return;
  }
  if (!draggedEntityId) {
    if (draggedPart) {
      pushConsole(
        host,
        `${draggedPart.label} cannot be dropped on the level grid. Drop sounds in Sound Desk, dialogue on story targets, or pick a hero/enemy/item/door/goal piece.`,
      );
      draggedPart = null;
      draggedGuidedThingKind = null;
      host.requestUpdate?.();
    }
    return;
  }
  const column = cellIndex % SNES_STUDIO_EDIT_GRID.width;
  const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
  try {
    rememberUndo();
    project = moveSnesSceneEntity(
      project,
      selectedSceneIndex,
      draggedEntityId,
      column * 16 + 8,
      row * 16 + 8,
    );
    const moved = selectedScene()?.entities.find((entity) => entity.id === draggedEntityId);
    saveProject();
    hotReloadRuntimeAfterEdit(
      host,
      `${moved?.name ?? "Thing"} moved`,
      "This grid drag/drop change is now in the 60 Hz playtest.",
    );
    pushConsole(host, `Moved ${moved?.name ?? draggedEntityId} to cell ${cellIndex}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Entity move failed.");
  } finally {
    draggedEntityId = null;
    draggedGuidedThingKind = null;
    draggedPart = null;
  }
}

function moveDraggedThingToWorldPosition(host: HostUpdate, x: number, y: number) {
  const scene = selectedScene();
  const clampedX = clampInteger(Math.round(x), 0, (scene?.widthMetatiles ?? 16) * 16 - 1);
  const clampedY = clampInteger(Math.round(y), 0, (scene?.heightMetatiles ?? 16) * 16 - 1);
  if (draggedPalettePiece) {
    addScenePalettePiece(host, draggedPalettePiece, {
      x: clampedX,
      y: clampedY,
    });
    pushConsole(host, `Dropped new ${draggedPalettePiece} at ${clampedX}, ${clampedY}.`);
    draggedPalettePiece = null;
    draggedGuidedThingKind = null;
    draggedEntityId = null;
    return;
  }
  if (!draggedEntityId) {
    if (draggedPart) {
      pushConsole(
        host,
        `${draggedPart.label} cannot be dropped in the playtest. Drop game things like hero, enemy, item, door, or goal.`,
      );
      draggedPart = null;
      draggedGuidedThingKind = null;
      host.requestUpdate?.();
    }
    return;
  }
  try {
    rememberUndo();
    project = moveSnesSceneEntity(project, selectedSceneIndex, draggedEntityId, clampedX, clampedY);
    const moved = selectedScene()?.entities.find((entity) => entity.id === draggedEntityId);
    saveProject();
    hotReloadRuntimeAfterEdit(
      host,
      `${moved?.name ?? "Thing"} moved`,
      "This drag/drop change is now in the 60 Hz playtest.",
    );
    pushConsole(host, `Moved ${moved?.name ?? draggedEntityId} to ${clampedX}, ${clampedY}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Entity move failed.");
  } finally {
    draggedEntityId = null;
    draggedGuidedThingKind = null;
    draggedPart = null;
  }
}

function dropSceneObjectOnStage(host: HostUpdate, event: DragEvent) {
  event.preventDefault();
  const target = event.currentTarget as HTMLElement;
  const scene = selectedScene();
  const rect = target.getBoundingClientRect();
  if (!scene || rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const visibleWorldWidth = 256;
  const worldWidth = scene.widthMetatiles * 16;
  const worldHeight = scene.heightMetatiles * 16;
  const cameraX = previewSimulationState?.cameraScrollX ?? 0;
  const worldX = clampInteger(
    Math.round(cameraX + ((event.clientX - rect.left) / rect.width) * visibleWorldWidth),
    0,
    worldWidth - 1,
  );
  const worldY = clampInteger(
    Math.round(((event.clientY - rect.top) / rect.height) * worldHeight),
    0,
    worldHeight - 1,
  );
  if (draggedGuidedThingKind) {
    const kind = draggedGuidedThingKind;
    draggedGuidedThingKind = null;
    draggedPalettePiece = null;
    draggedEntityId = null;
    draggedPart = null;
    const name = addGuidedThingToLevel(host, kind, {
      x: worldX,
      y: worldY,
    });
    if (name) {
      pushConsole(host, `Dropped ${name} into the playable level.`);
    }
    return;
  }
  moveDraggedThingToWorldPosition(host, worldX, worldY);
}

function importProjectDocument(host: HostUpdate) {
  try {
    const parsed = parseSnesProjectDocument(projectImportDraft);
    rememberUndo();
    project = parsed.project;
    projectVersions = parsed.versions.length > 0 ? parsed.versions : projectVersions;
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    saveProject();
    saveProjectVersions();
    selectedPanel = "project";
    pushConsole(host, `Imported project document for ${project.name}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Project import failed.");
  }
}

async function importProjectFile(host: HostUpdate, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  try {
    projectImportDraft = await file.text();
    importProjectDocument(host);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Project file import failed.");
  } finally {
    input.value = "";
    host.requestUpdate?.();
  }
}

function addSaveField(host: HostUpdate) {
  updateProject(host, (draft) => {
    const nextIndex = draft.save.fields.length + 1;
    draft.save.enabled = true;
    draft.save.fields.push({
      key: `field_${nextIndex}`,
      label: `Save Field ${nextIndex}`,
      type: "u8",
    });
  });
  pushConsole(host, "Added SRAM save field.");
}

function removeSaveField(host: HostUpdate, index: number) {
  updateProject(host, (draft) => {
    draft.save.fields.splice(index, 1);
  });
  pushConsole(host, `Removed SRAM save field ${index + 1}.`);
}

function resetProject(host: HostUpdate) {
  rememberUndo();
  project = createDefaultSnesStudioProject();
  pendingAgentProposal = null;
  lastAppliedFullGamePrompt = "";
  saveProject();
  pushConsole(host, "Reset project to the professional Mode 1 platformer starter.");
}

function startBlankProject(host: HostUpdate) {
  rememberUndo();
  project = createBlankSnesStudioProject();
  selectedSceneIndex = 0;
  pendingAgentProposal = null;
  agentPatchDraft = "";
  focusedGeneratedObjectId = null;
  selectedCreateTarget = "full-game";
  lastAppliedFullGamePrompt = "";
  selectedScreenArea = null;
  arcadeAreaDragStart = null;
  arcadeAreaPromptDraft = "Add a coin trail here.";
  const promptCatalog = createSnesAiAuthoringPrompts(project);
  aiPromptDrafts = Object.fromEntries(
    promptCatalog.map((entry) => [entry.surface, entry.placeholder]),
  ) as Record<SnesAiAuthoringSurface, string>;
  saveProject();
  selectedMode = "make";
  selectedPanel = "prompt";
  pushConsole(host, "Started a blank SNES game. Use AI prompts to generate each editable part.");
}

function repairPlayablePreview(host: HostUpdate) {
  rememberUndo();
  const repair = repairSnesProjectForPlayablePreview(project);
  project = repair.project;
  selectedSceneIndex = 0;
  pendingAgentProposal = null;
  saveProject();
  selectedMode = "edit";
  selectedPanel = "scene";
  pushConsole(
    host,
    `Made project playable: ${repair.beforeReadiness.status} ${repair.beforeReadiness.score}/100 -> ${repair.afterReadiness.status} ${repair.afterReadiness.score}/100.`,
  );
  for (const change of repair.changes.slice(0, 4)) {
    pushConsole(host, change);
  }
  host.requestUpdate?.();
}

function fillGuidedMissingPieces(host: HostUpdate) {
  try {
    persistSnapshot();
    rememberUndo();
    const result = fillSnesAiGaps(project);
    project = normalizeSnesStudioProject(result.project);
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    saveProject();
    previewSimulationState = initializeRuntimeState();
    guidedReceipt = {
      title:
        result.report.status === "complete" ? "Story game gaps filled" : "Missing pieces improved",
      detail: result.changes.slice(0, 4).join(" "),
      next:
        result.report.status === "complete"
          ? "The draft has a story, chapters, cast, playtest, and export plan."
          : result.report.summary,
    };
    setAiActionFeedback(host, {
      status: result.report.status === "complete" ? "ready" : "working",
      title: guidedReceipt.title,
      detail: guidedReceipt.detail,
      provider: aiGameStageResolvedProvider("full-game"),
      target: "Whole Game",
    });
    for (const change of result.changes.slice(0, 6)) {
      pushConsole(host, change);
    }
  } catch (error) {
    guidedReceipt = {
      title: "AI could not fill gaps",
      detail: error instanceof Error ? error.message : "Gap filling failed.",
      next: "Try building from the main game prompt again.",
    };
    pushConsole(host, guidedReceipt.detail);
  } finally {
    host.requestUpdate?.();
  }
}

function hasArcadeGameDraft() {
  return Boolean(project.gameBrief?.prompt?.trim() || lastAppliedFullGamePrompt.trim());
}

function arcadeExportReadinessStatus(status: ReturnType<typeof buildSnesReadiness>["status"]) {
  return status === "ready" ? "ready" : status === "blocked" ? "blocked" : "needs-fixes";
}

function syncArcadeBuilderMetadata(prompt: string) {
  const scene = selectedScene() ?? project.scenes[0];
  const story = project.gameStoryBible;
  const blueprint = project.gameplayBlueprint;
  const hero =
    scene?.entities.find((entity) => entity.kind === "player")?.name ?? story?.hero ?? "Hero";
  const enemies =
    project.scenes
      .flatMap((candidate) => candidate.entities)
      .filter((entity) => entity.kind === "enemy")
      .map((entity) => entity.name)
      .slice(0, 4) ?? [];
  const items =
    project.scenes
      .flatMap((candidate) => candidate.entities)
      .filter((entity) => entity.kind === "item")
      .map((entity) => entity.name)
      .slice(0, 5) ?? [];
  const readiness = buildSnesReadiness(project);
  project.gameBrief = {
    prompt: prompt.trim() || project.gameBrief?.prompt || "Make a side-scrolling platformer.",
    gameType: "side-scrolling-platformer",
    audience: "beginner",
    promise: "Create a playable side-scrolling SNES-style game from one prompt.",
  };
  project.gamePlan = {
    title: project.name,
    hero,
    goal: story?.heroGoal ?? project.levelPlan?.goal ?? "Reach the end of the level.",
    villain: story?.villain ?? enemies[0] ?? "Rival Enemy",
    levels:
      project.levelChapters?.map((chapter) => chapter.title).slice(0, 5) ??
      project.scenes.map((candidate) => candidate.name).slice(0, 5),
    items,
    powerups:
      (project.thingLibrary ?? [])
        .filter((entry) => entry.kind === "powerup")
        .map((entry) => entry.name)
        .slice(0, 4) ?? [],
    artMood: blueprint?.artMood ?? "bright 16-bit adventure",
    musicMood: blueprint?.musicMood ?? "upbeat platformer loop",
    rulesSummary:
      project.platformerRules?.movement ??
      "Run, jump, collect rewards, avoid danger, and reach the goal.",
    savePlan: project.save.enabled
      ? "Save memory keeps progress."
      : "Preview game has no saves yet.",
  };
  project.exportReadiness = {
    status: arcadeExportReadinessStatus(readiness.status),
    summary:
      readiness.status === "ready"
        ? "Ready to make a preview SNES game file."
        : "The game can still be edited and tested before export.",
    blockers: readiness.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message),
  };
  if (previewSimulationState) {
    project.emulatorPlaytestState = previewSimulationState;
  }
}

function currentStylePack() {
  return createClassicPlatformerStylePack();
}

function classicStyleStatusText() {
  return project.visualStylePreset === SNES_CLASSIC_PLATFORMER_STYLE_PRESET
    ? "Using original SNES-safe art inspired by classic platformers."
    : "Using SNES-safe original game art.";
}

function applyClassicPlatformerStyle(host: HostUpdate, reason = "graphics style selected") {
  const prompt = surfacePromptDraft("full-game");
  const style = resolveSnesVisualStyleFromPrompt(prompt || "classic colorful SNES platformer");
  const stylePack = createClassicPlatformerStylePack();
  updateProject(host, (draft) => {
    draft.visualStylePreset = style.visualStylePreset;
    draft.artDirection = style.artDirection;
    draft.assetProvenance = style.assetProvenance;
    draft.styleWarnings = style.styleWarnings;
    draft.assets.backgroundTiles = Math.max(
      draft.assets.backgroundTiles,
      stylePack.budgetEstimate.backgroundTiles,
    );
    draft.assets.spriteTiles = Math.max(
      draft.assets.spriteTiles,
      stylePack.budgetEstimate.spriteTiles,
    );
    draft.assets.backgroundPalettes = Math.max(
      draft.assets.backgroundPalettes,
      stylePack.budgetEstimate.backgroundPalettes,
    );
    draft.assets.spritePalettes = Math.max(
      draft.assets.spritePalettes,
      stylePack.budgetEstimate.spritePalettes,
    );
    if (draft.gameplayBlueprint) {
      draft.gameplayBlueprint.artMood = `${stylePack.name} original art`;
    }
    if (draft.gamePlan) {
      draft.gamePlan.artMood = `${stylePack.name} original art`;
    }
  });
  setAiActionFeedback(host, {
    status: "ready",
    title: "Graphics style updated",
    detail: `${stylePack.name} is active. The playtest uses original SNES-safe grass, sky, sprite, reward, door, and goal art.`,
    provider: aiGameStageResolvedProvider("full-game"),
    target: "Graphics Style",
  });
  pushConsole(host, `Applied ${stylePack.name}: ${reason}.`);
}

function renderGraphicsStyleCard(host: HostUpdate) {
  const stylePack = currentStylePack();
  const isActive = project.visualStylePreset === stylePack.id;
  return html`
    <section
      class=${`snes-graphics-style-card${isActive ? " active" : ""}`}
      aria-label="Graphics Style"
    >
      <div>
        <span class="snes-eyebrow">Graphics Style</span>
        <h4>${stylePack.name}</h4>
        <p>${stylePack.plainDescription}</p>
        <small>${classicStyleStatusText()}</small>
      </div>
      <div class="snes-graphics-style-card__swatches" aria-label="Style palette">
        ${stylePack.paletteHex
          .slice(0, 8)
          .map((color) => html`<span style=${`--swatch:${color}`} title=${color}></span>`)}
      </div>
      <div class="snes-graphics-style-card__facts">
        <span>${stylePack.budgetEstimate.backgroundTiles} level tiles</span>
        <span>${stylePack.budgetEstimate.spriteTiles} sprite tiles</span>
        <span>${stylePack.budgetEstimate.cgramColors} colors</span>
        <span>${project.assetProvenance === "user-imported" ? "user art" : "original art"}</span>
      </div>
      <button
        type="button"
        class=${isActive ? "active" : ""}
        @click=${() => applyClassicPlatformerStyle(host)}
      >
        Use This Look
      </button>
    </section>
  `;
}

function isGamePartLocked(kind: SnesGamePartLock["kind"], id: string) {
  return (project.gamePartLocks ?? []).some((lock) => lock.kind === kind && lock.id === id);
}

function toggleGamePartLock(
  host: HostUpdate,
  kind: SnesGamePartLock["kind"],
  id: string,
  label: string,
) {
  updateProject(host, (draft) => {
    const locks = draft.gamePartLocks ?? [];
    const locked = locks.some((lock) => lock.kind === kind && lock.id === id);
    draft.gamePartLocks = locked
      ? locks.filter((lock) => !(lock.kind === kind && lock.id === id))
      : [...locks, { id, kind, label }];
  });
  guidedReceipt = {
    title: isGamePartLocked(kind, id) ? "Part locked" : "Part unlocked",
    detail: `${label} ${isGamePartLocked(kind, id) ? "will be preserved" : "can be changed"} when AI fills gaps.`,
    next: "Use Fill Missing Pieces when you want AI to complete the draft safely.",
  };
  host.requestUpdate?.();
}

function queueVisibleAgentRun(
  _host: HostUpdate,
  provider: SnesAgentProvider,
  surface: SnesAiAuthoringSurface,
) {
  const record = createSnesAgentDispatchRecord(
    project,
    surfacePromptDraft(surface),
    new Date().toISOString(),
    provider,
    surface,
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  return record;
}

function createPlayableDraftFromPrompt(host: HostUpdate, reason: "create" | "finish" | "play") {
  const provider: SnesAgentProvider = "openclaw";
  const appliedPrompt = surfacePromptDraft("full-game").trim();
  try {
    persistSnapshot();
    rememberUndo();
    setAiActionFeedback(host, {
      status: "working",
      title: "Codex and OpenClaw are making your game",
      detail:
        "Codex is writing the blueprint and quality rubric. OpenClaw is filling the editable game parts. Codex will review before playtest/export approval.",
      provider,
      target: "Whole Game",
    });
    const record = queueVisibleAgentRun(host, provider, "full-game");
    markAgentRunStream(
      host,
      record,
      "streaming",
      "Codex Architect is planning; OpenClaw Game Team is filling story, levels, cast, rules, audio, and export basics.",
    );
    const production = createSnesAiProductionRun(surfacePromptDraft("full-game"), project);
    project = normalizeSnesStudioProject(production.project);
    lastAppliedFullGamePrompt = appliedPrompt;
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    syncArcadeBuilderMetadata(appliedPrompt);
    saveProject();
    paintLevelFromPrompt(host);
    syncArcadeBuilderMetadata(appliedPrompt);
    saveProject();
    selectedPanel = "scene";
    markAgentRunStream(
      host,
      record,
      "complete",
      "Codex-supervised OpenClaw production created an editable full-game draft.",
      JSON.stringify({
        summary: project.aiCommandResult?.summary,
        blueprint: production.run.blueprint.gameConcept,
        status: production.run.status,
        reviews: production.run.reviewRounds.map((review) => ({
          round: review.round,
          score: review.score,
          status: review.status,
          approvalStatus: review.approvalStatus,
          requiredCorrections: review.requiredCorrections,
        })),
      }),
    );
    const readiness = buildSnesReadiness(project);
    const action =
      reason === "finish"
        ? "Finished playable draft"
        : reason === "play"
          ? "Created game from your prompt before Play Now"
          : "Created game from one prompt";
    setAiActionFeedback(host, {
      status: "ready",
      title:
        reason === "play"
          ? "OpenClaw filled the game and Codex approved Test"
          : "Codex-supervised OpenClaw made a playable game",
      detail: `Codex wrote the blueprint, OpenClaw filled every editable game section, and Codex reviewed ${project.name} at ${production.run.finalApproval?.score ?? 0}/100. You can test it now, change it with OpenClaw, or export later.`,
      provider,
      target: "Whole Game",
    });
    pushConsole(
      host,
      `${action} with Codex-supervised OpenClaw task ${record.id}: ${readiness.status} ${readiness.score}/100, production ${production.run.status}. Test Game is ready.`,
    );
    return true;
  } catch (error) {
    setAiActionFeedback(host, {
      status: "error",
      title: "AI could not make the game",
      detail: error instanceof Error ? error.message : "Prompt game creation failed.",
      provider,
      target: "Whole Game",
    });
    pushConsole(host, error instanceof Error ? error.message : "Prompt game creation failed.");
    return false;
  } finally {
    host.requestUpdate?.();
  }
}

function applyFullGamePromptNow(host: HostUpdate, reason: "create" | "finish") {
  if (!createPlayableDraftFromPrompt(host, reason)) {
    return;
  }
  selectedMode = "play";
  selectedPanel = "scene";
  startPreviewPlaytest(host, false, true);
}

function createGameFromPrompt(host: HostUpdate) {
  applyFullGamePromptNow(host, "create");
}

function finishPlayableDraft(host: HostUpdate) {
  applyFullGamePromptNow(host, "finish");
}

function ensurePlayableContentBeforePlay(host: HostUpdate) {
  if (shouldCreateFullGamePromptBeforePlay()) {
    return createPlayableDraftFromPrompt(host, "play");
  }
  if (!sceneNeedsPlayableTestContent()) {
    return true;
  }
  if (sceneIsEmptyStarterCanvas()) {
    return createPlayableDraftFromPrompt(host, "play");
  }
  try {
    persistSnapshot();
    rememberUndo();
    const repair = repairSnesProjectForPlayablePreview(project);
    project = normalizeSnesStudioProject(repair.project);
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    saveProject();
    pushConsole(host, "Play Now added the missing hero, ground, and test pieces first.");
    return true;
  } catch (error) {
    pushConsole(
      host,
      error instanceof Error ? error.message : "Play Now could not prepare a playable test.",
    );
    return false;
  } finally {
    host.requestUpdate?.();
  }
}

function collisionLabelForPlaytest(scene: SnesStudioProject["scenes"][number], collision: string) {
  if (collision === "ground") return "safe ground";
  if (collision === "water") return "water";
  if (collision === "hazard") return "danger";
  return scene.entities.find((entity) => entity.id === collision)?.name ?? collision;
}

function newValues(previous: string[], current: string[]) {
  const previousSet = new Set(previous);
  return current.filter((value) => !previousSet.has(value));
}

function playtestActionLabel(input: SnesPreviewControllerInput, frames?: number) {
  if (frames && frames > 1) return "Auto run";
  if (input.jump) return "Jump";
  if (input.right) return "Move Right";
  if (input.left) return "Move Left";
  return "Test";
}

function describePlaytestFeedback(
  scene: SnesStudioProject["scenes"][number],
  previous: SnesPreviewSimulationState | null,
  state: SnesPreviewSimulationState,
  input: SnesPreviewControllerInput,
  frames?: number,
): SnesPlaytestFeedback {
  if (state.status === "won" && previous?.status !== "won") {
    return {
      tone: "reward",
      title: "Goal reached",
      detail: "The hero reached the finish. The level can be won in this playtest.",
    };
  }
  if (state.status === "lost" && previous?.status !== "lost") {
    return {
      tone: "warning",
      title: "Hero lost",
      detail: "Health reached zero. Restart, move enemies, or ask AI to make the level easier.",
    };
  }
  const collected = newValues(previous?.collectedItems ?? [], state.collectedItems);
  const defeated = newValues(previous?.defeatedEnemies ?? [], state.defeatedEnemies);
  const collisions = state.collisions.filter((collision) => collision !== "ground");
  if (collected.length > 0) {
    const itemNames = collected
      .map((id) => scene.entities.find((entity) => entity.id === id)?.name ?? "an item")
      .join(", ");
    return {
      tone: "reward",
      title: "Picked up a reward",
      detail: `${itemNames} disappeared from the test scene, raised score to ${state.score}, and counts as collected.`,
    };
  }
  if (defeated.length > 0) {
    const enemyNames = defeated
      .map((id) => scene.entities.find((entity) => entity.id === id)?.name ?? "an enemy")
      .join(", ");
    return {
      tone: "reward",
      title: "Enemy defeated",
      detail: `${enemyNames} is marked as cleared for this test run.`,
    };
  }
  if (collisions.length > 0) {
    const labels = [
      ...new Set(collisions.map((collision) => collisionLabelForPlaytest(scene, collision))),
    ];
    return {
      tone: "warning",
      title: "The hero bumped something",
      detail: `The test noticed ${labels.join(", ")}. Health is ${state.health}/3. Change the level or enemy if that feels wrong.`,
    };
  }
  if (input.jump && !state.grounded) {
    return {
      tone: "move",
      title: "Hero jumped",
      detail: "The hero left the ground. Press Move Right while jumping to test platform spacing.",
    };
  }
  if (state.grounded && previous && !previous.grounded) {
    return {
      tone: "move",
      title: "Hero landed",
      detail: "The hero came back to safe ground.",
    };
  }
  const deltaX = previous ? state.playerX - previous.playerX : 0;
  if (deltaX !== 0) {
    return {
      tone: "move",
      title: deltaX > 0 ? "Hero moved right" : "Hero moved left",
      detail: `The hero moved ${Math.abs(deltaX)} pixels. Items, enemies, and bumps update as you test.`,
    };
  }
  if (frames && frames > 1) {
    return {
      tone: "move",
      title: "Auto run finished",
      detail:
        "The test advanced the game for a short burst so enemy movement and pickups can change.",
    };
  }
  return {
    tone: "ready",
    title: `${playtestActionLabel(input, frames)} checked`,
    detail: "No big change yet. Try moving right, jumping, or editing the level.",
  };
}

function playtestEntityPosition(
  entity: SnesStudioProject["scenes"][number]["entities"][number],
  state: SnesPreviewSimulationState | null,
) {
  const enemyPosition = state?.enemyPositions[entity.id];
  return {
    x: enemyPosition?.x ?? entity.x,
    y: enemyPosition?.y ?? entity.y,
  };
}

function playtestDistanceToHero(
  entity: SnesStudioProject["scenes"][number]["entities"][number],
  state: SnesPreviewSimulationState | null,
) {
  const position = playtestEntityPosition(entity, state);
  const playerX = state?.playerX ?? 32;
  const playerY = state?.playerY ?? 176;
  return Math.abs(position.x - playerX) + Math.abs(position.y - playerY);
}

function playtestObjectCard(
  scene: SnesStudioProject["scenes"][number],
  entity: SnesStudioProject["scenes"][number]["entities"][number],
) {
  return createEditableObjectCards().find((object) => object.id === `${scene.id}:${entity.id}`);
}

function promptChangePlaytestEntity(
  host: HostUpdate,
  scene: SnesStudioProject["scenes"][number],
  entity: SnesStudioProject["scenes"][number]["entities"][number],
) {
  const object = playtestObjectCard(scene, entity);
  if (object) {
    promptChangeGeneratedObject(host, object);
    return;
  }
  selectSceneEntity(host, scene, entity);
  selectedPanel = "scene";
  selectedMode = "edit";
  updateAiPrompt(
    surfaceForCreateTarget("selected-object"),
    `Change ${entity.name}: make it clearer, more fun, and easier to test.`,
  );
  host.requestUpdate?.();
}

function nearestPlaytestEntity(
  entities: SnesStudioProject["scenes"][number]["entities"],
  state: SnesPreviewSimulationState | null,
) {
  return entities.reduce<SnesStudioProject["scenes"][number]["entities"][number] | undefined>(
    (nearest, entity) => {
      if (!nearest) return entity;
      return playtestDistanceToHero(entity, state) < playtestDistanceToHero(nearest, state)
        ? entity
        : nearest;
    },
    undefined,
  );
}

function createPlaytestMoments(
  scene: SnesStudioProject["scenes"][number],
  state: SnesPreviewSimulationState | null,
): SnesPlaytestMoment[] {
  const items = scene.entities.filter((entity) => entity.kind === "item");
  const enemies = scene.entities.filter((entity) => entity.kind === "enemy");
  const goals = scene.entities.filter((entity) => {
    const name = entity.name.toLowerCase();
    return name.includes("goal") || name.includes("door");
  });
  const collectedItems = items.filter((entity) => state?.collectedItems.includes(entity.id));
  const defeatedEnemies = enemies.filter((entity) => state?.defeatedEnemies.includes(entity.id));
  const bumpedNames = [
    ...new Set(
      (state?.collisions ?? [])
        .filter((collision) => collision !== "ground")
        .map((collision) => collisionLabelForPlaytest(scene, collision)),
    ),
  ];
  const nearestItem = nearestPlaytestEntity(
    items.filter((entity) => !state?.collectedItems.includes(entity.id)),
    state,
  );
  const nearestEnemy = nearestPlaytestEntity(enemies, state);
  const nearestGoal = nearestPlaytestEntity(goals, state);
  const nearestChangeTarget =
    nearestPlaytestEntity(
      scene.entities.filter((entity) => entity.kind !== "player"),
      state,
    ) ?? scene.entities.find((entity) => entity.kind === "player");

  return [
    {
      tone: "reward",
      title: collectedItems.length > 0 ? "Reward picked up" : "Rewards",
      detail:
        collectedItems.length > 0
          ? `${collectedItems.map((entity) => entity.name).join(", ")} is collected in this test.`
          : nearestItem
            ? `Move toward ${nearestItem.name}, or change it if it feels hard to see.`
            : "No reward is on this level yet. Add one from Build or ask AI to add rewards.",
      actionLabel: nearestItem || collectedItems[0] ? "Change Reward" : undefined,
      entity: nearestItem ?? collectedItems[0],
    },
    {
      tone: "challenge",
      title:
        defeatedEnemies.length > 0
          ? "Enemy cleared"
          : bumpedNames.length > 0
            ? "Bump noticed"
            : "Challenges",
      detail:
        defeatedEnemies.length > 0
          ? `${defeatedEnemies.map((entity) => entity.name).join(", ")} is cleared in this test.`
          : bumpedNames.length > 0
            ? `The hero bumped ${bumpedNames.join(", ")}. Change that part if it feels unfair.`
            : nearestEnemy
              ? `${nearestEnemy.name} is the closest challenge to test.`
              : "No enemy is on this level yet. Add one when the level needs action.",
      actionLabel: nearestEnemy ? "Change Enemy" : undefined,
      entity: nearestEnemy,
    },
    {
      tone: "goal",
      title:
        nearestGoal && playtestDistanceToHero(nearestGoal, state) <= 40 ? "Goal is close" : "Goal",
      detail: nearestGoal
        ? `Head toward ${nearestGoal.name}. Use Auto Run if you want the test to move faster.`
        : "No door or goal is on this level yet. Add one so the player knows where to finish.",
      actionLabel: nearestGoal ? "Change Goal" : undefined,
      entity: nearestGoal,
    },
    {
      tone: "change",
      title: "Change from Play",
      detail: nearestChangeTarget
        ? `Use this to change ${nearestChangeTarget.name} without hunting through lists.`
        : "Pick anything in Build, then ask AI to change only that thing.",
      actionLabel: nearestChangeTarget ? "Ask AI to Change This" : undefined,
      entity: nearestChangeTarget,
    },
  ];
}

function revealPlayModeResult() {
  const reveal = () => {
    const playMode =
      globalThis.document?.querySelector<HTMLElement>(".snes-guided-playtest") ??
      globalThis.document?.querySelector<HTMLElement>(".snes-guided-workspace") ??
      globalThis.document?.querySelector<HTMLElement>(".snes-play-mode");
    const activeElement = globalThis.document?.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest(".snes-create-bar")) {
      activeElement.blur();
    }
    playMode?.scrollIntoView?.({ block: "start", behavior: "auto" });
    playMode?.focus?.({ preventScroll: true });
  };
  globalThis.requestAnimationFrame?.(reveal);
  globalThis.setTimeout?.(reveal, 0);
  globalThis.setTimeout?.(reveal, 80);
  globalThis.setTimeout?.(reveal, 240);
}

function resetLivePlaytestInput() {
  livePlaytestInput = {
    jump: false,
    left: false,
    right: false,
  };
}

function stopLivePlaytestTimer() {
  if (livePlaytestAnimationFrame !== null) {
    globalThis.cancelAnimationFrame?.(livePlaytestAnimationFrame);
    livePlaytestAnimationFrame = null;
  }
  livePlaytestRunning = false;
  livePlaytestFrame = 0;
  livePlaytestLastTimestamp = null;
  livePlaytestAccumulatorMs = 0;
  resetLivePlaytestInput();
}

function livePlaytestInputSnapshot(): SnesPreviewControllerInput {
  return {
    jump: livePlaytestInput.jump,
    left: livePlaytestInput.left,
    right: livePlaytestInput.right,
  };
}

function livePlaytestHasInput() {
  return livePlaytestInput.left || livePlaytestInput.right || livePlaytestInput.jump;
}

function currentRuntimeProject(): SnesRuntimeProject {
  if (selectedSceneIndex <= 0 || selectedSceneIndex >= project.scenes.length) {
    return compileSnesRuntimeProject(project);
  }
  const selected = project.scenes[selectedSceneIndex];
  if (!selected) {
    return compileSnesRuntimeProject(project);
  }
  return compileSnesRuntimeProject({
    ...project,
    scenes: [selected, ...project.scenes.filter((_, index) => index !== selectedSceneIndex)],
  });
}

function initializeRuntimeState(runtime = currentRuntimeProject()) {
  previewSimulationState = stepSnesRuntimeFrame(runtime, null, {});
  project.emulatorPlaytestState = previewSimulationState;
  return previewSimulationState;
}

function paintRuntimeCanvas(runtime = currentRuntimeProject(), state = previewSimulationState) {
  const canvas = globalThis.document?.querySelector<HTMLCanvasElement>(
    "[data-snes-runtime-canvas]",
  );
  if (!canvas || !state) {
    return false;
  }
  try {
    return renderSnesRuntimeFrame(canvas, runtime, state);
  } catch {
    return false;
  }
}

function scheduleRuntimeCanvasPaint() {
  const paint = () => paintRuntimeCanvas();
  globalThis.requestAnimationFrame?.(paint);
  globalThis.setTimeout?.(paint, 0);
}

function recordRuntimeReplay(inputs: SnesRuntimeInputFrame[]) {
  const runtime = currentRuntimeProject();
  lastRuntimeReplayInputs = [...inputs];
  lastRuntimeParityReport = runSnesRuntimeReplay(runtime, {
    runtimeHash: runtime.manifest.runtimeHash,
    inputs,
  });
}

function currentRuntimeReplay(): SnesRuntimeReplay {
  const runtime = currentRuntimeProject();
  return {
    runtimeHash: runtime.manifest.runtimeHash,
    inputs:
      lastRuntimeReplayInputs.length > 0
        ? lastRuntimeReplayInputs
        : [{ right: true }, { right: true }, { jump: true }, { right: true }],
  };
}

function currentEmulatorReplayParityProof() {
  const artifact = buildSnesPreviewRom(project);
  return createSnesEmulatorReplayParityProof(
    artifact,
    currentRuntimeProject(),
    currentRuntimeReplay(),
    selectedEmulators(),
  );
}

function hotReloadRuntimeAfterEdit(host: HostUpdate, title: string, detail: string) {
  const runtime = currentRuntimeProject();
  const previous = previewSimulationState;
  previewSimulationState =
    previous && previous.status === "playing"
      ? stepSnesRuntimeFrame(runtime, previous, {})
      : stepSnesRuntimeFrame(runtime, null, {});
  project.emulatorPlaytestState = previewSimulationState;
  lastPlaytestFeedback = {
    tone: "ready",
    title,
    detail,
  };
  paintRuntimeCanvas(runtime, previewSimulationState);
  host.requestUpdate?.();
}

function advanceLivePlaytest(_host: HostUpdate) {
  const runtime = currentRuntimeProject();
  const previous = previewSimulationState;
  const input = livePlaytestInputSnapshot();
  previewSimulationState = stepSnesRuntimeFrame(runtime, previewSimulationState, input);
  const state = previewSimulationState;
  project.emulatorPlaytestState = state;
  const scene = selectedScene();
  livePlaytestFrame += 1;
  if (scene) {
    const statusChanged = Boolean(previous && previous.status !== state.status);
    if (livePlaytestHasInput() || statusChanged || livePlaytestFrame % 12 === 0) {
      lastPlaytestFeedback = describePlaytestFeedback(
        scene,
        previous,
        state,
        input,
        livePlaytestFrame,
      );
    }
  }
  if (state.status !== "playing") {
    const endedStatus = state.status;
    stopLivePlaytestTimer();
    lastPlaytestFeedback =
      endedStatus === "won"
        ? {
            tone: "reward",
            title: "You reached the goal",
            detail: "The playtest can be won. Restart it, change it, or export when it feels good.",
          }
        : {
            tone: "warning",
            title: "The hero lost",
            detail: "Restart, move the danger, or ask AI to make this section easier.",
          };
  }
  paintRuntimeCanvas(runtime, state);
}

function livePlaytestTick(host: HostUpdate, timestamp: number) {
  if (!livePlaytestRunning) {
    return;
  }
  const runtime = currentRuntimeProject();
  const frameMs = runtime.frameTimeMs;
  if (livePlaytestLastTimestamp === null) {
    livePlaytestLastTimestamp = timestamp;
    livePlaytestFpsWindowStart = timestamp;
  }
  const deltaMs = Math.min(100, Math.max(0, timestamp - livePlaytestLastTimestamp));
  livePlaytestLastTimestamp = timestamp;
  livePlaytestAccumulatorMs += deltaMs;

  let stepped = 0;
  while (livePlaytestAccumulatorMs >= frameMs && stepped < 5 && livePlaytestRunning) {
    advanceLivePlaytest(host);
    livePlaytestAccumulatorMs -= frameMs;
    stepped += 1;
  }
  if (stepped >= 5 && livePlaytestAccumulatorMs >= frameMs) {
    livePlaytestDroppedFrames += 1;
    livePlaytestAccumulatorMs = 0;
  }

  livePlaytestRenderedFrames += 1;
  if (livePlaytestFpsWindowStart !== null && timestamp - livePlaytestFpsWindowStart >= 1000) {
    livePlaytestFps =
      (livePlaytestRenderedFrames * 1000) / Math.max(1, timestamp - livePlaytestFpsWindowStart);
    livePlaytestRenderedFrames = 0;
    livePlaytestFpsWindowStart = timestamp;
  }

  if (stepped > 0 && (livePlaytestFrame % 6 === 0 || !livePlaytestRunning)) {
    host.requestUpdate?.();
  }
  if (livePlaytestRunning) {
    livePlaytestAnimationFrame =
      globalThis.requestAnimationFrame?.((nextTimestamp) =>
        livePlaytestTick(host, nextTimestamp),
      ) ?? null;
  }
}

function startLivePlaytest(host: HostUpdate, input?: SnesPreviewControllerInput) {
  if (!ensurePlayableContentBeforePlay(host)) {
    return;
  }
  const runtime = currentRuntimeProject();
  if (!previewSimulationState || previewSimulationState.status !== "playing") {
    previewSimulationState = initializeRuntimeState(runtime);
  }
  project.emulatorPlaytestState = previewSimulationState;
  livePlaytestInput = {
    jump: input?.jump ?? livePlaytestInput.jump,
    left: input?.left ?? livePlaytestInput.left,
    right: input?.right ?? livePlaytestInput.right,
  };
  livePlaytestRunning = true;
  selectedMode = "play";
  selectedPanel = "scene";
  lastPlaytestFeedback = {
    tone: "move",
    title: "Live play started at 60 Hz",
    detail:
      "Hold Right or Left, press Jump, or use the controller buttons. The game advances at the SNES-style fixed frame cadence.",
  };
  if (livePlaytestAnimationFrame === null) {
    livePlaytestLastTimestamp = null;
    livePlaytestAccumulatorMs = 0;
    livePlaytestAnimationFrame =
      globalThis.requestAnimationFrame?.((timestamp) => livePlaytestTick(host, timestamp)) ?? null;
    if (livePlaytestAnimationFrame === null) {
      advanceLivePlaytest(host);
    }
  }
  paintRuntimeCanvas(runtime, previewSimulationState);
  pushConsole(host, `60 Hz Live Playtest started at ${runtime.frameRate.toFixed(4)} FPS.`);
  host.requestUpdate?.();
  revealPlayModeResult();
}

function pauseLivePlaytest(host: HostUpdate, announce = true) {
  stopLivePlaytestTimer();
  if (announce) {
    lastPlaytestFeedback = {
      tone: "ready",
      title: "Playtest paused",
      detail: "Press Start Test to keep playing from here, or Restart to begin again.",
    };
    pushConsole(host, "Live Playtest paused.");
    host.requestUpdate?.();
  }
}

function setLivePlaytestInput(host: HostUpdate, key: SnesLivePlaytestInputKey, active: boolean) {
  livePlaytestInput = {
    ...livePlaytestInput,
    [key]: active,
  };
  if (active) {
    startLivePlaytest(host);
    return;
  }
  host.requestUpdate?.();
}

function restartLivePlaytest(host: HostUpdate) {
  stopLivePlaytestTimer();
  previewSimulationState = initializeRuntimeState();
  project.emulatorPlaytestState = previewSimulationState;
  lastPlaytestFeedback = {
    tone: "ready",
    title: "Playtest restarted",
    detail: "The hero is back at the start. Press Start Test or hold a controller button.",
  };
  pushConsole(host, "Live Playtest restarted.");
  host.requestUpdate?.();
  revealPlayModeResult();
}

function startPreviewPlaytest(host: HostUpdate, announce = true, autoDemo = false) {
  if (!ensurePlayableContentBeforePlay(host)) {
    return;
  }
  pauseLivePlaytest(host, false);
  previewSimulationState = initializeRuntimeState();
  project.emulatorPlaytestState = previewSimulationState;
  lastPlaytestFeedback = {
    tone: "ready",
    title: "Test started",
    detail: "Use Move Right, Jump, or Auto Run. This panel will explain what changed.",
  };
  selectedMode = "play";
  selectedPanel = "scene";
  const events = simulateSnesEventScripts(project, "on-start", "scene");
  lastEventSimulation = events;
  if (autoDemo) {
    const previous = previewSimulationState;
    const demoInputs: SnesRuntimeInputFrame[] = [];
    const runtime = currentRuntimeProject();
    for (let frame = 0; frame < 18; frame += 1) {
      const inputFrame = {
        right: true,
        jump: frame === 2,
      };
      demoInputs.push(inputFrame);
      previewSimulationState = stepSnesRuntimeFrame(runtime, previewSimulationState, inputFrame);
    }
    recordRuntimeReplay(demoInputs);
    const state = previewSimulationState;
    const movedPixels = Math.max(0, state.playerX - previous.playerX);
    lastPlaytestFeedback = {
      tone: "move",
      title: "Test started",
      detail: `Auto-play moved the hero ${movedPixels} pixels so you can see the game respond. Use Move Right, Jump, or Auto Run to keep testing.`,
    };
    pushConsole(
      host,
      `Auto-play preview moved the hero from ${previous.playerX},${previous.playerY} to ${state.playerX},${state.playerY}.`,
    );
  }
  if (announce) {
    pushConsole(
      host,
      `Test Game started: ${events.shownCutsceneIds.length} dialogue event${events.shownCutsceneIds.length === 1 ? "" : "s"}, ${events.warnings.length} warning${events.warnings.length === 1 ? "" : "s"}.`,
    );
  }
  host.requestUpdate?.();
  revealPlayModeResult();
}

function stepPreviewPlaytest(host: HostUpdate, input: SnesPreviewControllerInput) {
  pauseLivePlaytest(host, false);
  const previous = previewSimulationState;
  const runtime = currentRuntimeProject();
  previewSimulationState = stepSnesRuntimeFrame(runtime, previewSimulationState, input);
  const state = previewSimulationState;
  project.emulatorPlaytestState = state;
  recordRuntimeReplay([input]);
  const scene = selectedScene();
  if (scene) {
    lastPlaytestFeedback = describePlaytestFeedback(scene, previous, state, input);
  }
  pushConsole(
    host,
    `Test frame: player ${state.playerX},${state.playerY}; ${state.collectedItems.length} item${state.collectedItems.length === 1 ? "" : "s"}; ${state.collisions.length} collision${state.collisions.length === 1 ? "" : "s"}.`,
  );
  host.requestUpdate?.();
}

function runPreviewPlaytest(host: HostUpdate, frames: number, input: SnesPreviewControllerInput) {
  pauseLivePlaytest(host, false);
  const previous = previewSimulationState;
  const runtime = currentRuntimeProject();
  const inputs: SnesRuntimeInputFrame[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    inputs.push({ ...input, frame });
    previewSimulationState = stepSnesRuntimeFrame(runtime, previewSimulationState, input);
  }
  const state = previewSimulationState ?? stepSnesRuntimeFrame(runtime, null, {});
  previewSimulationState = state;
  project.emulatorPlaytestState = state;
  recordRuntimeReplay(inputs);
  const scene = selectedScene();
  if (scene) {
    lastPlaytestFeedback = describePlaytestFeedback(scene, previous, state, input, frames);
  }
  pushConsole(
    host,
    `Ran ${frames} test frames: player ${state.playerX},${state.playerY}; ${state.collectedItems.length} collected; ${state.defeatedEnemies.length} defeated.`,
  );
  host.requestUpdate?.();
}

function resetPreviewPlaytest(host: HostUpdate) {
  stopLivePlaytestTimer();
  previewSimulationState = initializeRuntimeState();
  lastEventSimulation = null;
  lastPlaytestFeedback = {
    tone: "ready",
    title: "Test reset",
    detail: "Start again whenever you want to replay the level from the beginning.",
  };
  pushConsole(host, "Reset Test Game simulation.");
  host.requestUpdate?.();
}

function playKeyboardTargetIsFormControl(event: KeyboardEvent) {
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("button, input, select, textarea, a, summary"))
  );
}

function handlePlayModeKeydown(host: HostUpdate, event: KeyboardEvent) {
  if (playKeyboardTargetIsFormControl(event)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "arrowleft" || key === "a") {
    event.preventDefault();
    setLivePlaytestInput(host, "left", true);
    return;
  }
  if (key === "arrowright" || key === "d") {
    event.preventDefault();
    setLivePlaytestInput(host, "right", true);
    return;
  }
  if (key === "arrowup" || key === "w" || key === " ") {
    event.preventDefault();
    setLivePlaytestInput(host, "jump", true);
    return;
  }
  if (key === "enter") {
    event.preventDefault();
    startLivePlaytest(host, { right: true });
    return;
  }
  if (key === "escape") {
    event.preventDefault();
    pauseLivePlaytest(host);
    return;
  }
  if (key === "r") {
    event.preventDefault();
    restartLivePlaytest(host);
  }
}

function handlePlayModeKeyup(host: HostUpdate, event: KeyboardEvent) {
  if (playKeyboardTargetIsFormControl(event)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "arrowleft" || key === "a") {
    event.preventDefault();
    setLivePlaytestInput(host, "left", false);
    return;
  }
  if (key === "arrowright" || key === "d") {
    event.preventDefault();
    setLivePlaytestInput(host, "right", false);
    return;
  }
  if (key === "arrowup" || key === "w" || key === " ") {
    event.preventDefault();
    setLivePlaytestInput(host, "jump", false);
  }
}

function triggerPreviewEvent(host: HostUpdate, trigger: SnesEventScript["trigger"]) {
  lastEventSimulation = simulateSnesEventScripts(project, trigger, "scene");
  lastPlaytestFeedback = {
    tone: lastEventSimulation.warnings.length > 0 ? "warning" : "event",
    title: "Story or rule event checked",
    detail:
      lastEventSimulation.shownCutsceneIds.length > 0
        ? `${lastEventSimulation.shownCutsceneIds.length} dialogue scene${lastEventSimulation.shownCutsceneIds.length === 1 ? "" : "s"} would show.`
        : "No dialogue showed for this event yet. Add one in Build if you want a message.",
  };
  pushConsole(
    host,
    `Triggered ${trigger}: ${lastEventSimulation.triggeredEventIds.length} event${lastEventSimulation.triggeredEventIds.length === 1 ? "" : "s"}, ${lastEventSimulation.shownCutsceneIds.length} dialogue scene${lastEventSimulation.shownCutsceneIds.length === 1 ? "" : "s"}.`,
  );
  host.requestUpdate?.();
}

function switchPreviewScene(host: HostUpdate, direction: -1 | 1) {
  if (project.scenes.length <= 1) {
    return;
  }
  selectedSceneIndex =
    (selectedSceneIndex + direction + project.scenes.length) % project.scenes.length;
  previewSimulationState = initializeRuntimeState();
  const scene = selectedScene();
  lastPlaytestFeedback = {
    tone: "ready",
    title: "Level switched",
    detail: `${scene?.name ?? "The selected level"} is ready to test.`,
  };
  pushConsole(host, `Test Game switched to ${scene?.name ?? "selected level"}.`);
  host.requestUpdate?.();
}

function createSampleSramValues(): SnesSramSlotValues {
  return Object.fromEntries(
    project.save.fields.map((field, index) => {
      if (field.type === "flag") {
        return [field.key, index % 2 === 0];
      }
      if (field.type === "u8") {
        return [field.key, Math.min(255, index + 7)];
      }
      if (field.type === "u16") {
        return [field.key, Math.min(65535, 100 + index)];
      }
      return [field.key, 1000 + index];
    }),
  );
}

function simulateSramSaveLoad(host: HostUpdate) {
  try {
    const image = createSnesSramImage(project);
    const values = createSampleSramValues();
    const written = writeSnesSaveSlot(project, image, 0, values);
    const readBack = readSnesSaveSlot(project, written, 0);
    const validation = validateSnesSramImage(project, written);
    const proof = createSnesSramPowerCycleProof(project, written, new Uint8Array(written), 0);
    sramSimulationSummary = `${proof.status}: ${Object.keys(readBack).length} fields, ${validation.checks.filter((check) => check.passed).length}/${validation.checks.length} structure checks passed.`;
    pushConsole(host, `SRAM save/load simulator ${sramSimulationSummary}`);
  } catch (error) {
    sramSimulationSummary = error instanceof Error ? error.message : "SRAM simulation failed.";
    pushConsole(host, sramSimulationSummary);
  }
  host.requestUpdate?.();
}

function runSpc700Preview(host: HostUpdate) {
  const manifest = createSnesAudioManifest(project);
  const plan = createSnesSpc700ExportPlan(project);
  audioPreviewSummary = `${plan.status}: ${manifest.musicTracks.length} music track${manifest.musicTracks.length === 1 ? "" : "s"}, ${manifest.soundEffects.length} SFX, ${formatBytes(manifest.totalBytes)} ARAM planned.`;
  pushConsole(host, `SPC700 preview ${audioPreviewSummary}`);
  host.requestUpdate?.();
}

function previewCutsceneTimeline(host: HostUpdate) {
  const timeline = createSnesCutsceneTimeline(project);
  cutscenePreviewSummary = `${timeline.status}: ${timeline.cutsceneCount} cutscene${timeline.cutsceneCount === 1 ? "" : "s"}, ${timeline.lineCount} lines, ${timeline.totalDurationTicks} ticks.`;
  pushConsole(host, `Cutscene timeline preview ${cutscenePreviewSummary}`);
  host.requestUpdate?.();
}

function applyProjectTemplate(
  host: HostUpdate,
  templateId: ReturnType<typeof createSnesProjectTemplates>[number]["id"],
) {
  try {
    rememberUndo();
    project = createSnesProjectFromTemplate(templateId);
    lastAppliedFullGamePrompt = "";
    if (templateDetailDraft.trim()) {
      const generated = createSnesAgentPatchProposalForSurface(
        "full-game",
        `${project.name}: ${templateDetailDraft}`,
        project,
        "openclaw",
      );
      project = generated.previewProject;
    }
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    saveProject();
    selectedPanel = project.profile.enhancementChip === "superfx" ? "export" : "scene";
    selectedMode = selectedPanel === "export" ? "ship" : "edit";
    pushConsole(host, `Started ${project.name} from template ${templateId}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Template creation failed.");
  }
}

function persistSnapshot() {
  const version = createSnesProjectVersion(project);
  const snapshot = version.projectJson;
  projectVersions = appendSnesProjectVersion(projectVersions, version);
  saveProjectVersions();
  lastSnapshotAt = new Date().toLocaleString();
  getSafeLocalStorage()?.setItem(`${STORAGE_KEY}:snapshot`, snapshot);
}

function snapshotProject(host: HostUpdate) {
  persistSnapshot();
  pushConsole(host, "Snapshot saved locally before generated or agent-assisted changes.");
}

function restoreLastSnapshot(host: HostUpdate) {
  const snapshot = getSafeLocalStorage()?.getItem(`${STORAGE_KEY}:snapshot`);
  if (!snapshot) {
    pushConsole(host, "No recovery snapshot is available.");
    return;
  }
  rememberUndo();
  restoreProjectFromJson(snapshot);
  showRecoveryPanel = false;
  selectedPanel = "project";
  pushConsole(host, `Recovered snapshot for ${project.name}.`);
}

function renderRecoveryPanel(host: HostUpdate) {
  if (!showRecoveryPanel) {
    return nothing;
  }
  const snapshotAvailable = Boolean(getSafeLocalStorage()?.getItem(`${STORAGE_KEY}:snapshot`));
  return html`
    <section class="snes-recovery-panel" role="dialog" aria-label="SNES Studio recovery">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Recovery</span>
          <h3>Restore a safe project state</h3>
          <p>
            Use snapshots, undo history, or version history when a prompt or edit goes the wrong
            way.
          </p>
        </div>
        <button
          type="button"
          @click=${() => {
            showRecoveryPanel = false;
            host.requestUpdate?.();
          }}
        >
          Close
        </button>
      </div>
      <div class="snes-recovery-panel__grid">
        <article>
          <span>latest snapshot</span>
          <strong>${snapshotAvailable ? "available" : "missing"}</strong>
          <button
            type="button"
            ?disabled=${!snapshotAvailable}
            @click=${() => restoreLastSnapshot(host)}
          >
            Restore Snapshot
          </button>
        </article>
        <article>
          <span>undo stack</span>
          <strong>${undoStack.length} state${undoStack.length === 1 ? "" : "s"}</strong>
          <button
            type="button"
            ?disabled=${undoStack.length === 0}
            @click=${() => undoProjectChange(host)}
          >
            Undo Last Change
          </button>
        </article>
        <article>
          <span>version history</span>
          <strong>${projectVersions.length} saved</strong>
          ${projectVersions[0]
            ? html`
                <button
                  type="button"
                  @click=${() => restoreProjectVersion(host, projectVersions[0]!)}
                >
                  Restore Latest Version
                </button>
              `
            : html`<button type="button" disabled>Restore Latest Version</button>`}
        </article>
      </div>
    </section>
  `;
}

function renderDiffTimeline() {
  const previous = projectVersions[0];
  if (!previous) {
    return nothing;
  }
  const current = createSnesProjectVersion(project, "Current draft");
  const diff = diffSnesProjectVersions(previous, current);
  return html`
    <div class="snes-agent-list">
      <article>
        <span>Diff Timeline</span>
        <strong>${diff.changes.length} changed path${diff.changes.length === 1 ? "" : "s"}</strong>
        ${diff.changes.length > 0
          ? html`
              <div class="snes-patch-list">
                ${diff.changes.slice(0, 4).map(
                  (change) => html`
                    <code>${change.path}</code>
                    <span>${formatPatchValue(change.before)}</span>
                    <small>${formatPatchValue(change.after)}</small>
                  `,
                )}
              </div>
            `
          : html`<p class="snes-muted">Current project matches the latest snapshot.</p>`}
      </article>
    </div>
  `;
}

function downloadProjectJson(host: HostUpdate) {
  const blob = new Blob([stableProjectJson(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.export.romBaseName || "openclaw-snes-project"}.oc-snes.json`;
  link.click();
  URL.revokeObjectURL(url);
  pushConsole(host, "Downloaded canonical project JSON.");
}

function downloadProjectBundle(host: HostUpdate) {
  const bundle = createSnesProjectBundle(project, projectVersions);
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.export.romBaseName || "openclaw-snes-project"}.oc-snes-bundle.json`;
  link.click();
  URL.revokeObjectURL(url);
  pushConsole(host, `Downloaded project bundle with ${bundle.manifest.versionCount} versions.`);
}

function downloadPreviewRom(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const proof = validateSnesPreviewRomArtifact(artifact);
    if (!proof.valid) {
      throw new Error("Preview ROM failed integrity validation.");
    }
    const emulatorProof = createSnesEmulatorValidationReport(artifact);
    const blob = new Blob([bytesToBlobPart(artifact.bytes)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.fileName;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(
      host,
      `Built preview ROM ${artifact.fileName} (${formatBytes(artifact.sizeBytes)}), ${proof.checks.length} proof checks passed.`,
    );
    if (emulatorProof.status === "blocked") {
      pushConsole(host, `Emulator proof blocked: ${emulatorProof.blockers[0]}`);
    }
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Preview ROM build failed.");
  }
}

function createAndBuildPreviewRom(host: HostUpdate) {
  try {
    const provider = aiProviderBySurface["full-game"];
    const proposal = createSnesAgentPatchProposalForSurface(
      "full-game",
      surfacePromptDraft("full-game"),
      project,
      provider,
    );
    const artifact = buildSnesPreviewRom(proposal.previewProject);
    const proof = validateSnesPreviewRomArtifact(artifact);
    if (!proof.valid) {
      throw new Error("Generated project failed preview ROM validation.");
    }
    persistSnapshot();
    rememberUndo();
    project = normalizeSnesStudioProject(proposal.previewProject);
    selectedSceneIndex = 0;
    pendingAgentProposal = null;
    saveProject();
    const blob = new Blob([bytesToBlobPart(artifact.bytes)], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.fileName;
    link.click();
    URL.revokeObjectURL(url);
    selectedPanel = "scene";
    selectedMode = "edit";
    pushConsole(
      host,
      `Created and built preview ROM ${artifact.fileName}; ${proof.checks.length} proof checks passed.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Create and build failed.");
  }
}

function downloadRomMap(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const blob = new Blob([artifact.mapText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.mapFileName;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(host, `Downloaded ROM map ${artifact.mapFileName}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "ROM map export failed.");
  }
}

function downloadBuildManifest(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const blob = new Blob([artifact.manifestJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = artifact.manifestFileName;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(host, `Downloaded build manifest ${artifact.manifestFileName}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Build manifest export failed.");
  }
}

function downloadEmulatorProof(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const proof = createSnesEmulatorValidationReport(artifact, selectedEmulators());
    const bootProof = createSnesEmulatorBootProof(artifact, selectedEmulators());
    const screenshotComparison = createSnesEmulatorScreenshotComparison(artifact, null);
    const runtimeReplay = currentRuntimeReplay();
    const replayParity = createSnesEmulatorReplayParityProof(
      artifact,
      currentRuntimeProject(),
      runtimeReplay,
      selectedEmulators(),
    );
    const runPack = createSnesEmulatorReplayRunPack(
      artifact,
      currentRuntimeProject(),
      runtimeReplay,
      selectedEmulators(),
    );
    const payload = {
      artifact: artifact.fileName,
      generatedAt: new Date().toISOString(),
      bootProof,
      expectedEmulatorStateDump: {
        browserReplayChecksum: replayParity.evidence.browserReplayChecksum,
        finalStateHash: replayParity.evidence.browserFinalStateHash,
        frameCount: replayParity.evidence.frameCount,
        runtimeHash: replayParity.evidence.runtimeHash,
      },
      operatorInstructions: [
        "Boot the SNES game file in the selected emulator.",
        "Replay the included input frames in order at the runtime cadence.",
        "Capture a boot screenshot and emulator state dump.",
        "Only mark emulator parity verified when the emulator final state hash matches the expected browser final state hash.",
      ],
      replayParity,
      report: proof,
      runPack,
      runtimeManifest: artifact.runtimeManifest,
      runtimeReplay,
      screenshotComparison,
    };
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${artifact.fileName.replace(/\.sfc$/i, "")}.emulator-proof.json`;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(
      host,
      replayParity.status === "ready-to-run"
        ? `Downloaded emulator replay proof plan for ${artifact.fileName}.`
        : replayParity.status === "verified"
          ? `Downloaded verified emulator replay proof for ${artifact.fileName}.`
          : `Downloaded emulator proof report: ${proof.blockers[0]}`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Emulator proof export failed.");
  }
}

function downloadEmulatorRunScript(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const runPack = createSnesEmulatorReplayRunPack(
      artifact,
      currentRuntimeProject(),
      currentRuntimeReplay(),
      selectedEmulators(),
    );
    const blob = new Blob([runPack.scriptText], { type: "text/x-shellscript" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = runPack.scriptFileName;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(
      host,
      runPack.status === "ready"
        ? `Downloaded emulator run script ${runPack.scriptFileName}; keep it beside ${runPack.romFileName} and ${runPack.proofFileName}.`
        : `Downloaded blocked emulator run script: ${runPack.blockers[0]}`,
    );
  } catch (error) {
    pushConsole(
      host,
      error instanceof Error ? error.message : "Emulator run script export failed.",
    );
  }
}

function downloadFxpakPackagePlan(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const fxpakPackage = createSnesFxpakExportPackage(artifact);
    const blob = new Blob([`${JSON.stringify(fxpakPackage, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${artifact.fileName.replace(/\.sfc$/i, "")}.fxpak-package.json`;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(host, `Downloaded FXPAK package plan: ${fxpakPackage.status}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "FXPAK package export failed.");
  }
}

function selectedEmulators(): SnesEmulatorKind[] {
  const supported = new Set<SnesEmulatorKind>(["ares", "bsnes", "mesen", "snes9x"]);
  return emulatorSelectionDraft
    .split(/[,\s]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is SnesEmulatorKind => supported.has(entry as SnesEmulatorKind));
}

function downloadHardwareQaBundle(host: HostUpdate) {
  try {
    const bundle = createSnesHardwareQaBundle(project, new Date().toISOString(), {
      availableEmulators: selectedEmulators(),
      mountedVolume: fxpakProbe.mounted ? fxpakProbe : null,
    });
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${project.export.romBaseName || "openclaw-snes-game"}.hardware-qa.json`;
    link.click();
    URL.revokeObjectURL(url);
    pushConsole(host, `Downloaded hardware QA bundle: ${bundle.status}.`);
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Hardware QA bundle export failed.");
  }
}

function verifyFxpakCopyDryRun(host: HostUpdate) {
  try {
    const artifact = buildSnesPreviewRom(project);
    const fxpakPackage = createSnesFxpakExportPackage(artifact);
    const dryRun = createSnesFxpakCopyDryRun(fxpakPackage, fxpakProbe);
    const proof = createSnesFxpakCopyProof(
      fxpakPackage,
      artifact.bytes,
      new Uint8Array(artifact.bytes),
    );
    pushConsole(
      host,
      `FXPAK copy dry run: ${dryRun.status}; byte proof ${proof.status} for ${proof.destinationPath}.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "FXPAK copy proof failed.");
  }
}

function addMusicTrack(host: HostUpdate) {
  updateProject(host, (draft) => {
    const index = draft.assets.audio.musicTracks.length + 1;
    draft.assets.audio.musicTracks.push({
      id: `track-${index}`,
      name: `Music Track ${index}`,
      tempo: 120,
      patternRows: 64,
      estimatedBytes: 2048,
    });
  });
  pushConsole(host, "Added music tracker pattern.");
}

function addSoundEffect(host: HostUpdate) {
  updateProject(host, (draft) => {
    const index = draft.assets.audio.soundEffects.length + 1;
    draft.assets.audio.soundEffects.push({
      id: `sfx-${index}`,
      name: `Sound Effect ${index}`,
      priority: 4,
      estimatedBytes: 256,
      steps: [{ note: "C5", ticks: 8, instrument: "pulse", volume: 12 }],
    });
  });
  pushConsole(host, "Added sound-effect sequence.");
}

function estimateSoundEffectBytes(steps: SnesSoundEffectDraft["steps"]) {
  return Math.max(
    64,
    96 +
      steps.reduce(
        (sum, step) => sum + 4 + Math.max(1, step.ticks) * (step.instrument === "sample" ? 4 : 2),
        0,
      ),
  );
}

function refreshSoundEffectEstimate(effect: SnesSoundEffectDraft) {
  effect.estimatedBytes = estimateSoundEffectBytes(effect.steps);
}

function removeMusicTrack(host: HostUpdate, trackIndex: number) {
  updateProject(host, (draft) => {
    draft.assets.audio.musicTracks.splice(trackIndex, 1);
  });
  pushConsole(host, "Removed music tracker pattern.");
}

function removeSoundEffect(host: HostUpdate, effectIndex: number) {
  updateProject(host, (draft) => {
    draft.assets.audio.soundEffects.splice(effectIndex, 1);
  });
  pushConsole(host, "Removed sound-effect sequence.");
}

function addSoundEffectStep(host: HostUpdate, effectIndex: number) {
  updateProject(host, (draft) => {
    const effect = draft.assets.audio.soundEffects[effectIndex];
    if (!effect) return;
    effect.steps.push({ note: "C5", ticks: 8, instrument: "pulse", volume: 12 });
    refreshSoundEffectEstimate(effect);
  });
  pushConsole(host, "Added sound-effect step.");
}

function removeSoundEffectStep(host: HostUpdate, effectIndex: number, stepIndex: number) {
  updateProject(host, (draft) => {
    const effect = draft.assets.audio.soundEffects[effectIndex];
    if (!effect) return;
    effect.steps.splice(stepIndex, 1);
    if (effect.steps.length === 0) {
      effect.steps.push({ note: "C5", ticks: 8, instrument: "pulse", volume: 12 });
    }
    refreshSoundEffectEstimate(effect);
  });
  pushConsole(host, "Removed sound-effect step.");
}

function selectSoundPromptTarget(host: HostUpdate, target: SnesCreateTarget) {
  setCreateTarget(host, target);
  selectedMode = "edit";
  selectedPanel = "assets";
  host.requestUpdate?.();
}

function bindDraggedSoundPart(host: HostUpdate, key: SnesSoundBindingKey) {
  if (!draggedPart || draggedPart.kind !== "audio") {
    pushConsole(host, "Drop a music track or sound FX card here.");
    draggedPart = null;
    return;
  }
  soundBindings = { ...soundBindings, [key]: draggedPart.label };
  focusedGeneratedObjectId = draggedPart.id;
  selectedCreateTarget = "selected-object";
  pushConsole(host, `Bound ${draggedPart.label} to ${soundBindingLabels[key]}.`);
  draggedPart = null;
  draggedEntityId = null;
  host.requestUpdate?.();
}

const soundBindingLabels: Record<SnesSoundBindingKey, string> = {
  "level-music": "current level music",
  jump: "jump action",
  pickup: "pickup action",
  hit: "hit action",
  boss: "boss action",
  door: "door action",
};

function previewAgentPatchForSurface(
  host: HostUpdate,
  surface: SnesAiAuthoringSurface,
  targetOverride: SnesCreateTarget = selectedCreateTarget,
) {
  const provider = aiProviderBySurface[surface];
  const focusedObject =
    targetOverride === "selected-object" ? focusedEditableObjectCard() : undefined;
  pendingAgentProposal = createSnesAgentPatchProposalForSurface(
    surface,
    surfacePromptDraft(surface),
    project,
    provider,
  );
  pendingInlineReviewObjectId = focusedObject?.id ?? "";
  setAiActionFeedback(host, {
    status: "review",
    title: "Preview ready",
    detail: `${provider === "openclaw" ? "OpenClaw Agent" : "Codex"} prepared a change. Review it, then apply it only if you like it.`,
    provider,
    target: targetLabel(targetOverride),
  });
  if (focusedObject) {
    selectedMode = "edit";
    selectedPanel = focusedObject.editPanel === "scene" ? "scene" : focusedObject.editPanel;
  } else {
    selectedMode = "make";
    selectedPanel = "prompt";
  }
  pushConsole(host, `Prepared ${surface} patch preview: ${pendingAgentProposal.summary}`);
  host.requestUpdate?.();
}

function applyAgentPatchProposalNow(
  host: HostUpdate,
  proposal: SnesAgentPatchProposal,
  message: string,
) {
  persistSnapshot();
  rememberUndo();
  project = applySnesJsonPatch(project, proposal.operations);
  selectedSceneIndex = 0;
  saveProject();
  pendingAgentProposal = null;
  pendingInlineReviewObjectId = "";
  selectedPanel = panelForSurface(proposal.surface);
  selectedMode = selectedPanel === "export" ? "ship" : selectedPanel === "prompt" ? "make" : "edit";
  setAiActionFeedback(host, {
    status: "ready",
    title: "AI change applied",
    detail: `${proposal.requestedAgent === "openclaw" ? "OpenClaw Agent" : "Codex"} changed ${proposal.surface}. The result is open now, and you can test it or keep changing it.`,
    provider: proposal.requestedAgent,
    target: proposal.surface,
  });
  pushConsole(host, message);
  pushConsole(host, `Opened ${proposal.surface} editor so the generated result can be refined.`);
  for (const change of proposal.rationale.slice(0, 3)) {
    pushConsole(host, change);
  }
  host.requestUpdate?.();
}

function createEditableSurfaceFromPrompt(
  host: HostUpdate,
  surface: Exclude<SnesAiAuthoringSurface, "full-game">,
) {
  const provider = aiProviderBySurface[surface];
  try {
    setAiActionFeedback(host, {
      status: "working",
      title: "AI is building it",
      detail: `${provider === "openclaw" ? "OpenClaw Agent" : "Codex"} is creating ${targetLabel(selectedCreateTarget)}. The result will open where you can edit it.`,
      provider,
      target: targetLabel(selectedCreateTarget),
    });
    const record = queueVisibleAgentRun(host, provider, surface);
    markAgentRunStream(
      host,
      record,
      "streaming",
      `${provider === "openclaw" ? "OpenClaw" : "Codex"} is creating editable ${surface} data.`,
    );
    const proposal = createSnesAgentPatchProposalForSurface(
      surface,
      surfacePromptDraft(surface),
      project,
      provider,
    );
    applyAgentPatchProposalNow(
      host,
      proposal,
      `Created editable ${surface} with ${provider === "openclaw" ? "OpenClaw" : "Codex"} task ${record.id}.`,
    );
    agentDispatchQueue = agentDispatchQueue.filter((queued) => queued.id !== record.id);
    saveAgentDispatchQueue();
    markAgentRunStream(
      host,
      record,
      "complete",
      `Created editable ${surface}; review it in the opened editor.`,
      JSON.stringify({
        summary: proposal.summary,
        rationale: proposal.rationale,
        operations: proposal.operations,
      }),
    );
  } catch (error) {
    setAiActionFeedback(host, {
      status: "error",
      title: "AI could not finish",
      detail: error instanceof Error ? error.message : `Could not create ${surface}.`,
      provider,
      target: targetLabel(selectedCreateTarget),
    });
    pushConsole(host, error instanceof Error ? error.message : `Could not create ${surface}.`);
  } finally {
    host.requestUpdate?.();
  }
}

function downloadCodexTaskPacket(host: HostUpdate, surface: SnesAiAuthoringSurface = "full-game") {
  const packet = createSnesCodexTaskPacket(
    project,
    surfacePromptDraft(surface),
    new Date().toISOString(),
    aiProviderBySurface[surface],
    surface,
  );
  const blob = new Blob([`${JSON.stringify(packet, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.export.romBaseName || "openclaw-snes-game"}.codex-task.json`;
  link.click();
  URL.revokeObjectURL(url);
  pushConsole(host, "Exported OpenClaw/Codex task packet with approval-gated patch contract.");
}

function dispatchCodexTask(host: HostUpdate, surface: SnesAiAuthoringSurface = "full-game") {
  const provider = aiProviderBySurface[surface];
  const record = createSnesAgentDispatchRecord(
    project,
    surfacePromptDraft(surface),
    new Date().toISOString(),
    provider,
    surface,
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  selectedPanel = "prompt";
  pushConsole(
    host,
    `Queued ${provider === "openclaw" ? "OpenClaw" : "Codex"} ${surface} task ${record.id}; human approval remains required.`,
  );
  host.requestUpdate?.();
}

function sendAiPrompt(host: HostUpdate, surface: SnesAiAuthoringSurface = "full-game") {
  const provider = aiProviderBySurface[surface];
  const record = createSnesAgentDispatchRecord(
    project,
    surfacePromptDraft(surface),
    new Date().toISOString(),
    provider,
    surface,
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  selectedPanel = "prompt";
  pushConsole(
    host,
    `Sent ${provider === "openclaw" ? "OpenClaw" : "Codex"} ${surface} prompt ${record.id}; review the generated patch before applying it.`,
  );
  if (isGatewayLiveReady(host)) {
    void sendQueuedAgentTaskToGateway(host, record);
  } else {
    void runQueuedAgentTask(host, record);
  }
  host.requestUpdate?.();
}

async function runQueuedAgentTask(host: HostUpdate, record: SnesAgentDispatchRecord) {
  try {
    markAgentRunStream(
      host,
      record,
      "streaming",
      `Running local ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} generator.`,
    );
    const responseText = createSnesLocalAgentPatchResponse(record, project);
    const result = await runSnesAgentDispatchRecord(record, project, () => responseText);
    pendingAgentProposal = result.proposal;
    agentDispatchQueue = agentDispatchQueue.filter((queued) => queued.id !== record.id);
    saveAgentDispatchQueue();
    selectedPanel = "prompt";
    markAgentRunStream(
      host,
      record,
      "complete",
      "Local runner returned an approval-gated patch.",
      responseText,
    );
    setAiActionFeedback(host, {
      status: "review",
      title: "Local AI path verified",
      detail:
        "The prompt produced an editable patch preview. Review it, apply it, test it, or keep changing the game.",
      provider: record.requestedAgent,
      target: targetLabel(selectedCreateTarget),
    });
    pushConsole(
      host,
      `Ran local ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} agent and prepared approval-gated patches.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Queued agent task failed.";
    markAgentRunStream(host, record, "error", message);
    pushConsole(host, message);
  } finally {
    host.requestUpdate?.();
  }
}

function responseRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

function collectGatewayResponseText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectGatewayResponseText(entry, depth + 1));
  }
  const record = responseRecord(value);
  if (!record) {
    return [];
  }
  const preferredKeys = [
    "patch",
    "proposal",
    "json",
    "reply",
    "response",
    "message",
    "content",
    "text",
    "final",
    "output",
    "result",
    "data",
    "messages",
    "choices",
  ];
  return preferredKeys.flatMap((key) => collectGatewayResponseText(record[key], depth + 1));
}

type GatewayAgentPatchResult = {
  proposal: SnesAgentPatchProposal;
  responseText: string;
};

function parseGatewayAgentPatchResult(
  response: unknown,
  currentProject: SnesStudioProject,
  requestedAgent: SnesAgentProvider,
  surface: SnesAiAuthoringSurface,
): GatewayAgentPatchResult | null {
  const source = agentPatchSourceForProvider(requestedAgent);
  for (const candidate of collectGatewayResponseText(response)) {
    const text = unwrapJsonCodeFence(candidate);
    try {
      return {
        proposal: parseSnesAgentPatchProposalResponse(text, currentProject, source, surface),
        responseText: text,
      };
    } catch {
      try {
        const parsed = JSON.parse(text) as unknown;
        for (const nested of collectGatewayResponseText(parsed)) {
          const nestedText = unwrapJsonCodeFence(nested);
          try {
            return {
              proposal: parseSnesAgentPatchProposalResponse(
                nestedText,
                currentProject,
                source,
                surface,
              ),
              responseText: nestedText,
            };
          } catch {
            // Keep scanning other response fields; Gateway responses vary by provider.
          }
        }
      } catch {
        // Keep scanning other response fields; plain acknowledgement payloads are valid here.
      }
    }
  }
  return null;
}

function extractGatewayRunId(response: unknown, depth = 0): string | null {
  if (depth > 5 || response === null || response === undefined) {
    return null;
  }
  if (typeof response === "string") {
    return null;
  }
  if (Array.isArray(response)) {
    for (const entry of response) {
      const runId = extractGatewayRunId(entry, depth + 1);
      if (runId) {
        return runId;
      }
    }
    return null;
  }
  const record = responseRecord(response);
  if (!record) {
    return null;
  }
  for (const key of ["runId", "id", "targetRunId"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  for (const key of ["result", "response", "data", "payload"]) {
    const runId = extractGatewayRunId(record[key], depth + 1);
    if (runId) {
      return runId;
    }
  }
  return null;
}

async function requestGatewayAgentPatch(
  host: HostUpdate & { client: SnesGatewayClient },
  handoff: SnesGatewayAgentHandoff,
  currentProject: SnesStudioProject,
  requestedAgent: SnesAgentProvider,
  surface: SnesAiAuthoringSurface,
): Promise<GatewayAgentPatchResult | null> {
  const accepted = await host.client.request<unknown>(handoff.method, handoff.request, {
    timeoutMs: 15000,
  });
  const immediate = parseGatewayAgentPatchResult(accepted, currentProject, requestedAgent, surface);
  if (immediate) {
    return immediate;
  }
  const runId = extractGatewayRunId(accepted);
  if (!runId) {
    return null;
  }
  const wait = await host.client.request<unknown>(
    handoff.wait.method,
    { runId, timeoutMs: handoff.wait.timeoutMs },
    { timeoutMs: handoff.wait.timeoutMs + 5000 },
  );
  const waitPatch = parseGatewayAgentPatchResult(wait, currentProject, requestedAgent, surface);
  if (waitPatch) {
    return waitPatch;
  }
  const waitRecord = responseRecord(wait);
  const waitStatus = typeof waitRecord?.status === "string" ? waitRecord.status : "";
  if (waitStatus === "timeout" || waitStatus === "pending") {
    return null;
  }
  if (waitStatus === "error") {
    const detail =
      typeof waitRecord?.message === "string" ? waitRecord.message : "agent.wait failed";
    throw new Error(detail);
  }
  const history = await host.client.request<unknown>(
    handoff.history.method,
    {
      sessionKey: handoff.sessionKey,
      targetRunId: runId,
      limit: handoff.history.limit,
      maxChars: handoff.history.maxChars,
    },
    { timeoutMs: 15000 },
  );
  return parseGatewayAgentPatchResult(history, currentProject, requestedAgent, surface);
}

function setAgentTeamMemberReadiness(
  member: SnesAgentTeamMember,
  status: SnesAgentTeamReadiness["status"],
  detail: string,
  checkedAt: string,
  blocker?: string,
) {
  if (!agentTeamRun) {
    return;
  }
  agentTeamRun = {
    ...agentTeamRun,
    readiness: agentTeamRun.readiness.map((entry) =>
      entry.role === member.role
        ? {
            ...entry,
            status,
            detail,
            blocker,
            checkedAt,
          }
        : entry,
    ),
  };
}

function snesAgentWorkerWorkspace(member: SnesAgentTeamMember) {
  return `~/.openclaw/snes-studio-agents/${member.agentId ?? member.role}`;
}

async function listConfiguredSnesAgentIds(host: HostUpdate & { client: SnesGatewayClient }) {
  const response = await host.client.request<SnesGatewayAgentsListResult>(
    "agents.list",
    {},
    { timeoutMs: 10000 },
  );
  return new Set(
    (response.agents ?? [])
      .map((agent) => (typeof agent.id === "string" ? agent.id.trim() : ""))
      .filter(Boolean),
  );
}

async function readSnesAgentRuntimeStatus(host: HostUpdate & { client: SnesGatewayClient }) {
  try {
    const response = await host.client.request<SnesGatewayAgentsRuntimeStatusResult>(
      "agents.runtime.status",
      {},
      { timeoutMs: 10000 },
    );
    const localModels = response.localModels;
    const runtimeAvailable =
      localModels?.available !== false && localModels?.installedAvailable !== false;
    const detail = !runtimeAvailable
      ? (localModels?.error ??
        localModels?.installedError ??
        "The local OpenClaw model runtime is unavailable.")
      : "Local OpenClaw runtime telemetry is available.";
    return { runtimeAvailable, detail };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not inspect local model runtime status.";
    return {
      runtimeAvailable: false,
      detail: `Could not inspect local model runtime status. ${message}`,
    };
  }
}

function updateAgentTeamReadinessReportFromRun(checkedAt: string, title: string, detail: string) {
  if (!agentTeamRun) {
    return;
  }
  const roles: SnesAgentRoleReadiness[] = agentTeamRun.readiness.map((entry) => {
    const member = agentTeamRun!.members.find((candidate) => candidate.role === entry.role);
    const timedOut = /did not finish|within \d+ seconds|timed out|timeout/i.test(
      entry.blocker ?? entry.detail,
    );
    const invalid = /JSON|invalid/i.test(entry.blocker ?? entry.detail);
    const state: SnesAgentRoleReadiness["state"] =
      entry.status === "ready"
        ? "ready"
        : entry.status === "checking"
          ? "checking"
          : entry.status === "not-checked"
            ? "not-checked"
            : timedOut
              ? "timed-out"
              : invalid
                ? "invalid-response"
                : "unavailable";
    const blocker =
      entry.status === "blocked"
        ? {
            code: timedOut
              ? ("timeout" as const)
              : invalid
                ? ("invalid-response" as const)
                : ("agent-error" as const),
            message: entry.blocker ?? entry.detail,
            recommendedFix: timedOut
              ? "Confirm this worker is idle and has a working model, then use Check Again."
              : "Open the Agents dashboard, inspect this worker, then use Check Again.",
            canUseLocalFallback: true,
          }
        : undefined;
    return {
      role: entry.role,
      title: member?.title ?? entry.role,
      requestedAgent: entry.requestedAgent,
      sessionKey: entry.sessionKey,
      agentId: member?.agentId,
      state,
      configured: true,
      reachable: entry.status === "ready",
      responding: entry.status === "ready" || state === "invalid-response",
      validJsonReturned: entry.status === "ready",
      checkedAt: entry.checkedAt ?? checkedAt,
      detail: entry.detail,
      blocker,
    };
  });
  const blockers = roles.flatMap((entry) => (entry.blocker ? [entry.blocker] : []));
  agentTeamReadinessReport = {
    status:
      agentTeamRun.status === "ready"
        ? "ready"
        : agentTeamRun.status === "checking"
          ? "checking"
          : blockers.length > 0
            ? "unavailable"
            : "not-checked",
    title,
    detail,
    checkedAt,
    roles,
    blockers,
    localFallbackAvailable: true,
  };
}

async function ensureSnesOpenClawWorkerAgents(
  host: HostUpdate & { client: SnesGatewayClient },
  plan: SnesAgentTeamRun,
  checkedAt: string,
) {
  let configuredIds: Set<string>;
  try {
    configuredIds = await listConfiguredSnesAgentIds(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list configured agents.";
    agentTeamReadinessReport = createSnesAgentTeamReadinessPlan(project, agentGatewaySessionKey, {
      checkedAt,
      configuredAgentIds: [],
    });
    return {
      ok: false,
      detail: `Could not inspect configured OpenClaw agents. ${message}`,
      configuredIds: new Set<string>(),
    };
  }

  const missingWorkers = plan.members.filter(
    (member) =>
      member.requestedAgent === "openclaw" && member.agentId && !configuredIds.has(member.agentId),
  );
  for (const member of missingWorkers) {
    try {
      const created = await host.client.request<SnesGatewayAgentsCreateResult>(
        "agents.create",
        {
          name: member.agentId ?? member.title,
          workspace: snesAgentWorkerWorkspace(member),
        },
        { timeoutMs: 15000 },
      );
      if (created?.agentId) {
        configuredIds.add(created.agentId);
      } else if (member.agentId) {
        configuredIds.add(member.agentId);
      }
      pushConsole(host, `Created SNES Studio OpenClaw worker agent: ${member.title}.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${member.title} could not be created.`;
      setAgentTeamMemberReadiness(
        member,
        "blocked",
        `${member.title} needs setup before live OpenClaw can fill this role.`,
        checkedAt,
        `${message} Local game building still works.`,
      );
      pushConsole(host, `OpenClaw worker setup blocked for ${member.title}: ${message}`);
    }
  }

  const report = createSnesAgentTeamReadinessPlan(project, agentGatewaySessionKey, {
    checkedAt,
    configuredAgentIds: [...configuredIds],
  });
  agentTeamReadinessReport = report;
  const stillMissing = report.roles.filter((role) => role.state === "needs-setup");
  return {
    ok: stillMissing.length === 0,
    detail: stillMissing.length
      ? summarizeSnesAgentTeamBlockers(report)
      : "All SNES Studio OpenClaw worker agents are configured.",
    configuredIds,
  };
}

function automaticAgentTeamCheckDisabled() {
  try {
    return new URL(globalThis.location?.href ?? "http://openclaw.local/").searchParams.has(
      "__openclaw_skip_auto_agent_team",
    );
  } catch {
    return false;
  }
}

function maybeAutoCheckSnesAgentTeam(host: HostUpdate) {
  if (automaticAgentTeamCheckDisabled()) {
    return;
  }
  if (agentTeamAutoCheckStarted || liveAgentProofState.status === "running") {
    return;
  }
  if (agentTeamRun?.status === "ready" || agentTeamRun?.status === "blocked") {
    return;
  }
  const readiness = probeSnesLiveAiReadiness(host);
  if (readiness.status !== "ready") {
    return;
  }
  agentTeamAutoCheckStarted = true;
  globalThis.setTimeout(() => {
    void connectSnesAgentTeam(host, { automatic: true });
  }, 0);
}

async function connectSnesAgentTeam(host: HostUpdate, options: { automatic?: boolean } = {}) {
  if (options.automatic && liveAiProductionProofState.status !== "idle") {
    return;
  }
  const checkedAt = new Date().toISOString();
  const prompt =
    surfacePromptDraft("full-game").trim() ||
    project.gameBrief?.prompt ||
    project.aiProductionRun?.prompt ||
    project.name;
  const plan = createSnesAgentTeamPlan(project, prompt, {
    createdAt: checkedAt,
    sessionKey: agentGatewaySessionKey,
  });
  agentTeamRun = {
    ...plan,
    status: "checking",
    readiness: plan.readiness.map((entry) => ({
      ...entry,
      status: "not-checked",
      detail: "Queued for role readiness check.",
      checkedAt,
    })),
  };
  agentTeamReadinessReport = {
    ...createSnesAgentTeamReadinessPlan(project, agentGatewaySessionKey, { checkedAt }),
    status: "checking",
    title: "Checking live OpenClaw",
    detail: "Inspecting SNES Studio worker agents and local runtime without spending model calls.",
  };
  selectedPanel = "prompt";

  const readiness = probeSnesLiveAiReadiness(host);
  if (readiness.status !== "ready") {
    agentTeamRun = {
      ...agentTeamRun,
      status: "blocked",
      readiness: agentTeamRun.readiness.map((entry) => ({
        ...entry,
        status: "blocked",
        detail: readiness.detail,
        blocker: readiness.blockers.join(" ") || readiness.detail,
        checkedAt,
      })),
    };
    updateAgentTeamReadinessReportFromRun(checkedAt, "Live OpenClaw unavailable", readiness.detail);
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: "Live OpenClaw unavailable",
      detail: readiness.detail,
      checkedAt,
    });
    pushConsole(host, `Live AI team unavailable: ${readiness.detail}`);
    return;
  }

  const liveHost = host as HostUpdate & { client: SnesGatewayClient };
  setLiveAgentProofState(host, {
    status: "idle",
    title: "Checking live OpenClaw setup",
    detail: "Checking Gateway auth, worker configuration, and local runtime.",
    checkedAt,
  });
  host.requestUpdate?.();

  const workerSetup = await ensureSnesOpenClawWorkerAgents(liveHost, plan, checkedAt);
  if (!workerSetup.ok) {
    agentTeamRun = {
      ...agentTeamRun,
      status: "blocked",
      readiness: agentTeamRun.readiness.map((entry) => {
        const member = agentTeamRun!.members.find((candidate) => candidate.role === entry.role);
        if (!member?.agentId || workerSetup.configuredIds.has(member.agentId)) {
          return entry;
        }
        return {
          ...entry,
          status: "blocked",
          detail: `${member.title} is not configured as a live OpenClaw worker yet.`,
          blocker: `${member.title} needs the ${member.agentId} worker agent. Local game building still works.`,
          checkedAt,
        };
      }),
    };
    setLiveAgentProofState(host, {
      status: "failed",
      title: "Live OpenClaw unavailable",
      detail: workerSetup.detail,
      checkedAt,
    });
    pushConsole(host, `Live OpenClaw unavailable: ${workerSetup.detail}`);
    return;
  }
  if (options.automatic && liveAiProductionProofState.status !== "idle") {
    return;
  }

  const runtime = await readSnesAgentRuntimeStatus(liveHost);
  const fastReport = createSnesAgentTeamReadinessPlan(project, agentGatewaySessionKey, {
    checkedAt,
    configuredAgentIds: [...workerSetup.configuredIds],
    runtimeAvailable: runtime.runtimeAvailable,
    runtimeDetail: runtime.detail,
    proofPassed: liveAiProductionProofState.status === "passed",
  });
  agentTeamReadinessReport = fastReport;
  setLiveAgentProofState(host, {
    status: runtime.runtimeAvailable ? "idle" : "needs-setup",
    title: runtime.runtimeAvailable ? "Live proof pending" : "Live OpenClaw unavailable",
    detail: runtime.runtimeAvailable
      ? "Required workers are configured. Run Live Production Check when you want model-backed proof."
      : runtime.detail,
    checkedAt,
  });
  agentTeamRun = {
    ...agentTeamRun,
    status: runtime.runtimeAvailable ? "ready" : "blocked",
    readiness: agentTeamRun.readiness.map((entry) => ({
      ...entry,
      status: runtime.runtimeAvailable ? "ready" : "blocked",
      detail: runtime.runtimeAvailable
        ? "Configured, waiting for first live proof."
        : runtime.detail,
      blocker: runtime.runtimeAvailable ? undefined : runtime.detail,
      checkedAt,
    })),
  };
  if (!runtime.runtimeAvailable) {
    pushConsole(host, `Live OpenClaw unavailable: ${runtime.detail}`);
    return;
  }
  pushConsole(host, "Live OpenClaw setup is configured. Live proof is pending.");
}

function liveAgentProviderLabel(provider: SnesAgentProvider) {
  return provider === "openclaw" ? "OpenClaw Agent" : "Codex";
}

function agentPatchSourceForProvider(
  provider: SnesAgentProvider,
): SnesAgentPatchProposal["source"] {
  return provider === "openclaw" ? "openclaw-agent" : "openclaw-codex";
}

function setLiveAgentProofState(host: HostUpdate, state: SnesLiveAgentProofState) {
  liveAgentProofState = state;
  host.requestUpdate?.();
}

function setLiveAiProductionProofState(host: HostUpdate, state: SnesLiveAgentProofState) {
  liveAiProductionProofState = state;
  host.requestUpdate?.();
}

function latestAgentStreamForRecord(recordId: string) {
  return agentStreamRecords.find((stream) => stream.recordId === recordId);
}

async function runLiveAiProductionProof(host: HostUpdate) {
  agentTeamAutoCheckStarted = true;
  const checkedAt = new Date().toISOString();
  const prompt =
    surfacePromptDraft("full-game").trim() ||
    project.gameBrief?.prompt ||
    project.aiProductionRun?.prompt ||
    project.name;
  const readiness = probeSnesLiveAiReadiness(host);
  if (readiness.status !== "ready") {
    const detail = readiness.detail;
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: readiness.title,
      detail,
      checkedAt,
    });
    setLiveAiProductionProofState(host, {
      status: "needs-setup",
      title: readiness.title,
      detail,
      checkedAt,
    });
    selectedPanel = "prompt";
    pushConsole(host, `Live AI production route blocked: ${detail}`);
    return;
  }

  const plan = createSnesAiProductionGatewayPlan(project, prompt, {
    createdAt: checkedAt,
    sessionKey: agentGatewaySessionKey,
  });
  const preparingState = {
    status: "running" as const,
    title: "Preparing live AI production route",
    detail: "Checking Gateway auth, worker configuration, and local runtime before model proof.",
    checkedAt,
  };
  setLiveAgentProofState(host, preparingState);
  setLiveAiProductionProofState(host, preparingState);
  const liveHost = host as HostUpdate & { client: SnesGatewayClient };
  const teamPlan = createSnesAgentTeamPlan(project, prompt, {
    createdAt: checkedAt,
    sessionKey: agentGatewaySessionKey,
  });
  const workerSetup = await ensureSnesOpenClawWorkerAgents(liveHost, teamPlan, checkedAt);
  if (!workerSetup.ok) {
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: "Live OpenClaw workers need setup",
      detail: workerSetup.detail,
      checkedAt,
    });
    setLiveAiProductionProofState(host, {
      status: "needs-setup",
      title: "Live OpenClaw workers need setup",
      detail: workerSetup.detail,
      checkedAt,
    });
    setAiActionFeedback(host, {
      status: "error",
      title: "Live OpenClaw workers need setup",
      detail: `${workerSetup.detail} Build With OpenClaw can still create a local editable draft now.`,
      provider: "openclaw",
      target: "Whole Game",
    });
    selectedPanel = "prompt";
    pushConsole(host, `Live AI production route blocked: ${workerSetup.detail}`);
    return;
  }
  const runtime = await readSnesAgentRuntimeStatus(liveHost);
  if (!runtime.runtimeAvailable) {
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: "Live OpenClaw runtime unavailable",
      detail: runtime.detail,
      checkedAt,
    });
    setLiveAiProductionProofState(host, {
      status: "needs-setup",
      title: "Live OpenClaw runtime unavailable",
      detail: runtime.detail,
      checkedAt,
    });
    setAiActionFeedback(host, {
      status: "error",
      title: "Live OpenClaw runtime unavailable",
      detail: `${runtime.detail} Build With OpenClaw can still create a local editable draft now.`,
      provider: "openclaw",
      target: "Whole Game",
    });
    selectedPanel = "prompt";
    pushConsole(host, `Live AI production route blocked: ${runtime.detail}`);
    return;
  }
  selectedPanel = "prompt";
  setLiveAgentProofState(host, {
    status: "running",
    title: "Checking live AI production route",
    detail: `Sending ${plan.stages.length} staged Gateway jobs to ${plan.sessionKey}.`,
    checkedAt,
  });
  setLiveAiProductionProofState(host, {
    status: "running",
    title: "Checking live AI production route",
    detail: `Sending ${plan.stages.length} staged Gateway jobs to ${plan.sessionKey}.`,
    checkedAt,
  });
  setAiActionFeedback(host, {
    status: "working",
    title: "Checking Codex-supervised OpenClaw route",
    detail:
      "Codex Architect, OpenClaw Game Team, and Codex QA are being asked for approval-gated JSON through Gateway.",
    provider: "openclaw",
    target: "Whole Game",
  });

  let acceptedStages = 0;
  let returnedPatchStages = 0;
  let lastProposal: SnesAgentPatchProposal | null = null;
  const failedStages: string[] = [];
  const completedRecordIds: string[] = [];
  for (const stage of plan.stages) {
    const record = stage.record;
    const teamMember = teamPlan.members.find((member) => member.role === stage.role);
    if (teamMember) {
      setAgentTeamMemberReadiness(
        teamMember,
        "checking",
        `${teamMember.title} live proof is running.`,
        checkedAt,
      );
      updateAgentTeamReadinessReportFromRun(
        checkedAt,
        "Live proof running",
        "Running one Codex/OpenClaw stage at a time.",
      );
    }
    agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
    saveAgentDispatchQueue();
    globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
    markAgentRunStream(
      host,
      record,
      "streaming",
      `${stage.title} sent to ${stage.handoff.sessionKey}.`,
    );
    try {
      let returned: GatewayAgentPatchResult | null = null;
      for (const attempt of [1, 2]) {
        returned = await requestGatewayAgentPatch(
          liveHost,
          stage.handoff,
          project,
          stage.requestedAgent,
          stage.surface,
        );
        if (returned || attempt === 2) {
          break;
        }
        pushConsole(host, `${stage.title} did not return JSON on attempt 1; retrying once.`);
      }
      acceptedStages += 1;
      if (returned) {
        returnedPatchStages += 1;
        lastProposal = returned.proposal;
        completedRecordIds.push(record.id);
        if (teamMember) {
          setAgentTeamMemberReadiness(
            teamMember,
            "ready",
            `${teamMember.title} live proof passed.`,
            checkedAt,
          );
        }
        markAgentRunStream(
          host,
          record,
          "complete",
          `${stage.title} returned approval-gated JSON.`,
          returned.responseText,
        );
      } else {
        const message = `${stage.title} timed out during live proof or did not return approval-gated JSON.`;
        failedStages.push(message);
        if (teamMember) {
          setAgentTeamMemberReadiness(teamMember, "blocked", message, checkedAt, message);
        }
        markAgentRunStream(host, record, "error", message);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${stage.title} failed.`;
      failedStages.push(`${stage.title}: ${message}`);
      if (teamMember) {
        setAgentTeamMemberReadiness(teamMember, "blocked", message, checkedAt, message);
      }
      markAgentRunStream(host, record, "error", message);
      break;
    }
    updateAgentTeamReadinessReportFromRun(
      checkedAt,
      "Live proof running",
      `${returnedPatchStages}/${plan.stages.length} stages returned approval-gated JSON.`,
    );
  }

  if (lastProposal) {
    pendingAgentProposal = lastProposal;
  }
  agentDispatchQueue = agentDispatchQueue.filter(
    (queued) => !completedRecordIds.includes(queued.id),
  );
  saveAgentDispatchQueue();

  if (failedStages.length > 0) {
    setLiveAgentProofState(host, {
      status: "failed",
      title: "Live production route failed",
      detail: failedStages.join(" "),
      checkedAt,
    });
    setLiveAiProductionProofState(host, {
      status: "failed",
      title: "Live production route failed",
      detail: failedStages.join(" "),
      checkedAt,
    });
    agentTeamRun = agentTeamRun ? { ...agentTeamRun, status: "blocked" } : agentTeamRun;
    updateAgentTeamReadinessReportFromRun(
      checkedAt,
      "Live OpenClaw unavailable",
      failedStages.join(" "),
    );
    setAiActionFeedback(host, {
      status: "error",
      title: "Live AI production needs setup",
      detail: failedStages.join(" "),
      provider: "openclaw",
      target: "Whole Game",
    });
    return;
  }

  if (returnedPatchStages === plan.stages.length) {
    setLiveAgentProofState(host, {
      status: "passed",
      title: "Live production route verified",
      detail:
        "Codex Architect, OpenClaw Game Team, and Codex QA each returned approval-gated JSON through Gateway. Review the latest patch before applying it.",
      checkedAt,
      recordId: plan.stages[plan.stages.length - 1]?.record.id,
    });
    setLiveAiProductionProofState(host, {
      status: "passed",
      title: "Live production route verified",
      detail:
        "Codex Architect, OpenClaw Game Team, and Codex QA each returned approval-gated JSON through Gateway. Review the latest patch before applying it.",
      checkedAt,
      recordId: plan.stages[plan.stages.length - 1]?.record.id,
    });
    agentTeamRun = agentTeamRun ? { ...agentTeamRun, status: "ready" } : agentTeamRun;
    updateAgentTeamReadinessReportFromRun(
      checkedAt,
      "Live OpenClaw ready",
      "Live proof passed. Codex/OpenClaw stages returned approval-gated JSON through Gateway.",
    );
    setAiActionFeedback(host, {
      status: "review",
      title: "Codex-supervised OpenClaw route verified",
      detail:
        "The live route returned editable JSON. Review the pending change, apply it, test it, or ask OpenClaw for another pass.",
      provider: "openclaw",
      target: "Whole Game",
    });
    pushConsole(
      host,
      `Live AI production route verified: ${returnedPatchStages}/${plan.stages.length} stages returned approval-gated JSON.`,
    );
    return;
  }

  setLiveAiProductionProofState(host, {
    status: "needs-setup",
    title: "Gateway accepted, result return not complete",
    detail: `Gateway accepted ${acceptedStages}/${plan.stages.length} staged jobs, but only ${returnedPatchStages}/${plan.stages.length} returned approval-gated JSON. Configure the live Codex/OpenClaw result return path or import returned patch JSON manually.`,
    checkedAt,
  });
  setAiActionFeedback(host, {
    status: "error",
    title: "Gateway route accepted",
    detail:
      "The staged AI jobs were sent. Full live verification still needs each stage to return approval-gated JSON.",
    provider: "openclaw",
    target: "Whole Game",
  });
  pushConsole(
    host,
    `Gateway accepted ${acceptedStages}/${plan.stages.length} live AI production stages; ${returnedPatchStages}/${plan.stages.length} returned patch JSON.`,
  );
}

async function runLiveAgentProof(host: HostUpdate) {
  const provider = aiProviderBySurface["full-game"];
  const providerLabel = liveAgentProviderLabel(provider);
  const checkedAt = new Date().toISOString();
  const readiness = probeSnesLiveAiReadiness(host);
  if (readiness.status !== "ready") {
    const detail = readiness.detail;
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: readiness.title,
      detail,
      checkedAt,
    });
    selectedPanel = "prompt";
    pushConsole(host, `Live agent proof blocked: ${detail}`);
    return;
  }

  const record = createSnesAgentDispatchRecord(
    project,
    `SNES Studio live proof: return an approval-gated JSON patch for ${project.name}. Keep the change small, editable, and hardware-safe.`,
    checkedAt,
    provider,
    "full-game",
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  selectedPanel = "prompt";
  setLiveAgentProofState(host, {
    status: "running",
    title: "Checking live agent",
    detail: `${providerLabel} prompt sent to ${agentGatewaySessionKey}. Waiting for editable patch JSON.`,
    checkedAt,
    recordId: record.id,
  });

  await sendQueuedAgentTaskToGateway(host, record);
  const stream = latestAgentStreamForRecord(record.id);
  if (stream?.status === "complete" && pendingAgentProposal) {
    setLiveAgentProofState(host, {
      status: "passed",
      title: "Live agent proof passed",
      detail: `${providerLabel} returned editable patch JSON. Review it before applying the change.`,
      checkedAt,
      recordId: record.id,
    });
    pushConsole(host, `Live agent proof passed with ${providerLabel} task ${record.id}.`);
    return;
  }
  if (stream?.status === "error") {
    setLiveAgentProofState(host, {
      status: "failed",
      title: "Live agent proof failed",
      detail: stream.chunk ?? "Gateway agent handoff failed before a patch was returned.",
      checkedAt,
      recordId: record.id,
    });
    return;
  }
  setLiveAgentProofState(host, {
    status: "needs-setup",
    title: "Gateway accepted, no patch yet",
    detail:
      "The session accepted the prompt but did not return editable patch JSON in this request. Check the live result stream or use local preview.",
    checkedAt,
    recordId: record.id,
  });
}

async function runLocalAgentProof(host: HostUpdate) {
  const provider = aiProviderBySurface["full-game"];
  const providerLabel = liveAgentProviderLabel(provider);
  const checkedAt = new Date().toISOString();
  const record = createSnesAgentDispatchRecord(
    project,
    `SNES Studio local proof: return an approval-gated JSON patch for ${project.name}. Keep the change small, editable, and hardware-safe.`,
    checkedAt,
    provider,
    "full-game",
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  selectedPanel = "prompt";
  setLiveAgentProofState(host, {
    status: "running",
    title: "Checking local agent",
    detail: `${providerLabel} is using the local approval-gated patch runner. Live Gateway proof stays separate.`,
    checkedAt,
    recordId: record.id,
  });
  await runQueuedAgentTask(host, record);
  const stream = latestAgentStreamForRecord(record.id);
  if (stream?.status === "complete" && pendingAgentProposal) {
    setLiveAgentProofState(host, {
      status: "passed",
      title: "Local agent proof passed",
      detail:
        "Local OpenClaw/Codex generation returned editable patch JSON. Review it before applying; Gateway live proof still needs a connected session.",
      checkedAt,
      recordId: record.id,
    });
    pushConsole(host, `Local agent proof passed with ${providerLabel} task ${record.id}.`);
    return;
  }
  setLiveAgentProofState(host, {
    status: "failed",
    title: "Local agent proof failed",
    detail: stream?.chunk ?? "Local OpenClaw/Codex runner did not return editable patch JSON.",
    checkedAt,
    recordId: record.id,
  });
}

async function sendQueuedAgentTaskToGateway(host: HostUpdate, record: SnesAgentDispatchRecord) {
  if (!isGatewayLiveReady(host)) {
    pushConsole(host, "Gateway agent bridge is unavailable until the dashboard is connected.");
    return;
  }
  try {
    const handoff = createSnesGatewayAgentHandoff(record, {
      sessionKey: agentGatewaySessionKey,
    });
    markAgentRunStream(
      host,
      record,
      "streaming",
      `Sent ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} task to Gateway session ${handoff.sessionKey}.`,
    );
    const returned = await requestGatewayAgentPatch(
      host,
      handoff,
      project,
      record.requestedAgent,
      record.surface,
    );
    if (returned) {
      pendingAgentProposal = returned.proposal;
      agentDispatchQueue = agentDispatchQueue.filter((queued) => queued.id !== record.id);
      saveAgentDispatchQueue();
      selectedPanel = "prompt";
      markAgentRunStream(
        host,
        record,
        "complete",
        "Gateway returned an approval-gated patch.",
        returned.responseText,
      );
      setLiveAgentProofState(host, {
        status: "passed",
        title: "Live agent preview ready",
        detail:
          "The connected agent returned editable patch JSON. Review it on this screen before applying.",
        checkedAt: new Date().toISOString(),
        recordId: record.id,
      });
      setAiActionFeedback(host, {
        status: "review",
        title: "OpenClaw AI change ready",
        detail:
          "The connected agent returned an editable change preview. Review it before anything changes.",
        provider: record.requestedAgent,
        target: targetLabel(selectedCreateTarget),
      });
      pushConsole(
        host,
        `Received Gateway ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} patch; review before approving.`,
      );
    } else {
      markAgentRunStream(
        host,
        record,
        "streaming",
        `Gateway accepted the task; waiting for returned patch JSON in ${SNES_AGENT_RESULT_QUEUE_KEY}.`,
      );
      setAiActionFeedback(host, {
        status: "working",
        title: "OpenClaw accepted the prompt",
        detail:
          "The agent accepted the task. SNES Studio is waiting for an editable change preview before anything changes.",
        provider: record.requestedAgent,
        target: targetLabel(selectedCreateTarget),
      });
      pushConsole(
        host,
        `Sent ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} task to Gateway session ${handoff.sessionKey}; waiting for returned patch JSON.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gateway agent handoff failed.";
    markAgentRunStream(host, record, "error", message);
    setAiActionFeedback(host, {
      status: "error",
      title: "OpenClaw AI needs setup",
      detail: message,
      provider: record.requestedAgent,
      target: targetLabel(selectedCreateTarget),
    });
    pushConsole(host, message);
  } finally {
    host.requestUpdate?.();
  }
}

function importAgentResult(host: HostUpdate, record: SnesAgentResultRecord) {
  try {
    pendingAgentProposal = createSnesAgentPatchProposalFromResult(record, project);
    agentResultQueue = agentResultQueue.filter((queued) => queued.id !== record.id);
    agentDispatchQueue = agentDispatchQueue.filter((queued) => queued.id !== record.recordId);
    saveAgentResultQueue();
    saveAgentDispatchQueue();
    selectedPanel = "prompt";
    pushConsole(
      host,
      `Imported ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"} ${record.surface} result; review before approving.`,
    );
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Agent result import failed.");
  }
}

function importAgentPatchFromJson(host: HostUpdate) {
  try {
    pendingAgentProposal = parseSnesAgentPatchProposalResponse(agentPatchDraft, project);
    selectedPanel = "prompt";
    pushConsole(host, `Imported agent patch preview: ${pendingAgentProposal.summary}`);
  } catch (error) {
    pendingAgentProposal = null;
    pushConsole(host, error instanceof Error ? error.message : "Agent patch import failed.");
  }
}

function approveAgentPatch(host: HostUpdate) {
  if (!pendingAgentProposal) {
    return;
  }
  const proposal = pendingAgentProposal;
  applyAgentPatchProposalNow(host, proposal, `Approved agent patch preview for ${project.name}.`);
}

function discardAgentPatch(host: HostUpdate) {
  pendingAgentProposal = null;
  pendingInlineReviewObjectId = "";
  pushConsole(host, "Discarded pending agent patch preview.");
  host.requestUpdate?.();
}

function fixReadinessIssue(host: HostUpdate, code: string) {
  const normalizedCode = code.toUpperCase();
  if (normalizedCode === "ROM_NAME_REQUIRED") {
    updateProject(host, (draft) => {
      draft.export.romBaseName =
        draft.export.romBaseName || draft.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    });
    pushConsole(host, "Fixed missing ROM filename.");
    return;
  }
  if (normalizedCode === "SAVE_FIELDS_EMPTY") {
    addSaveField(host);
    return;
  }
  if (normalizedCode === "AUDIO_MUSIC_EMPTY") {
    addMusicTrack(host);
    return;
  }
  if (normalizedCode === "AUDIO_SFX_EMPTY") {
    addSoundEffect(host);
    return;
  }
  repairPlayablePreview(host);
}

function renderAiCreatorCard(
  host: HostUpdate,
  entry: ReturnType<typeof createSnesAiAuthoringPrompts>[number],
) {
  const selectedProvider = aiProviderBySurface[entry.surface];
  return html`
    <article class="snes-ai-card">
      <div>
        <span>${entry.surface}</span>
        <strong>${entry.title}</strong>
        <p>${entry.description}</p>
      </div>
      <label>
        Prompt
        <textarea
          rows="5"
          .value=${surfacePromptDraft(entry.surface)}
          placeholder=${entry.placeholder}
          @input=${(event: Event) => updateAiPrompt(entry.surface, inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-provider-toggle" aria-label=${`${entry.title} AI provider`}>
        ${(["openclaw", "codex"] as const).map(
          (provider) => html`
            <button
              type="button"
              class=${selectedProvider === provider ? "active" : ""}
              @click=${() => setAiProvider(host, entry.surface, provider)}
            >
              ${provider === "openclaw" ? "OpenClaw" : "Codex"}
            </button>
          `,
        )}
      </div>
      <div class="snes-toolbar">
        <button
          type="button"
          class="primary snes-send-command"
          @click=${() =>
            entry.surface === "full-game"
              ? createGameFromPrompt(host)
              : createEditableSurfaceFromPrompt(host, entry.surface)}
          aria-label=${entry.surface === "full-game"
            ? `Create full game with ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}`
            : `Create and edit ${entry.surface} with ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}`}
        >
          ${entry.surface === "full-game" ? "Create Game with" : "Create & Edit with"}
          ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}
        </button>
        <button type="button" @click=${() => previewAgentPatchForSurface(host, entry.surface)}>
          Preview Agent Patch
        </button>
        ${entry.surface === "full-game"
          ? html`
              <button
                type="button"
                @click=${() => previewAgentPatchForSurface(host, entry.surface)}
              >
                Generate Entire Game
              </button>
            `
          : nothing}
        <button type="button" @click=${() => sendAiPrompt(host, entry.surface)}>
          Ask Gateway Agent
        </button>
        <button type="button" @click=${() => downloadCodexTaskPacket(host, entry.surface)}>
          Export Codex Task
        </button>
        <button type="button" @click=${() => dispatchCodexTask(host, entry.surface)}>
          Queue ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"} Task
        </button>
        <button type="button" @click=${() => selectPanel(host, panelForSurface(entry.surface))}>
          Edit This
        </button>
      </div>
    </article>
  `;
}

function renderGeneratedObjectInspector(host: HostUpdate) {
  const objects = createSnesGeneratedObjectSummary(project);
  const filters: Array<{ id: SnesGeneratedObjectFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "entities", label: "Characters" },
    { id: "story", label: "Story" },
    { id: "audio", label: "Audio" },
    { id: "hardware", label: "Hardware" },
  ];
  const visibleObjects = objects.filter((object) => {
    if (generatedObjectFilter === "all") {
      return true;
    }
    if (generatedObjectFilter === "entities") {
      return object.kind === "entity" || object.kind === "animation";
    }
    if (generatedObjectFilter === "story") {
      return object.kind === "dialogue" || object.kind === "event";
    }
    if (generatedObjectFilter === "audio") {
      return object.kind === "audio";
    }
    return object.kind === "save" || object.kind === "export";
  });
  return html`
    <div class="snes-generated-inspector">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Generated Object Inspector</span>
          <strong>Edit anything AI creates</strong>
          <p>
            ${visibleObjects.length}/${objects.length} editable generated
            object${objects.length === 1 ? "" : "s"}.
          </p>
        </div>
        <button type="button" @click=${() => repairPlayablePreview(host)}>Make Playable</button>
      </div>
      <div class="snes-generated-filter" aria-label="Generated object groups">
        ${filters.map(
          (filter) => html`
            <button
              type="button"
              class=${generatedObjectFilter === filter.id ? "active" : ""}
              @click=${() => {
                generatedObjectFilter = filter.id;
                pushConsole(host, `Showing ${filter.label.toLowerCase()} generated objects.`);
              }}
            >
              ${filter.label}
            </button>
          `,
        )}
      </div>
      <div class="snes-generated-inspector__grid">
        ${visibleObjects.slice(0, 12).map(
          (object) => html`
            <article
              class=${focusedGeneratedObjectId === object.id ? "active" : ""}
              draggable=${object.kind === "entity" ? "true" : "false"}
              @dragstart=${() => {
                if (object.kind !== "entity") {
                  return;
                }
                const [sceneId, entityId] = object.id.split(":");
                const sceneIndex = project.scenes.findIndex((scene) => scene.id === sceneId);
                if (sceneIndex >= 0 && entityId) {
                  selectedSceneIndex = sceneIndex;
                  draggedEntityId = entityId;
                  pushConsole(host, `Dragging ${object.label}; drop it onto the level grid.`);
                }
              }}
            >
              <span>${object.kind}</span>
              <strong>${object.label}</strong>
              <p>${objectCardDisplayDetail(object)}</p>
              <button
                type="button"
                aria-label=${`Edit ${object.label}`}
                @click=${() => {
                  focusedGeneratedObjectId = object.id;
                  selectedPanel = object.editPanel;
                  pushConsole(host, `Focused ${object.label} in ${object.editPanel}.`);
                }}
              >
                Edit
              </button>
            </article>
          `,
        )}
      </div>
    </div>
  `;
}

function renderMeter(meter: SnesBudgetMeter) {
  const percent = Math.round(meter.ratio * 100);
  return html`
    <div class="snes-meter snes-meter--${meter.severity}">
      <div class="snes-meter__top">
        <span>${meter.label}</span>
        <strong>${percent}%</strong>
      </div>
      <div class="snes-meter__track">
        <span style=${`width:${Math.min(100, percent)}%`}></span>
      </div>
      <small>${formatMeterValue(meter)}</small>
    </div>
  `;
}

function playtestMarkerStyle(
  scene: NonNullable<ReturnType<typeof selectedScene>>,
  x: number,
  y: number,
  followCamera = true,
) {
  const visibleWidth = 256;
  const height = Math.max(1, scene.heightMetatiles * 16);
  const cameraX = followCamera ? (previewSimulationState?.cameraScrollX ?? 0) : 0;
  const left = Math.max(4, Math.min(96, ((x - cameraX) / visibleWidth) * 100));
  const top = Math.max(0, Math.min(92, (y / height) * 100));
  return `left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;`;
}

function runtimeProofStatusClass(check: SnesPreviewRomValidationCheck | undefined) {
  if (!check) {
    return "blocked";
  }
  return check.passed ? "pass" : "blocked";
}

function runtimeProofStatusLabel(check: SnesPreviewRomValidationCheck | undefined) {
  if (!check) {
    return "missing";
  }
  return check.passed ? "pass" : "blocked";
}

function renderRomRuntimeProof() {
  try {
    const artifact = buildSnesPreviewRom(project);
    const proof = validateSnesPreviewRomArtifact(artifact);
    const checksByCode = new Map(proof.checks.map((check) => [check.code, check]));
    return html`
      <div class="snes-runtime-gates snes-runtime-gates--proof" aria-label="ROM Runtime Proof">
        <div class="snes-runtime-gates__title">
          <strong>ROM Runtime Proof</strong>
          <small>${artifact.fileName}; static checks ${proof.valid ? "passing" : "blocked"}</small>
        </div>
        ${runtimeProofGates.map((gate) => {
          const check = checksByCode.get(gate.code);
          return html`
            <article
              class=${`snes-runtime-proof snes-runtime-proof--${runtimeProofStatusClass(check)}`}
            >
              <span>${gate.gap}</span>
              <strong>${gate.label}</strong>
              <small>${runtimeProofStatusLabel(check)} - ${gate.userProof}</small>
            </article>
          `;
        })}
      </div>
    `;
  } catch (error) {
    return html`
      <div class="snes-runtime-gates snes-runtime-gates--proof" aria-label="ROM Runtime Proof">
        <div class="snes-runtime-gates__title">
          <strong>ROM Runtime Proof</strong>
          <small>blocked</small>
        </div>
        <article class="snes-runtime-proof snes-runtime-proof--blocked">
          <span>Build</span>
          <strong>Preview ROM unavailable</strong>
          <small>${error instanceof Error ? error.message : "Static ROM validation failed."}</small>
        </article>
      </div>
    `;
  }
}

function renderPlaytestFeedback() {
  const feedback =
    lastPlaytestFeedback ??
    ({
      tone: "ready",
      title: "Ready to test",
      detail: "Press Start, Move Right, Jump, or Auto Run to see what changes.",
    } satisfies SnesPlaytestFeedback);
  return html`
    <section
      class=${`snes-playtest-feedback snes-playtest-feedback--${feedback.tone}`}
      aria-label="What just happened"
      aria-live="polite"
    >
      <span>What Just Happened</span>
      <h4>${feedback.title}</h4>
      <p>${feedback.detail}</p>
    </section>
  `;
}

function renderPlaytestOutcomeOverlay(host: HostUpdate, state: SnesPreviewSimulationState | null) {
  if (!state || state.status === "playing") {
    return nothing;
  }
  const won = state.status === "won";
  return html`
    <div class=${`snes-playtest__outcome snes-playtest__outcome--${state.status}`} role="status">
      <strong>${won ? "Goal reached" : "Try again"}</strong>
      <span>
        ${won
          ? "This level can be won. Export it or make it more fun."
          : "The hero lost. Restart, move the danger, or ask AI to make it easier."}
      </span>
      <div>
        <button type="button" class="primary" @click=${() => restartLivePlaytest(host)}>
          Play Again
        </button>
        <button type="button" @click=${() => setGuidedStep(host, "make-things")}>Change It</button>
      </div>
    </div>
  `;
}

function renderPlayControllerPanel(host: HostUpdate) {
  return html`
    <section class="snes-playtest__controls snes-play-controller" aria-label="Playable controls">
      <div class="snes-play-controller__hint">
        <span>Controller</span>
        <strong>${livePlaytestRunning ? "Live play running" : "Use buttons or keyboard"}</strong>
        <small>Hold arrows or A/D to move. Space jumps. Enter runs. Esc pauses. R restarts.</small>
      </div>
      <div class="snes-play-controller__pad" aria-label="Move the hero">
        <button
          type="button"
          aria-keyshortcuts="ArrowLeft A"
          class=${livePlaytestInput.left ? "active" : ""}
          @pointerdown=${(event: PointerEvent) => {
            event.preventDefault();
            setLivePlaytestInput(host, "left", true);
          }}
          @pointerup=${() => setLivePlaytestInput(host, "left", false)}
          @pointercancel=${() => setLivePlaytestInput(host, "left", false)}
          @pointerleave=${() => setLivePlaytestInput(host, "left", false)}
          @click=${() => runPreviewPlaytest(host, 10, { left: true })}
        >
          Left
        </button>
        <button
          type="button"
          aria-keyshortcuts="ArrowRight D"
          class=${livePlaytestInput.right ? "active" : ""}
          @pointerdown=${(event: PointerEvent) => {
            event.preventDefault();
            setLivePlaytestInput(host, "right", true);
          }}
          @pointerup=${() => setLivePlaytestInput(host, "right", false)}
          @pointercancel=${() => setLivePlaytestInput(host, "right", false)}
          @pointerleave=${() => setLivePlaytestInput(host, "right", false)}
          @click=${() => runPreviewPlaytest(host, 10, { right: true })}
        >
          Right
        </button>
      </div>
      <div class="snes-play-controller__buttons" aria-label="Game actions">
        <button
          type="button"
          class="primary"
          aria-keyshortcuts="Space ArrowUp W"
          @pointerdown=${(event: PointerEvent) => {
            event.preventDefault();
            setLivePlaytestInput(host, "jump", true);
          }}
          @pointerup=${() => setLivePlaytestInput(host, "jump", false)}
          @pointercancel=${() => setLivePlaytestInput(host, "jump", false)}
          @pointerleave=${() => setLivePlaytestInput(host, "jump", false)}
          @click=${() => stepPreviewPlaytest(host, { jump: true })}
        >
          Jump
        </button>
        <button
          type="button"
          aria-keyshortcuts="Enter"
          title="Advance the game forward for a short burst."
          @click=${() => runPreviewPlaytest(host, 30, { right: true })}
        >
          Auto Run
        </button>
      </div>
      <div class="snes-play-controller__system" aria-label="Test controls">
        <button type="button" class="primary" @click=${() => startLivePlaytest(host)}>
          Start Test
        </button>
        <button type="button" aria-keyshortcuts="Escape" @click=${() => pauseLivePlaytest(host)}>
          Pause
        </button>
        <button type="button" aria-keyshortcuts="R" @click=${() => restartLivePlaytest(host)}>
          Restart
        </button>
      </div>
    </section>
  `;
}

function renderPlaySceneWorld(scene: SnesStudioProject["scenes"][number], cameraX = 0) {
  const cells = Array.from({ length: scene.tilemap.length }, (_, index) => {
    const tile = scene.tilemap[index] ?? 0;
    const collisionMaterial = (scene.collisionMap[index] ?? 0) as SnesCollisionMaterial;
    const material = sceneCellMaterial(tile, collisionMaterial);
    return html`
      <span
        class=${`snes-playtest__tile snes-playtest__tile--${material}`}
        data-material=${material}
        aria-label=${`${sceneCellMaterialLabel(material)} square ${index}`}
      >
        <span class="snes-playtest__tile-motif" aria-hidden="true"></span>
      </span>
    `;
  });
  const visibleWorldWidth = 256;
  const worldWidth = Math.max(visibleWorldWidth, scene.widthMetatiles * 16);
  const worldWidthPercent = (worldWidth / visibleWorldWidth) * 100;
  const cameraPercent = (cameraX / worldWidth) * 100;
  return html`
    <div
      class="snes-playtest__world"
      aria-label="Playable level scene"
      style=${`--play-columns:${scene.widthMetatiles};--play-rows:${scene.heightMetatiles};width:${worldWidthPercent.toFixed(2)}%;transform:translateX(-${cameraPercent.toFixed(3)}%);`}
    >
      ${cells}
    </div>
  `;
}

function renderPlaytestQuickActions(host: HostUpdate) {
  return html`
    <div class="snes-playtest__quick-actions" aria-label="Try the game now">
      <strong>Try it now</strong>
      <button type="button" class="primary" @click=${() => startLivePlaytest(host)}>
        Start Test
      </button>
      <button type="button" @click=${() => runPreviewPlaytest(host, 42, { right: true })}>
        Run Right
      </button>
      <button type="button" @click=${() => stepPreviewPlaytest(host, { jump: true })}>Jump</button>
      <button type="button" @click=${() => startPreviewPlaytest(host, true, true)}>
        Show It Working
      </button>
      <button type="button" @click=${() => pauseLivePlaytest(host)}>Pause</button>
      <button type="button" @click=${() => setGuidedStep(host, "make-things")}>
        Add Or Change Things
      </button>
    </div>
  `;
}

function renderPlaytestMoments(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const moments = createPlaytestMoments(scene, previewSimulationState);
  return html`
    <section class="snes-play-moments" aria-label="Play results">
      <div class="snes-play-moments__heading">
        <span class="snes-eyebrow">Play Results</span>
        <strong>What to try next</strong>
        <small>These cards explain the test and let you change the exact game part.</small>
      </div>
      <div class="snes-play-moments__grid">
        ${moments.map((moment) => {
          const actionEntity = moment.entity;
          return html`
            <article class=${`snes-play-moment snes-play-moment--${moment.tone}`}>
              <span>${moment.title}</span>
              <p>${moment.detail}</p>
              ${moment.actionLabel && actionEntity
                ? html`
                    <button
                      type="button"
                      @click=${() => promptChangePlaytestEntity(host, scene, actionEntity)}
                    >
                      ${moment.actionLabel}
                    </button>
                  `
                : nothing}
            </article>
          `;
        })}
      </div>
    </section>
  `;
}

function renderPlayStoryChecks(host: HostUpdate) {
  return html`
    <details class="snes-play-drawer snes-play-event-drawer">
      <summary>Story checks</summary>
      <div class="snes-playtest__event-controls">
        <button type="button" @click=${() => triggerPreviewEvent(host, "on-start")}>
          Check Opening Story
        </button>
        <button type="button" @click=${() => triggerPreviewEvent(host, "on-enter-zone")}>
          Check Area Trigger
        </button>
      </div>
    </details>
  `;
}

function pointerPercentInElement(event: PointerEvent, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    xPercent: clampInteger(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
    yPercent: clampInteger(((event.clientY - rect.top) / rect.height) * 100, 0, 100),
  };
}

function pointerPercentInStage(event: PointerEvent) {
  return pointerPercentInElement(event, event.currentTarget as HTMLElement);
}

function pointerWorldPositionInStage(event: PointerEvent, stage: HTMLElement) {
  const scene = selectedScene();
  const rect = stage.getBoundingClientRect();
  if (!scene || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const visibleWorldWidth = 256;
  const worldWidth = scene.widthMetatiles * 16;
  const worldHeight = scene.heightMetatiles * 16;
  const cameraX = previewSimulationState?.cameraScrollX ?? 0;
  return {
    x: clampInteger(
      Math.round(cameraX + ((event.clientX - rect.left) / rect.width) * visibleWorldWidth),
      0,
      worldWidth - 1,
    ),
    y: clampInteger(
      Math.round(((event.clientY - rect.top) / rect.height) * worldHeight),
      0,
      worldHeight - 1,
    ),
  };
}

function eventStartedOnInteractiveGameThing(event: PointerEvent) {
  return Boolean(
    (event.target as HTMLElement | null)?.closest?.(
      ".snes-playtest__marker, button, input, textarea, select, summary",
    ),
  );
}

function updatePreviewSimulationEntityPosition(
  entity: SnesSceneEntityDraft,
  position: { x: number; y: number },
) {
  if (!previewSimulationState) {
    return;
  }
  if (entity.kind === "player") {
    previewSimulationState = {
      ...previewSimulationState,
      cameraScrollX: Math.max(0, position.x - 96),
      playerX: position.x,
      playerY: position.y,
      playerYVelocity: 0,
    };
  } else if (entity.kind === "enemy") {
    const existing = previewSimulationState.enemyPositions[entity.id];
    previewSimulationState = {
      ...previewSimulationState,
      enemyPositions: {
        ...previewSimulationState.enemyPositions,
        [entity.id]: {
          direction: existing?.direction ?? 1,
          x: position.x,
          y: position.y,
        },
      },
    };
  }
  project.emulatorPlaytestState = previewSimulationState;
}

function startDirectEntityDrag(
  host: HostUpdate,
  event: PointerEvent,
  scene: SnesStudioProject["scenes"][number],
  entity: SnesSceneEntityDraft,
) {
  if (event.button !== 0) {
    return;
  }
  const stage = (event.currentTarget as HTMLElement).closest<HTMLElement>(".snes-emulator-canvas");
  if (!stage) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  selectedScreenArea = null;
  delete project.selectedScreenArea;
  arcadeAreaDragStart = null;
  draggedEntityId = entity.id;
  draggedPalettePiece = null;
  draggedGuidedThingKind = null;
  draggedPart = null;
  directEntityDrag = {
    entityId: entity.id,
    pointerId: typeof event.pointerId === "number" ? event.pointerId : null,
    sceneId: scene.id,
    undoRecorded: false,
    moved: false,
  };
  if (typeof event.pointerId === "number") {
    try {
      stage.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic smoke-test events do not always register as active browser pointers.
    }
  }
  selectSceneEntity(host, scene, entity);
  lastPlaytestFeedback = {
    tone: "ready",
    title: `${entity.name} ready to move`,
    detail: "Drag it where it should go, then release. The playtest updates immediately.",
  };
  host.requestUpdate?.();
}

function updateDirectEntityDrag(host: HostUpdate, event: PointerEvent) {
  if (!directEntityDrag) {
    return false;
  }
  const stage = event.currentTarget as HTMLElement;
  const position = pointerWorldPositionInStage(event, stage);
  if (!position) {
    return true;
  }
  const scene = selectedScene();
  const entity = scene?.entities.find((candidate) => candidate.id === directEntityDrag?.entityId);
  if (!scene || !entity || scene.id !== directEntityDrag.sceneId) {
    return true;
  }
  if (!directEntityDrag.undoRecorded) {
    rememberUndo();
    directEntityDrag.undoRecorded = true;
  }
  directEntityDrag.moved = true;
  try {
    project = moveSnesSceneEntity(
      project,
      selectedSceneIndex,
      directEntityDrag.entityId,
      position.x,
      position.y,
    );
    updatePreviewSimulationEntityPosition(entity, position);
    lastPlaytestFeedback = {
      tone: "ready",
      title: `${entity.name} is moving`,
      detail: "Release to lock the new spot into the editable game.",
    };
  } catch (error) {
    pushConsole(host, error instanceof Error ? error.message : "Direct drag move failed.");
  }
  host.requestUpdate?.();
  return true;
}

function finishDirectEntityDrag(host: HostUpdate, event: PointerEvent) {
  if (!directEntityDrag) {
    return false;
  }
  const drag = directEntityDrag;
  updateDirectEntityDrag(host, event);
  const moved = selectedScene()?.entities.find((entity) => entity.id === drag.entityId);
  if (drag.moved) {
    saveProject();
    hotReloadRuntimeAfterEdit(
      host,
      `${moved?.name ?? "Thing"} moved`,
      "This direct drag move is now in the 60 Hz playtest.",
    );
    pushConsole(host, `Moved ${moved?.name ?? drag.entityId} by direct drag in the playtest.`);
  }
  directEntityDrag = null;
  draggedEntityId = null;
  draggedPalettePiece = null;
  draggedGuidedThingKind = null;
  draggedPart = null;
  host.requestUpdate?.();
  return true;
}

function sceneMaterialAtCell(scene: SnesStudioProject["scenes"][number], cellIndex: number) {
  const tile = scene.tilemap[cellIndex] ?? 0;
  const collisionMaterial = (scene.collisionMap[cellIndex] ?? 0) as SnesCollisionMaterial;
  return sceneCellMaterial(tile, collisionMaterial);
}

function selectedAreaFromEditGridRect(
  scene: SnesStudioProject["scenes"][number],
  column: number,
  row: number,
  width: number,
  height: number,
  label: string,
): SnesScreenAreaSelection {
  return {
    sceneId: scene.id,
    xPercent: (column / SNES_STUDIO_EDIT_GRID.width) * 100,
    yPercent: (row / SNES_STUDIO_EDIT_GRID.height) * 100,
    widthPercent: (width / SNES_STUDIO_EDIT_GRID.width) * 100,
    heightPercent: (height / SNES_STUDIO_EDIT_GRID.height) * 100,
    label,
  };
}

function selectedAreaMovesContent(area: SnesScreenAreaSelection | null) {
  if (!area) {
    return false;
  }
  const label = area.label.toLowerCase();
  return label === "ground" || label === "danger" || label === "water" || label === "path";
}

function terrainChunkRectAtCell(scene: SnesStudioProject["scenes"][number], cellIndex: number) {
  const targetMaterial = sceneMaterialAtCell(scene, cellIndex);
  if (targetMaterial === "air") {
    const column = cellIndex % SNES_STUDIO_EDIT_GRID.width;
    const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
    return {
      column,
      height: 1,
      material: targetMaterial,
      row,
      width: 1,
    };
  }
  const targetTile = scene.tilemap[cellIndex] ?? 0;
  const targetCollision = scene.collisionMap[cellIndex] ?? 0;
  const visited = new Set<number>();
  const stack = [cellIndex];
  let minColumn = SNES_STUDIO_EDIT_GRID.width - 1;
  let maxColumn = 0;
  let minRow = SNES_STUDIO_EDIT_GRID.height - 1;
  let maxRow = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    const column = current % SNES_STUDIO_EDIT_GRID.width;
    const row = Math.floor(current / SNES_STUDIO_EDIT_GRID.width);
    if (
      column < 0 ||
      column >= SNES_STUDIO_EDIT_GRID.width ||
      row < 0 ||
      row >= SNES_STUDIO_EDIT_GRID.height
    ) {
      continue;
    }
    if ((scene.tilemap[current] ?? 0) !== targetTile) continue;
    if ((scene.collisionMap[current] ?? 0) !== targetCollision) continue;
    visited.add(current);
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    if (column > 0) stack.push(current - 1);
    if (column < SNES_STUDIO_EDIT_GRID.width - 1) stack.push(current + 1);
    if (row > 0) stack.push(current - SNES_STUDIO_EDIT_GRID.width);
    if (row < SNES_STUDIO_EDIT_GRID.height - 1) stack.push(current + SNES_STUDIO_EDIT_GRID.width);
  }
  if (visited.size === 0) {
    const column = cellIndex % SNES_STUDIO_EDIT_GRID.width;
    const row = Math.floor(cellIndex / SNES_STUDIO_EDIT_GRID.width);
    return {
      column,
      height: 1,
      material: targetMaterial,
      row,
      width: 1,
    };
  }
  return {
    column: minColumn,
    height: maxRow - minRow + 1,
    material: targetMaterial,
    row: minRow,
    width: maxColumn - minColumn + 1,
  };
}

function selectTerrainChunkAtPointer(host: HostUpdate, event: PointerEvent) {
  const scene = selectedScene();
  const point = pointerPercentInStage(event);
  if (!scene || !point) {
    return false;
  }
  const column = clampInteger(
    Math.floor((point.xPercent / 100) * SNES_STUDIO_EDIT_GRID.width),
    0,
    SNES_STUDIO_EDIT_GRID.width - 1,
  );
  const row = clampInteger(
    Math.floor((point.yPercent / 100) * SNES_STUDIO_EDIT_GRID.height),
    0,
    SNES_STUDIO_EDIT_GRID.height - 1,
  );
  const cellIndex = row * SNES_STUDIO_EDIT_GRID.width + column;
  const chunk = terrainChunkRectAtCell(scene, cellIndex);
  const materialLabel = sceneCellMaterialLabel(chunk.material);
  const areaLabel = chunk.material === "air" ? "empty space" : materialLabel.toLowerCase();
  selectedScreenArea = selectedAreaFromEditGridRect(
    scene,
    chunk.column,
    chunk.row,
    chunk.width,
    chunk.height,
    areaLabel,
  );
  project.selectedScreenArea = selectedScreenArea;
  saveProject();
  arcadeAreaPromptDraft =
    chunk.material === "air" ? "Add something useful here." : `Change this ${areaLabel}.`;
  lastPlaytestFeedback = {
    tone: "ready",
    title: chunk.material === "air" ? "Empty space selected" : `${materialLabel} selected`,
    detail:
      chunk.material === "air"
        ? "Type what AI should add in this spot, or drag the highlighted area first."
        : "AI can now change, remove, move the highlight around, or resize this selected part of the level.",
  };
  pushConsole(host, `Selected ${areaLabel} in the playtest.`);
  host.requestUpdate?.();
  return true;
}

function cancelDirectEntityDrag(host: HostUpdate) {
  if (!directEntityDrag) {
    return false;
  }
  directEntityDrag = null;
  draggedEntityId = null;
  draggedPalettePiece = null;
  draggedGuidedThingKind = null;
  draggedPart = null;
  host.requestUpdate?.();
  return true;
}

function startSelectedAreaEdit(host: HostUpdate, event: PointerEvent, mode: SnesAreaEditMode) {
  if (event.button !== 0 || !selectedScreenArea) {
    return;
  }
  const stage = (event.currentTarget as HTMLElement).closest<HTMLElement>(".snes-emulator-canvas");
  if (!stage) {
    return;
  }
  const point = pointerPercentInElement(event, stage);
  if (!point) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  areaEditDrag = {
    mode,
    moveContent: selectedAreaMovesContent(selectedScreenArea),
    pointerId: typeof event.pointerId === "number" ? event.pointerId : null,
    startArea: { ...selectedScreenArea },
    startPointer: point,
  };
  if (typeof event.pointerId === "number") {
    try {
      stage.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic smoke-test events do not always register as active browser pointers.
    }
  }
  lastPlaytestFeedback = {
    tone: "ready",
    title:
      mode === "move"
        ? areaEditDrag.moveContent
          ? `Move this ${selectedScreenArea.label}`
          : "Move the selected area"
        : areaEditDrag.moveContent
          ? `Resize this ${selectedScreenArea.label}`
          : "Resize the selected area",
    detail:
      mode === "move"
        ? areaEditDrag.moveContent
          ? "Drag it to a new spot in the level, then release. The playtest updates immediately."
          : "Drag the highlighted rectangle to the part of the game screen AI should change."
        : areaEditDrag.moveContent
          ? "Drag the corner to stretch or shrink this level piece."
          : "Drag the corner until the highlighted area covers exactly what AI should change.",
  };
  host.requestUpdate?.();
}

function updateSelectedAreaEdit(host: HostUpdate, event: PointerEvent) {
  if (!areaEditDrag || !selectedScreenArea) {
    return false;
  }
  const stage = event.currentTarget as HTMLElement;
  const point = pointerPercentInElement(event, stage);
  if (!point) {
    return true;
  }
  const deltaX = point.xPercent - areaEditDrag.startPointer.xPercent;
  const deltaY = point.yPercent - areaEditDrag.startPointer.yPercent;
  if (areaEditDrag.mode === "move") {
    selectedScreenArea = {
      ...areaEditDrag.startArea,
      xPercent: clampInteger(
        areaEditDrag.startArea.xPercent + deltaX,
        0,
        100 - areaEditDrag.startArea.widthPercent,
      ),
      yPercent: clampInteger(
        areaEditDrag.startArea.yPercent + deltaY,
        0,
        100 - areaEditDrag.startArea.heightPercent,
      ),
    };
  } else {
    selectedScreenArea = {
      ...areaEditDrag.startArea,
      widthPercent: clampInteger(
        areaEditDrag.startArea.widthPercent + deltaX,
        1,
        100 - areaEditDrag.startArea.xPercent,
      ),
      heightPercent: clampInteger(
        areaEditDrag.startArea.heightPercent + deltaY,
        1,
        100 - areaEditDrag.startArea.yPercent,
      ),
    };
  }
  project.selectedScreenArea = selectedScreenArea;
  lastPlaytestFeedback = {
    tone: "ready",
    title:
      areaEditDrag.mode === "move"
        ? areaEditDrag.moveContent
          ? `${areaEditDrag.startArea.label} moving`
          : "Area moving"
        : areaEditDrag.moveContent
          ? `${areaEditDrag.startArea.label} resizing`
          : "Area resizing",
    detail:
      areaEditDrag.mode === "move" && areaEditDrag.moveContent
        ? "Release to move this part of the level."
        : areaEditDrag.mode === "resize" && areaEditDrag.moveContent
          ? "Release to resize this part of the level."
          : "Release when the highlighted rectangle covers the part AI should change.",
  };
  host.requestUpdate?.();
  return true;
}

function finishSelectedAreaEdit(host: HostUpdate, event: PointerEvent) {
  if (!areaEditDrag) {
    return false;
  }
  const drag = areaEditDrag;
  const mode = drag.mode;
  updateSelectedAreaEdit(host, event);
  const movedContent =
    mode === "move" &&
    drag.moveContent &&
    selectedScreenArea &&
    moveSelectedAreaContent(host, drag.startArea, selectedScreenArea);
  const resizedContent =
    mode === "resize" &&
    drag.moveContent &&
    selectedScreenArea &&
    resizeSelectedAreaContent(host, drag.startArea, selectedScreenArea);
  areaEditDrag = null;
  if (selectedScreenArea && !movedContent && !resizedContent) {
    project.selectedScreenArea = selectedScreenArea;
    saveProject();
  }
  lastPlaytestFeedback = {
    tone: "ready",
    title: resizedContent
      ? `${drag.startArea.label} resized`
      : movedContent
        ? `${drag.startArea.label} moved`
        : mode === "move"
          ? "Area moved"
          : "Area resized",
    detail: resizedContent
      ? "The level piece resized and the playtest is ready."
      : movedContent
        ? "The level piece moved and the playtest is ready."
        : "Now type what AI should add, remove, or change in that highlighted area.",
  };
  pushConsole(
    host,
    resizedContent
      ? `Resized ${drag.startArea.label} in the selected area.`
      : movedContent
        ? `Moved ${drag.startArea.label} in the selected area.`
        : mode === "move"
          ? "Moved selected emulator area."
          : "Resized selected emulator area.",
  );
  host.requestUpdate?.();
  return true;
}

function cancelSelectedAreaEdit(host: HostUpdate) {
  if (!areaEditDrag) {
    return false;
  }
  areaEditDrag = null;
  host.requestUpdate?.();
  return true;
}

function startScreenAreaSelection(host: HostUpdate, event: PointerEvent) {
  if (event.button !== 0 || eventStartedOnInteractiveGameThing(event)) {
    return;
  }
  const point = pointerPercentInStage(event);
  const scene = selectedScene();
  if (!point || !scene) {
    return;
  }
  arcadeAreaDragStart = point;
  selectedScreenArea = {
    sceneId: scene.id,
    xPercent: point.xPercent,
    yPercent: point.yPercent,
    widthPercent: 1,
    heightPercent: 1,
    label: "Selected emulator area",
  };
  event.preventDefault();
  if (typeof event.pointerId === "number") {
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic smoke-test events do not always register as active browser pointers.
    }
  }
  host.requestUpdate?.();
}

function updateScreenAreaSelection(host: HostUpdate, event: PointerEvent) {
  if (!arcadeAreaDragStart || eventStartedOnInteractiveGameThing(event)) {
    return;
  }
  const point = pointerPercentInStage(event);
  const scene = selectedScene();
  if (!point || !scene) {
    return;
  }
  selectedScreenArea = {
    sceneId: scene.id,
    xPercent: Math.min(arcadeAreaDragStart.xPercent, point.xPercent),
    yPercent: Math.min(arcadeAreaDragStart.yPercent, point.yPercent),
    widthPercent: Math.max(1, Math.abs(point.xPercent - arcadeAreaDragStart.xPercent)),
    heightPercent: Math.max(1, Math.abs(point.yPercent - arcadeAreaDragStart.yPercent)),
    label: "Selected emulator area",
  };
  host.requestUpdate?.();
}

function finishScreenAreaSelection(host: HostUpdate, event: PointerEvent) {
  if (!arcadeAreaDragStart) {
    return;
  }
  const endPoint = pointerPercentInStage(event);
  const movedX = endPoint ? Math.abs(endPoint.xPercent - arcadeAreaDragStart.xPercent) : 0;
  const movedY = endPoint ? Math.abs(endPoint.yPercent - arcadeAreaDragStart.yPercent) : 0;
  if (movedX < 1.5 && movedY < 1.5 && selectTerrainChunkAtPointer(host, event)) {
    arcadeAreaDragStart = null;
    return;
  }
  updateScreenAreaSelection(host, event);
  arcadeAreaDragStart = null;
  if (selectedScreenArea) {
    project.selectedScreenArea = selectedScreenArea;
    saveProject();
    arcadeAreaPromptDraft = "Add a coin trail here.";
    pendingAreaPreview = null;
    lastPlaytestFeedback = {
      tone: "ready",
      title: "Area selected",
      detail: "Type what should change in that rectangle, then press Change Selected Area.",
    };
    pushConsole(host, "Selected an emulator area for an AI change.");
  }
  host.requestUpdate?.();
}

function selectedAreaTileRect(area: SnesScreenAreaSelection) {
  const column = clampInteger(
    Math.floor((area.xPercent / 100) * SNES_STUDIO_EDIT_GRID.width),
    0,
    SNES_STUDIO_EDIT_GRID.width - 1,
  );
  const row = clampInteger(
    Math.floor((area.yPercent / 100) * SNES_STUDIO_EDIT_GRID.height),
    0,
    SNES_STUDIO_EDIT_GRID.height - 1,
  );
  const width = clampInteger(
    Math.ceil((area.widthPercent / 100) * SNES_STUDIO_EDIT_GRID.width),
    1,
    SNES_STUDIO_EDIT_GRID.width - column,
  );
  const height = clampInteger(
    Math.ceil((area.heightPercent / 100) * SNES_STUDIO_EDIT_GRID.height),
    1,
    SNES_STUDIO_EDIT_GRID.height - row,
  );
  return { column, row, width, height };
}

function selectedAreaFromMovedTileRect(
  scene: SnesStudioProject["scenes"][number],
  area: SnesScreenAreaSelection,
  deltaColumn: number,
  deltaRow: number,
) {
  const rect = selectedAreaTileRect(area);
  return selectedAreaFromEditGridRect(
    scene,
    clampInteger(rect.column + deltaColumn, 0, SNES_STUDIO_EDIT_GRID.width - rect.width),
    clampInteger(rect.row + deltaRow, 0, SNES_STUDIO_EDIT_GRID.height - rect.height),
    rect.width,
    rect.height,
    area.label,
  );
}

function selectedAreaMoveDeltaFromPrompt(lower: string) {
  if (!promptHasAny(lower, ["move", "shift", "slide", "nudge", "put"])) {
    return null;
  }
  let deltaColumn = 0;
  let deltaRow = 0;
  if (promptHasAny(lower, ["left"])) deltaColumn -= 1;
  if (promptHasAny(lower, ["right"])) deltaColumn += 1;
  if (promptHasAny(lower, ["up", "higher", "raise"])) deltaRow -= 1;
  if (promptHasAny(lower, ["down", "lower"])) deltaRow += 1;
  if (deltaColumn === 0 && deltaRow === 0) {
    return null;
  }
  const scale = promptHasAny(lower, ["two", "2", "far"]) ? 2 : 1;
  return {
    deltaColumn: deltaColumn * scale,
    deltaRow: deltaRow * scale,
  };
}

function selectedAreaFromResizedTileRect(
  scene: SnesStudioProject["scenes"][number],
  area: SnesScreenAreaSelection,
  deltaWidth: number,
  deltaHeight: number,
) {
  const rect = selectedAreaTileRect(area);
  return selectedAreaFromEditGridRect(
    scene,
    rect.column,
    rect.row,
    clampInteger(rect.width + deltaWidth, 1, SNES_STUDIO_EDIT_GRID.width - rect.column),
    clampInteger(rect.height + deltaHeight, 1, SNES_STUDIO_EDIT_GRID.height - rect.row),
    area.label,
  );
}

function selectedAreaResizeDeltaFromPrompt(lower: string) {
  if (
    !promptHasAny(lower, [
      "resize",
      "stretch",
      "extend",
      "longer",
      "shorter",
      "wider",
      "narrower",
      "bigger",
      "smaller",
      "shrink",
      "grow",
      "taller",
      "thinner",
      "thicker",
    ])
  ) {
    return null;
  }
  let deltaWidth = 0;
  let deltaHeight = 0;
  if (promptHasAny(lower, ["longer", "wider", "extend", "stretch", "bigger", "grow"])) {
    deltaWidth += 2;
  }
  if (promptHasAny(lower, ["shorter", "narrower", "smaller", "shrink"])) {
    deltaWidth -= 2;
  }
  if (promptHasAny(lower, ["taller", "thicker"])) {
    deltaHeight += 1;
  }
  if (promptHasAny(lower, ["thinner", "shallower"])) {
    deltaHeight -= 1;
  }
  if (deltaWidth === 0 && deltaHeight === 0) {
    return null;
  }
  const scale = promptHasAny(lower, ["very", "two", "2", "far", "much"]) ? 2 : 1;
  return {
    deltaHeight: deltaHeight * scale,
    deltaWidth: deltaWidth * scale,
  };
}

function selectedAreaWorldCenter(
  scene: SnesStudioProject["scenes"][number],
  area: SnesScreenAreaSelection,
) {
  const visibleWorldWidth = 256;
  const cameraX = previewSimulationState?.cameraScrollX ?? 0;
  return {
    x: clampInteger(
      cameraX + ((area.xPercent + area.widthPercent / 2) / 100) * visibleWorldWidth,
      0,
      scene.widthMetatiles * 16 - 1,
    ),
    y: clampInteger(
      ((area.yPercent + area.heightPercent / 2) / 100) * scene.heightMetatiles * 16,
      0,
      scene.heightMetatiles * 16 - 1,
    ),
  };
}

function entityIsInsideSelectedArea(
  scene: SnesStudioProject["scenes"][number],
  area: SnesScreenAreaSelection,
  entity: SnesSceneEntityDraft,
) {
  const visibleWorldWidth = 256;
  const cameraX = previewSimulationState?.cameraScrollX ?? 0;
  const left = cameraX + (area.xPercent / 100) * visibleWorldWidth;
  const right = cameraX + ((area.xPercent + area.widthPercent) / 100) * visibleWorldWidth;
  const top = (area.yPercent / 100) * scene.heightMetatiles * 16;
  const bottom = ((area.yPercent + area.heightPercent) / 100) * scene.heightMetatiles * 16;
  return entity.x >= left && entity.x <= right && entity.y >= top && entity.y <= bottom;
}

function paintSelectedArea(
  host: HostUpdate,
  tile: SnesTileBrush,
  collision: SnesCollisionMaterial,
) {
  if (!selectedScreenArea) return;
  const rect = selectedAreaTileRect(selectedScreenArea);
  rememberUndo();
  project = paintSnesSceneRect(
    project,
    selectedSceneIndex,
    rect.column,
    rect.row,
    rect.width,
    rect.height,
    tile,
    collision > 0,
    collision,
  );
  project.selectedScreenArea = selectedScreenArea;
  syncArcadeBuilderMetadata(project.gameBrief?.prompt ?? surfacePromptDraft("full-game"));
  saveProject();
  hotReloadRuntimeAfterEdit(
    host,
    "Runtime updated",
    "This paint change is now in the 60 Hz playtest.",
  );
  host.requestUpdate?.();
}

function promptHasAny(lower: string, terms: string[]) {
  return terms.some((term) => lower.includes(term));
}

function selectedAreaPromptMatchesEntity(lower: string, entity: SnesSceneEntityDraft) {
  const wantsEnemy = promptHasAny(lower, ["enemy", "enemies", "boss", "challenge"]);
  const wantsReward = promptHasAny(lower, [
    "item",
    "items",
    "coin",
    "coins",
    "gem",
    "gems",
    "key",
    "keys",
    "pickup",
    "reward",
    "powerup",
  ]);
  const wantsDoor = promptHasAny(lower, ["door", "doors", "pipe", "portal", "exit"]);
  const wantsGoal = promptHasAny(lower, ["goal", "flag", "finish"]);
  const wantsGuide = promptHasAny(lower, ["guide", "npc", "dialogue", "friend"]);
  const hasSpecificTarget = wantsEnemy || wantsReward || wantsDoor || wantsGoal || wantsGuide;
  if (entity.kind === "player") {
    return false;
  }
  if (!hasSpecificTarget) {
    return true;
  }
  const name = entity.name.toLowerCase();
  if (wantsEnemy && entity.kind === "enemy") return true;
  if (wantsReward && entity.kind === "item") return true;
  if (wantsDoor && (entity.kind === "npc" || name.includes("door") || name.includes("pipe"))) {
    return true;
  }
  if (wantsGoal && (name.includes("goal") || name.includes("flag") || name.includes("finish"))) {
    return true;
  }
  if (wantsGuide && entity.kind === "npc" && !name.includes("door")) return true;
  return false;
}

function removeMatchingEntitiesFromSelectedArea(
  draftScene: SnesStudioProject["scenes"][number],
  area: SnesScreenAreaSelection,
  lower: string,
) {
  const before = draftScene.entities.length;
  draftScene.entities = draftScene.entities.filter(
    (entity) =>
      !entityIsInsideSelectedArea(draftScene, area, entity) ||
      !selectedAreaPromptMatchesEntity(lower, entity),
  );
  return before - draftScene.entities.length;
}

function clearSelectedAreaCells(
  draftScene: SnesStudioProject["scenes"][number],
  rect: ReturnType<typeof selectedAreaTileRect>,
) {
  for (let y = rect.row; y < rect.row + rect.height; y += 1) {
    for (let x = rect.column; x < rect.column + rect.width; x += 1) {
      const index = y * SNES_STUDIO_EDIT_GRID.width + x;
      draftScene.tilemap[index] = 0;
      draftScene.collisionMap[index] = 0;
    }
  }
  draftScene.collisionTiles = draftScene.collisionMap.filter((cell) => cell > 0).length;
}

function moveSelectedAreaContent(
  host: HostUpdate,
  startArea: SnesScreenAreaSelection,
  targetArea: SnesScreenAreaSelection,
) {
  const scene = selectedScene();
  if (!scene) {
    return false;
  }
  const startRect = selectedAreaTileRect(startArea);
  const targetRect = selectedAreaTileRect(targetArea);
  const deltaColumn = targetRect.column - startRect.column;
  const deltaRow = targetRect.row - startRect.row;
  if (deltaColumn === 0 && deltaRow === 0) {
    return false;
  }
  updateProject(host, (draft) => {
    const draftScene = draft.scenes[selectedSceneIndex];
    if (!draftScene) return;
    const sourceCells = [];
    for (let y = 0; y < startRect.height; y += 1) {
      for (let x = 0; x < startRect.width; x += 1) {
        const sourceIndex =
          (startRect.row + y) * SNES_STUDIO_EDIT_GRID.width + (startRect.column + x);
        sourceCells.push({
          collision: draftScene.collisionMap[sourceIndex] ?? 0,
          tile: draftScene.tilemap[sourceIndex] ?? 0,
          x,
          y,
        });
      }
    }
    clearSelectedAreaCells(draftScene, startRect);
    for (const cell of sourceCells) {
      const targetColumn = targetRect.column + cell.x;
      const targetRow = targetRect.row + cell.y;
      if (
        targetColumn < 0 ||
        targetColumn >= SNES_STUDIO_EDIT_GRID.width ||
        targetRow < 0 ||
        targetRow >= SNES_STUDIO_EDIT_GRID.height
      ) {
        continue;
      }
      const targetIndex = targetRow * SNES_STUDIO_EDIT_GRID.width + targetColumn;
      draftScene.tilemap[targetIndex] = cell.tile;
      draftScene.collisionMap[targetIndex] = cell.collision as SnesCollisionMaterial;
    }
    const deltaX = deltaColumn * 16;
    const deltaY = deltaRow * 16;
    for (const entity of draftScene.entities) {
      if (!entityIsInsideSelectedArea(draftScene, startArea, entity)) {
        continue;
      }
      entity.x = clampInteger(entity.x + deltaX, 0, draftScene.widthMetatiles * 16 - 8);
      entity.y = clampInteger(entity.y + deltaY, 0, draftScene.heightMetatiles * 16 - 8);
    }
    draftScene.collisionTiles = draftScene.collisionMap.filter((cell) => cell > 0).length;
    draft.selectedScreenArea = targetArea;
  });
  selectedScreenArea = targetArea;
  project.selectedScreenArea = targetArea;
  syncArcadeBuilderMetadata(project.gameBrief?.prompt ?? surfacePromptDraft("full-game"));
  saveProject();
  hotReloadRuntimeAfterEdit(
    host,
    `${startArea.label} moved`,
    "This moved level piece is now in the 60 Hz playtest.",
  );
  pushConsole(host, `Moved ${startArea.label} in the playtest.`);
  return true;
}

function resizeSelectedAreaContent(
  host: HostUpdate,
  startArea: SnesScreenAreaSelection,
  targetArea: SnesScreenAreaSelection,
) {
  const scene = selectedScene();
  if (!scene) {
    return false;
  }
  const startRect = selectedAreaTileRect(startArea);
  const targetRect = selectedAreaTileRect(targetArea);
  if (startRect.width === targetRect.width && startRect.height === targetRect.height) {
    return false;
  }
  updateProject(host, (draft) => {
    const draftScene = draft.scenes[selectedSceneIndex];
    if (!draftScene) return;
    let tile =
      draftScene.tilemap[startRect.row * SNES_STUDIO_EDIT_GRID.width + startRect.column] ?? 1;
    let collision =
      draftScene.collisionMap[startRect.row * SNES_STUDIO_EDIT_GRID.width + startRect.column] ?? 1;
    let foundSourceCell = false;
    for (let y = startRect.row; y < startRect.row + startRect.height && !foundSourceCell; y += 1) {
      for (let x = startRect.column; x < startRect.column + startRect.width; x += 1) {
        const index = y * SNES_STUDIO_EDIT_GRID.width + x;
        const candidateTile = draftScene.tilemap[index] ?? 0;
        const candidateCollision = draftScene.collisionMap[index] ?? 0;
        if (candidateTile > 0 || candidateCollision > 0) {
          tile = candidateTile;
          collision = candidateCollision;
          foundSourceCell = true;
          break;
        }
      }
    }
    clearSelectedAreaCells(draftScene, startRect);
    for (let y = targetRect.row; y < targetRect.row + targetRect.height; y += 1) {
      for (let x = targetRect.column; x < targetRect.column + targetRect.width; x += 1) {
        const index = y * SNES_STUDIO_EDIT_GRID.width + x;
        draftScene.tilemap[index] = tile;
        draftScene.collisionMap[index] = collision as SnesCollisionMaterial;
      }
    }
    draftScene.collisionTiles = draftScene.collisionMap.filter((cell) => cell > 0).length;
    draft.selectedScreenArea = targetArea;
  });
  selectedScreenArea = targetArea;
  project.selectedScreenArea = targetArea;
  syncArcadeBuilderMetadata(project.gameBrief?.prompt ?? surfacePromptDraft("full-game"));
  saveProject();
  hotReloadRuntimeAfterEdit(
    host,
    `${startArea.label} resized`,
    "This resized level piece is now in the 60 Hz playtest.",
  );
  pushConsole(host, `Resized ${startArea.label} in the playtest.`);
  return true;
}

function selectedAreaAddKindFromPrompt(lower: string): SnesGuidedThingKind | null {
  if (promptHasAny(lower, ["platform", "ground", "bridge", "safe", "stairs", "steps", "ramp"])) {
    return "platform";
  }
  if (promptHasAny(lower, ["lava", "spike", "spikes", "danger", "hazard"])) return "hazard";
  if (promptHasAny(lower, ["water", "river", "pond"])) return "hazard";
  if (promptHasAny(lower, ["enemy", "enemies", "boss", "challenge"])) return "enemy";
  if (
    promptHasAny(lower, ["door", "exit", "pipe", "portal"]) ||
    (lower.includes("secret") &&
      !promptHasAny(lower, ["key", "coin", "gem", "item", "reward", "pickup"]))
  ) {
    return "door";
  }
  if (promptHasAny(lower, ["goal", "flag", "finish"])) return "goal";
  if (promptHasAny(lower, ["coin trail", "coins", "gems", "trail"])) return "coin-trail";
  if (promptHasAny(lower, ["power", "powerup", "ability", "upgrade"])) return "powerup";
  if (
    promptHasAny(lower, [
      "checkpoint",
      "coin",
      "gem",
      "item",
      "key",
      "pickup",
      "reward",
      "save",
      "star",
      "treasure",
    ])
  ) {
    return "item";
  }
  return null;
}

function applySelectedAreaQuickAction(host: HostUpdate, prompt: string) {
  arcadeAreaPromptDraft = prompt;
  pendingAreaPreview = null;
  applyPromptToSelectedScreenArea(host);
}

function selectedAreaPromptSuggestions(area: SnesScreenAreaSelection) {
  if (selectedAreaMovesContent(area)) {
    return [
      "Make this platform longer.",
      "Move this ground up.",
      "Make this ground shorter.",
      "Turn this into danger.",
    ];
  }
  return [
    "Make this jump easier.",
    "Add a hidden key here.",
    "Add a small boss enemy here.",
    "Remove only enemies here.",
  ];
}

function describeSelectedAreaPrompt(
  area: SnesScreenAreaSelection,
  prompt: string,
): Pick<SnesPendingAreaPreview, "summary" | "changed" | "suggestedTest"> {
  const lower = prompt.toLowerCase();
  const moveDelta = selectedAreaMovesContent(area) ? selectedAreaMoveDeltaFromPrompt(lower) : null;
  const resizeDelta = selectedAreaMovesContent(area)
    ? selectedAreaResizeDeltaFromPrompt(lower)
    : null;
  const asksToRemove = promptHasAny(lower, ["remove", "delete", "clear", "erase"]);
  const asksForGap = promptHasAny(lower, ["gap", "pit", "hole", "empty space", "empty area"]);
  const asksForDanger = promptHasAny(lower, [
    "lava",
    "spike",
    "spikes",
    "danger",
    "hazard",
    "harder",
  ]);
  const asksForWater = promptHasAny(lower, ["water", "river", "pond"]);
  const asksForSafeGround = promptHasAny(lower, [
    "platform",
    "ground",
    "bridge",
    "safe",
    "easier",
    "jump",
  ]);
  const asksToClearTerrain =
    asksForGap ||
    promptHasAny(lower, [
      "clear everything",
      "remove everything",
      "delete everything",
      "erase everything",
      "clear ground",
      "remove ground",
      "delete ground",
      "erase ground",
      "clear platform",
      "remove platform",
      "delete platform",
      "erase platform",
    ]);
  if (moveDelta) {
    return {
      summary: `${area.label} movement preview`,
      changed: [
        `Move ${area.label} ${Math.abs(moveDelta.deltaColumn)} square${Math.abs(moveDelta.deltaColumn) === 1 ? "" : "s"} sideways and ${Math.abs(moveDelta.deltaRow)} square${Math.abs(moveDelta.deltaRow) === 1 ? "" : "s"} vertically.`,
      ],
      suggestedTest: "Apply it, then run across the moved level piece.",
    };
  }
  if (resizeDelta) {
    return {
      summary: `${area.label} resize preview`,
      changed: [
        `Resize ${area.label} by ${Math.abs(resizeDelta.deltaWidth)} square${Math.abs(resizeDelta.deltaWidth) === 1 ? "" : "s"} wide and ${Math.abs(resizeDelta.deltaHeight)} square${Math.abs(resizeDelta.deltaHeight) === 1 ? "" : "s"} tall.`,
      ],
      suggestedTest: "Apply it, then test whether the jump feels right.",
    };
  }
  if (asksToClearTerrain) {
    return {
      summary: asksForGap ? "Gap preview" : "Clear area preview",
      changed: [
        asksForGap
          ? "Remove the selected level squares to make an empty gap."
          : "Clear level squares inside the selected rectangle.",
      ],
      suggestedTest: "Apply it, then run and jump through this area.",
    };
  }
  if (asksToRemove) {
    return {
      summary: "Remove things preview",
      changed: ["Remove matching enemies, rewards, doors, or goals only inside the selected area."],
      suggestedTest: "Apply it, then confirm the rest of the level stayed intact.",
    };
  }
  if (asksForDanger) {
    return {
      summary: "Danger preview",
      changed: ["Paint the selected level squares as danger."],
      suggestedTest: "Apply it, then test whether the hazard is fair.",
    };
  }
  if (asksForWater) {
    return {
      summary: "Water preview",
      changed: ["Paint the selected level squares as water."],
      suggestedTest: "Apply it, then test how the hero moves through it.",
    };
  }
  if (asksForSafeGround) {
    return {
      summary: "Safe ground preview",
      changed: ["Paint safe ground inside the selected area."],
      suggestedTest: "Apply it, then test the jump or landing.",
    };
  }
  const kind = selectedAreaAddKindFromPrompt(lower) ?? "item";
  const name = guidedThingNameFromPrompt(prompt, kind);
  return {
    summary: `${name} preview`,
    changed: [`Place ${name} in the selected area.`],
    suggestedTest: "Apply it, then playtest this spot immediately.",
  };
}

function previewPromptForSelectedArea(host: HostUpdate) {
  const area = selectedScreenArea;
  const scene = selectedScene();
  const prompt = arcadeAreaPromptDraft.trim();
  if (!area || !scene || !prompt) {
    pendingAreaPreview = null;
    host.requestUpdate?.();
    return;
  }
  const provider = aiGameStageResolvedProvider("level");
  pendingAreaPreview = {
    id: `area-preview-${Date.now()}`,
    prompt,
    area,
    provider,
    createdAt: new Date().toISOString(),
    ...describeSelectedAreaPrompt(area, prompt),
  };
  lastAiActionFeedback = {
    status: "review",
    title: "Preview ready",
    detail: "Review the selected-area change, then apply it only if it looks right.",
    provider,
    target: "selected area",
    createdAt: pendingAreaPreview.createdAt,
  };
  pushConsole(host, `Previewed selected-area change: ${pendingAreaPreview.summary}`);
  host.requestUpdate?.();
}

function selectedAreaPreviewMatchesCurrentSelection(preview: SnesPendingAreaPreview) {
  const area = selectedScreenArea;
  return Boolean(
    area &&
    area.sceneId === preview.area.sceneId &&
    area.xPercent === preview.area.xPercent &&
    area.yPercent === preview.area.yPercent &&
    area.widthPercent === preview.area.widthPercent &&
    area.heightPercent === preview.area.heightPercent,
  );
}

function applyPendingAreaPreview(host: HostUpdate) {
  const preview = pendingAreaPreview;
  if (!preview) {
    return;
  }
  selectedScreenArea = preview.area;
  project.selectedScreenArea = preview.area;
  arcadeAreaPromptDraft = preview.prompt;
  pendingAreaPreview = null;
  applyPromptToSelectedScreenArea(host);
}

function discardPendingAreaPreview(host: HostUpdate) {
  pendingAreaPreview = null;
  lastAiActionFeedback = {
    status: "ready",
    title: "Preview canceled",
    detail: "Nothing changed. You can adjust the prompt or keep playing.",
    provider: aiGameStageResolvedProvider("level"),
    target: "selected area",
    createdAt: new Date().toISOString(),
  };
  pushConsole(host, "Canceled selected-area AI preview.");
  host.requestUpdate?.();
}

function applyPromptToSelectedScreenArea(host: HostUpdate) {
  const area = selectedScreenArea;
  const scene = selectedScene();
  const prompt = arcadeAreaPromptDraft.trim();
  pendingAreaPreview = null;
  if (!area || !scene) {
    runAiGameStageCommand(host);
    return;
  }
  const lower = prompt.toLowerCase();
  const provider = aiGameStageResolvedProvider("level");
  const center = selectedAreaWorldCenter(scene, area);
  let summary = "AI changed the selected area";
  let changed = "selected emulator area";

  project.aiChangeRequest = {
    prompt,
    provider,
    scope: "selected-area",
    selectedArea: area,
  };

  const moveDelta = selectedAreaMovesContent(area) ? selectedAreaMoveDeltaFromPrompt(lower) : null;
  const resizeDelta = selectedAreaMovesContent(area)
    ? selectedAreaResizeDeltaFromPrompt(lower)
    : null;
  const asksToRemove = promptHasAny(lower, ["remove", "delete", "clear", "erase"]);
  const asksForGap = promptHasAny(lower, ["gap", "pit", "hole", "empty space", "empty area"]);
  const asksForDanger = promptHasAny(lower, [
    "lava",
    "spike",
    "spikes",
    "danger",
    "hazard",
    "harder",
  ]);
  const asksForWater = promptHasAny(lower, ["water", "river", "pond"]);
  const asksForSafeGround = promptHasAny(lower, [
    "platform",
    "ground",
    "bridge",
    "safe",
    "easier",
    "jump",
  ]);
  const asksToClearTerrain =
    asksForGap ||
    promptHasAny(lower, [
      "clear everything",
      "remove everything",
      "delete everything",
      "erase everything",
      "clear ground",
      "remove ground",
      "delete ground",
      "erase ground",
      "clear platform",
      "remove platform",
      "delete platform",
      "erase platform",
    ]);
  if (moveDelta) {
    const targetArea = selectedAreaFromMovedTileRect(
      scene,
      area,
      moveDelta.deltaColumn,
      moveDelta.deltaRow,
    );
    if (moveSelectedAreaContent(host, area, targetArea)) {
      summary = `${area.label} moved`;
      changed = `moved ${area.label} ${moveDelta.deltaColumn} level square${Math.abs(moveDelta.deltaColumn) === 1 ? "" : "s"} sideways and ${moveDelta.deltaRow} level square${Math.abs(moveDelta.deltaRow) === 1 ? "" : "s"} vertically`;
    } else {
      summary = `${area.label} stayed put`;
      changed = "selected level piece was already at that edge";
    }
  } else if (resizeDelta) {
    const targetArea = selectedAreaFromResizedTileRect(
      scene,
      area,
      resizeDelta.deltaWidth,
      resizeDelta.deltaHeight,
    );
    if (resizeSelectedAreaContent(host, area, targetArea)) {
      summary = `${area.label} resized`;
      changed = `resized ${area.label} by ${resizeDelta.deltaWidth} level square${Math.abs(resizeDelta.deltaWidth) === 1 ? "" : "s"} wide and ${resizeDelta.deltaHeight} level square${Math.abs(resizeDelta.deltaHeight) === 1 ? "" : "s"} tall`;
    } else {
      summary = `${area.label} stayed the same size`;
      changed = "selected level piece was already at that size limit";
    }
  } else if (asksToClearTerrain) {
    const rect = selectedAreaTileRect(area);
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (!draftScene) return;
      const removed = removeMatchingEntitiesFromSelectedArea(draftScene, area, lower);
      clearSelectedAreaCells(draftScene, rect);
      changed =
        removed > 0
          ? `cleared the level area and removed ${removed} thing${removed === 1 ? "" : "s"}`
          : "cleared the level area";
      draft.aiChangeRequest = project.aiChangeRequest;
    });
    summary = asksForGap ? "Gap made" : "Selected area cleared";
  } else if (asksToRemove) {
    updateProject(host, (draft) => {
      const draftScene = draft.scenes[selectedSceneIndex];
      if (!draftScene) return;
      const removed = removeMatchingEntitiesFromSelectedArea(draftScene, area, lower);
      changed =
        removed > 0
          ? `${removed} matching thing${removed === 1 ? "" : "s"} removed`
          : "no matching things were inside the selected area";
      draft.aiChangeRequest = project.aiChangeRequest;
    });
    summary = "Selected things removed";
  } else if (asksForDanger) {
    paintSelectedArea(host, 4, 2);
    summary = "Danger added";
    changed = "painted danger where you selected";
  } else if (asksForWater) {
    paintSelectedArea(host, 4, 4);
    summary = "Water added";
    changed = "painted water where you selected";
  } else if (asksForSafeGround) {
    paintSelectedArea(host, 1, 1);
    summary = "Safe ground added";
    changed = "painted safe ground where you selected";
  } else {
    const kind = selectedAreaAddKindFromPrompt(lower) ?? "item";
    const name = addGuidedThingToLevel(host, kind, center, prompt);
    summary = `${name ?? guidedThingLabel(kind)} added`;
    changed = `${guidedThingLabel(kind).toLowerCase()} placed in the selected area`;
  }

  hotReloadRuntimeAfterEdit(
    host,
    summary,
    "This selected-area change is now in the 60 Hz playtest.",
  );
  markGuidedAiResult(host, provider, "level", summary, [changed], "Playtest this area now.");
  selectedGuidedStep = "playtest";
  selectedMode = "play";
  selectedPanel = "scene";
  host.requestUpdate?.();
}

function renderSelectedAreaPreviewCard(host: HostUpdate) {
  if (!pendingAreaPreview) {
    return nothing;
  }
  const previewStillMatches = selectedAreaPreviewMatchesCurrentSelection(pendingAreaPreview);
  return html`
    <div class="snes-area-ai-preview" aria-label="Preview selected area AI change">
      <div class="snes-area-ai-preview__copy">
        <span>Preview before apply</span>
        <strong>${pendingAreaPreview.summary}</strong>
        <small>
          ${previewStillMatches
            ? `${liveAgentProviderLabel(pendingAreaPreview.provider)} will change only ${pendingAreaPreview.area.label}.`
            : "The selection changed after this preview was made. Cancel it and preview again."}
        </small>
      </div>
      <ul>
        ${pendingAreaPreview.changed.map((change) => html`<li>${change}</li>`)}
        <li>${pendingAreaPreview.suggestedTest}</li>
      </ul>
      <div class="snes-area-ai-preview__actions">
        <button
          type="button"
          class="primary"
          ?disabled=${!previewStillMatches}
          @click=${() => applyPendingAreaPreview(host)}
        >
          Apply Preview
        </button>
        <button type="button" @click=${() => discardPendingAreaPreview(host)}>
          Cancel Preview
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host, true, true)}>
          Test Now
        </button>
      </div>
    </div>
  `;
}

function renderSelectedScreenAreaOverlay(host: HostUpdate) {
  if (!selectedScreenArea) {
    return nothing;
  }
  return html`
    <div
      class=${`snes-emulator-selection${areaEditDrag?.mode === "move" ? " moving" : ""}${areaEditDrag?.mode === "resize" ? " resizing" : ""}`}
      aria-label="Selected emulator area"
      style=${`left:${selectedScreenArea.xPercent}%;top:${selectedScreenArea.yPercent}%;width:${selectedScreenArea.widthPercent}%;height:${selectedScreenArea.heightPercent}%;`}
    >
      <span @pointerdown=${(event: PointerEvent) => startSelectedAreaEdit(host, event, "move")}
        >${selectedAreaMovesContent(selectedScreenArea)
          ? `Move ${selectedScreenArea.label}`
          : "Drag to move"}</span
      >
      <button
        type="button"
        class="snes-emulator-selection__resize"
        aria-label="Resize selected emulator area"
        title="Drag to resize the selected area"
        @pointerdown=${(event: PointerEvent) => startSelectedAreaEdit(host, event, "resize")}
      >
        ${selectedAreaMovesContent(selectedScreenArea)
          ? `Resize ${selectedScreenArea.label}`
          : "Resize"}
      </button>
    </div>
  `;
}

function renderGameTestPanel(host: HostUpdate) {
  const scene = selectedScene();
  if (!scene) {
    return nothing;
  }
  const state = previewSimulationState;
  const playerX =
    state?.playerX ?? scene.entities.find((entity) => entity.kind === "player")?.x ?? 32;
  const playerY =
    state?.playerY ?? scene.entities.find((entity) => entity.kind === "player")?.y ?? 176;
  const playerEntity = scene.entities.find((entity) => entity.kind === "player");
  const cameraX = state?.cameraScrollX ?? 0;
  const eventPreview =
    lastEventSimulation ?? simulateSnesEventScripts(project, "on-start", "scene");
  const transitions = createSnesLevelTransitionPlan(project);
  const runtimeEvents = createSnesRuntimeEventPlan(project);
  const physics = createSnesCollisionPhysicsPlan(project);
  const audio = createSnesSpc700ExportPlan(project);
  const runtime = currentRuntimeProject();
  const runtimeManifest = runtime.manifest;
  let emulatorReplayProof: ReturnType<typeof createSnesEmulatorReplayParityProof> | null = null;
  try {
    emulatorReplayProof = currentEmulatorReplayParityProof();
  } catch {
    emulatorReplayProof = null;
  }
  scheduleRuntimeCanvasPaint();
  return html`
    <section class="snes-playtest" aria-label="Test Game">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Test Game</span>
          <strong>60 Hz runtime playtest</strong>
          <p>
            ${state
              ? (lastPlaytestFeedback?.detail ??
                `${state.collectedItems.length} collected; ${state.defeatedEnemies.length} defeated.`)
              : "Ready to run the current scene."}
          </p>
        </div>
        <div class="snes-toolbar">
          <button type="button" class="primary" @click=${() => startLivePlaytest(host)}>
            Start Test
          </button>
          <button type="button" @click=${() => resetPreviewPlaytest(host)}>Reset Test</button>
          <button
            type="button"
            ?disabled=${project.scenes.length <= 1}
            @click=${() => switchPreviewScene(host, -1)}
          >
            Previous Level
          </button>
          <button
            type="button"
            ?disabled=${project.scenes.length <= 1}
            @click=${() => switchPreviewScene(host, 1)}
          >
            Next Level
          </button>
        </div>
      </div>
      <div class="snes-playtest__hud">
        <span>status ${state?.status ?? "ready"}</span>
        <span>health ${state?.health ?? 3}/3</span>
        <span>lives ${state?.lives ?? 3}</span>
        <span>score ${state?.score ?? 0}</span>
        <span>frame ${state?.frame ?? 0}</span>
        <span>${runtimeManifest.cadence.replace("-", " ")}</span>
        <span>Replay parity ${emulatorReplayProof?.status ?? "blocked"}</span>
        <span>story beats ${eventPreview.triggeredEventIds.length}</span>
        <span>dialogue ${eventPreview.shownCutsceneIds.length}</span>
        <span
          >bumps
          ${state?.collisions.filter((collision) => collision !== "ground").length ?? 0}</span
        >
        <span>on ground ${state?.grounded ? "yes" : "no"}</span>
      </div>
      <details class="snes-playtest__expert">
        <summary>Expert test details</summary>
        <div class="snes-runtime-gates" aria-label="Runtime milestone gates">
          <div class="snes-runtime-gates__title">
            <strong>Runtime milestone gates</strong>
            <small>Visible proof status before game-file or hardware claims.</small>
          </div>
          <article>
            <span>Scenes</span>
            <strong>${transitions.runtimeStatus}</strong>
            <small
              >${transitions.transitions.length}
              transition${transitions.transitions.length === 1 ? "" : "s"}</small
            >
          </article>
          <article>
            <span>Events</span>
            <strong>${runtimeEvents.runtimeStatus}</strong>
            <small
              >${runtimeEvents.eventCount} script${runtimeEvents.eventCount === 1 ? "" : "s"}</small
            >
          </article>
          <article>
            <span>Physics</span>
            <strong>${physics.runtimeStatus}</strong>
            <small
              >${physics.materials.filter(
                (material) => material.productionRuntimeStatus === "implemented",
              ).length}/${physics.materials.length}
              materials</small
            >
          </article>
          <article>
            <span>Audio</span>
            <strong>${audio.status}</strong>
            <small
              >${formatBytes(audio.aramMap.reduce((sum, entry) => sum + entry.sizeBytes, 0))} ARAM
              plan</small
            >
          </article>
          <article>
            <span>Playtest</span>
            <strong>${runtimeManifest.runtimeHash}</strong>
            <small
              >${runtime.frameRate.toFixed(4)} FPS ·
              ${livePlaytestFps > 0 ? livePlaytestFps.toFixed(0) : "ready"} drawn ·
              ${livePlaytestDroppedFrames} slow
              frame${livePlaytestDroppedFrames === 1 ? "" : "s"}</small
            >
          </article>
          <article>
            <span>Replay proof</span>
            <strong>${lastRuntimeParityReport?.runtimeStatus ?? "not-run-yet"}</strong>
            <small
              >${lastRuntimeParityReport
                ? `${lastRuntimeParityReport.frameCount} frames · ${lastRuntimeParityReport.finalStateHash}`
                : "Run, auto-run, or frame-step to create a browser replay proof."}</small
            >
          </article>
          <article>
            <span>Emulator parity</span>
            <strong>${emulatorReplayProof?.status ?? "blocked"}</strong>
            <small
              >${emulatorReplayProof
                ? `${emulatorReplayProof.evidence.emulator ?? "no emulator"} · ${emulatorReplayProof.evidence.browserFinalStateHash}`
                : "Build the SNES game file before emulator replay proof."}</small
            >
          </article>
        </div>
        ${renderRomRuntimeProof()}
      </details>
      <div
        class=${`snes-playtest__stage snes-emulator-canvas${livePlaytestRunning ? " snes-playtest__stage--running" : ""}${state?.status === "won" ? " snes-playtest__stage--won" : ""}${state?.status === "lost" ? " snes-playtest__stage--lost" : ""}${selectedScreenArea ? " snes-emulator-canvas--has-selection" : ""}${directEntityDrag ? " snes-emulator-canvas--direct-drag" : ""}${areaEditDrag ? " snes-emulator-canvas--area-drag" : ""}`}
        style=${`--play-columns:${scene.widthMetatiles};--play-rows:${scene.heightMetatiles};`}
        tabindex="0"
        @keydown=${(event: KeyboardEvent) => handlePlayModeKeydown(host, event)}
        @keyup=${(event: KeyboardEvent) => handlePlayModeKeyup(host, event)}
        @pointerdown=${(event: PointerEvent) => startScreenAreaSelection(host, event)}
        @pointermove=${(event: PointerEvent) => {
          if (updateDirectEntityDrag(host, event)) {
            return;
          }
          if (updateSelectedAreaEdit(host, event)) {
            return;
          }
          updateScreenAreaSelection(host, event);
        }}
        @pointerup=${(event: PointerEvent) => {
          if (finishDirectEntityDrag(host, event)) {
            return;
          }
          if (finishSelectedAreaEdit(host, event)) {
            return;
          }
          finishScreenAreaSelection(host, event);
        }}
        @pointercancel=${() => {
          cancelDirectEntityDrag(host);
          cancelSelectedAreaEdit(host);
          arcadeAreaDragStart = null;
        }}
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${(event: DragEvent) => dropSceneObjectOnStage(host, event)}
      >
        <div class="snes-playtest__live-badge" aria-live="polite">
          <strong>${livePlaytestRunning ? "Live play running" : "Ready to play"}</strong>
          <span>
            ${state?.status === "won"
              ? "Goal reached"
              : state?.status === "lost"
                ? "Hero lost"
                : livePlaytestRunning
                  ? "Hold keys or buttons to control the hero"
                  : "Press Start Test, then hold Right or Jump"}
          </span>
        </div>
        <div class="snes-playtest__stage-hint" aria-hidden="true">
          Click a glow to edit. Drag a glow to move it. Drag empty space to change an area.
        </div>
        <canvas
          class="snes-runtime-canvas"
          data-snes-runtime-canvas
          width=${SNES_RUNTIME_VIEWPORT.width}
          height=${SNES_RUNTIME_VIEWPORT.height}
          aria-label="60 Hz runtime playtest canvas"
        ></canvas>
        ${renderSelectedScreenAreaOverlay(host)} ${renderPlaySceneWorld(scene, cameraX)}
        ${playerEntity
          ? html`
              <button
                type="button"
                class=${`snes-playtest__marker snes-playtest__marker--hero${focusedGeneratedObjectId === `${scene.id}:${playerEntity.id}` ? " active" : ""}${directEntityDrag?.entityId === playerEntity.id ? " dragging" : ""}`}
                style=${playtestMarkerStyle(scene, playerX, playerY, false)}
                aria-label="Hero in test scene. Click to edit, drag to move."
                title="Click to edit. Drag to move."
                draggable="true"
                @pointerdown=${(event: PointerEvent) =>
                  startDirectEntityDrag(host, event, scene, playerEntity)}
                @dragstart=${(event: DragEvent) => {
                  event.dataTransfer?.setData("text/plain", playerEntity.id);
                  draggedEntityId = playerEntity.id;
                  draggedPalettePiece = null;
                  draggedGuidedThingKind = null;
                  draggedPart = null;
                }}
                @click=${() => selectSceneEntity(host, scene, playerEntity)}
              >
                <span class="snes-piece-glyph" aria-hidden="true"></span>
                <span class="snes-playtest__marker-label">Hero</span>
              </button>
            `
          : nothing}
        ${scene.entities
          .filter((entity) => entity.kind !== "player")
          .map((entity) => {
            const enemyPosition = state?.enemyPositions[entity.id];
            const x = enemyPosition?.x ?? entity.x;
            const y = enemyPosition?.y ?? entity.y;
            const markerKind = sceneEntityCanvasLabel(entity).toLowerCase();
            const inactive =
              state?.collectedItems.includes(entity.id) ||
              state?.defeatedEnemies.includes(entity.id);
            return html`
              <button
                type="button"
                class=${`snes-playtest__marker snes-playtest__marker--${markerKind}${inactive ? " inactive" : ""}${focusedGeneratedObjectId === `${scene.id}:${entity.id}` ? " active" : ""}${directEntityDrag?.entityId === entity.id ? " dragging" : ""}`}
                style=${playtestMarkerStyle(scene, x, y)}
                aria-label=${`${sceneEntityCanvasLabel(entity)} ${entity.name}${inactive ? " cleared" : ""}. Click to edit, drag to move.`}
                title="Click to edit. Drag to move."
                draggable="true"
                @pointerdown=${(event: PointerEvent) =>
                  startDirectEntityDrag(host, event, scene, entity)}
                @dragstart=${(event: DragEvent) => {
                  event.dataTransfer?.setData("text/plain", entity.id);
                  draggedEntityId = entity.id;
                  draggedPalettePiece = null;
                  draggedGuidedThingKind = null;
                  draggedPart = null;
                }}
                @click=${() => selectSceneEntity(host, scene, entity)}
              >
                <span class="snes-piece-glyph" aria-hidden="true"></span>
                <span class="snes-playtest__marker-label">${sceneEntityCanvasLabel(entity)}</span>
              </button>
            `;
          })}
        ${renderPlaytestOutcomeOverlay(host, state)}
      </div>
      ${renderPlaytestFeedback()} ${renderPlaytestQuickActions(host)}
      ${renderPlaytestMoments(host, scene)} ${renderPlayControllerPanel(host)}
      ${renderPlayStoryChecks(host)}
    </section>
  `;
}

function renderPlayNowCoach(host: HostUpdate) {
  const scene = selectedScene();
  if (!scene) {
    return nothing;
  }
  const state = previewSimulationState;
  const provider =
    lastAiActionFeedback?.provider === "codex"
      ? "Codex"
      : lastAiActionFeedback?.provider === "openclaw"
        ? "OpenClaw Agent"
        : "AI";
  const generatedLine =
    lastAiActionFeedback?.status === "ready"
      ? `Instant builder made ${project.name} with ${provider} selected.`
      : `${project.name} is ready.`;
  const playerLine = lastPlaytestFeedback
    ? `${lastPlaytestFeedback.title}. ${lastPlaytestFeedback.detail}`
    : state
      ? "The hero is moving in the test scene."
      : "Start is ready whenever you want to restart.";
  const nonPlayerPieces = scene.entities.filter((entity) => entity.kind !== "player").length;
  return html`
    <section class="snes-play-now-coach" aria-label="Play status">
      <div class="snes-play-now-coach__copy">
        <span class="snes-eyebrow">Now Playing</span>
        <h4>Game is running now</h4>
        <p>${generatedLine} ${playerLine}</p>
      </div>
      <div class="snes-play-now-coach__facts" aria-label="Current test facts">
        <article>
          <span>Level</span>
          <strong>${selectedSceneIndex + 1}/${project.scenes.length}</strong>
        </article>
        <article>
          <span>Things</span>
          <strong>${nonPlayerPieces}</strong>
        </article>
        <article>
          <span>Collected</span>
          <strong>${state?.collectedItems.length ?? 0}</strong>
        </article>
        <article>
          <span>Bumps</span>
          <strong
            >${state?.collisions.filter((collision) => collision !== "ground").length ?? 0}</strong
          >
        </article>
      </div>
      <div class="snes-play-now-coach__actions">
        <button
          type="button"
          class="primary"
          @click=${() => stepPreviewPlaytest(host, { right: true })}
        >
          Move Right
        </button>
        <button type="button" @click=${() => stepPreviewPlaytest(host, { jump: true })}>
          Jump
        </button>
        <button type="button" @click=${() => selectStudioMode(host, "edit")}>
          Build This Level
        </button>
        <button type="button" @click=${() => selectStudioMode(host, "ship")}>
          Export Game File
        </button>
      </div>
    </section>
  `;
}

function renderLevelPreview(host: HostUpdate) {
  const scene = selectedScene();
  if (!scene) {
    return nothing;
  }
  const cells = Array.from({ length: scene.tilemap.length }, (_, index) => {
    const tile = scene.tilemap[index] ?? 0;
    const collisionMaterial = (scene.collisionMap[index] ?? 0) as SnesCollisionMaterial;
    const solid = collisionMaterial > 0;
    const imported = tile >= SNES_IMPORTED_TILE_BRUSH_BASE;
    return html`<span
      class=${`tile tile-${tile}${imported ? " imported" : ""}${solid ? " solid" : ""} collision-${collisionMaterial}`}
      role="button"
      tabindex="0"
      aria-label=${`Paint cell ${index}, collision material ${collisionMaterial}`}
      @click=${() => paintSceneCell(host, index)}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        moveEntityToCell(host, index);
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          paintSceneCell(host, index);
        }
      }}
    ></span>`;
  });
  return html`
    <section class="snes-workspace__canvas">
      <div class="snes-section-header">
        <div>
          <h3>${scene.name}</h3>
          <p>
            Level ${selectedSceneIndex + 1}/${project.scenes.length},
            ${scene.widthMetatiles}x${scene.heightMetatiles} metatiles, ${scene.layers} layers,
            ${scene.collisionTiles} collision cells.
          </p>
        </div>
        <div class="snes-toolbar">
          <button type="button" @click=${() => addLevel(host)}>Add Level</button>
          <button type="button" @click=${() => duplicateLevel(host)}>Duplicate Level</button>
          <button type="button" @click=${() => removeLevel(host)}>Remove Level</button>
          <button type="button" @click=${() => addEntity(host, "enemy")}>Add Enemy</button>
          <button type="button" @click=${() => addEntity(host, "item")}>Add Item</button>
          <button type="button" @click=${() => addEntity(host, "npc")}>Add NPC</button>
          <button type="button" @click=${() => fillGroundBand(host)}>Fill Ground</button>
          <button type="button" @click=${() => paintLevelFromPrompt(host)}>
            Paint From Prompt
          </button>
        </div>
      </div>
      <div class="snes-level-tabs" aria-label="Levels">
        ${project.scenes.map(
          (candidate, index) => html`
            <button
              type="button"
              class=${selectedSceneIndex === index ? "active" : ""}
              @click=${() => {
                selectedSceneIndex = index;
                pushConsole(host, `Selected ${candidate.name}.`);
              }}
            >
              ${candidate.name}
            </button>
          `,
        )}
      </div>
      <div class="snes-toolbar" aria-label="Layer edit mode">
        <button
          type="button"
          class=${selectedPaintMode === "tile" ? "active" : ""}
          @click=${() => selectPaintMode(host, "tile")}
        >
          Tile Paint
        </button>
        <button
          type="button"
          class=${selectedPaintMode === "collision" ? "active" : ""}
          @click=${() => selectPaintMode(host, "collision")}
        >
          Collision Paint
        </button>
      </div>
      <div class="snes-toolbar" aria-label="Brush size">
        ${([1, 2, 3, 4] as const).map(
          (size) => html`
            <button
              type="button"
              class=${selectedBrushSize === size ? "active" : ""}
              @click=${() => selectBrushSize(host, size)}
            >
              ${size}x${size} Brush
            </button>
          `,
        )}
        <button type="button" @click=${() => fillCurrentLayer(host)}>Fill Layer</button>
        <button type="button" @click=${() => clearCurrentLayer(host)}>Clear Layer</button>
      </div>
      <div class="snes-toolbar" aria-label="Collision materials">
        ${(
          [
            [0, "Passable"],
            [1, "Solid"],
            [2, "Hazard"],
            [3, "One-Way"],
            [4, "Water"],
          ] as const
        ).map(
          ([material, label]) => html`
            <button
              type="button"
              class=${selectedPaintMode === "collision" && selectedCollisionMaterial === material
                ? "active"
                : ""}
              @click=${() => selectCollisionMaterial(host, material)}
            >
              ${label}
            </button>
          `,
        )}
      </div>
      <div class="snes-toolbar" aria-label="Tile brushes">
        ${(
          [[0, "Air"], [1, "Ground"], [2, "Ledge"], [3, "Item"], ...importedTileBrushes()] as const
        ).map(
          ([tile, label]) => html`
            <button
              type="button"
              class=${selectedTileBrush === tile ? "active" : ""}
              @click=${() => selectTileBrush(host, tile)}
            >
              ${label}
            </button>
          `,
        )}
      </div>
      <div class="snes-brush-presets" aria-label="Prompt brush presets">
        ${promptBrushPresets.map(
          (preset) => html`
            <button type="button" @click=${() => applyPromptBrushPreset(host, preset)}>
              ${preset.label}
            </button>
          `,
        )}
      </div>
      <div class="snes-level-grid" aria-label="Mode 1 level preview">${cells}</div>
      ${renderGameTestPanel(host)}
      <div class="snes-entity-strip">
        ${scene.entities.length > 0
          ? html`<p class="snes-muted">
              Drag generated entities onto the grid, then refine them in the inspector.
            </p>`
          : nothing}
        ${scene.entities.map(
          (entity) => html`
            <button
              type="button"
              draggable="true"
              @dragstart=${() => {
                draggedEntityId = entity.id;
              }}
              @click=${() => selectPanel(host, "scene")}
            >
              <strong>${entity.kind}</strong>
              <span>${entity.name} at ${entity.x}, ${entity.y}</span>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderInspector(host: HostUpdate) {
  const scene = selectedScene();
  const readiness = buildSnesReadiness(project);
  const manifest = createFxpakExportManifest(project);
  const saveManifest = createSnesSaveManifest(project);
  const sramSerialization = createSnesSramSerializationReport(project);
  const audioManifest = createSnesAudioManifest(project);
  const assetPipeline = createSnesAssetPipelineReport(project);
  const superFxReport = createSnesSuperFxProfileReport(project);
  const cutsceneTimeline = createSnesCutsceneTimeline(project);
  const onePromptReport = createSnesOnePromptGameReport(project);
  const agentTasks = createSnesAgentTaskBlueprints(project);
  const pendingPatchDiffs = pendingAgentProposal
    ? diffSnesAgentPatchProposal(project, pendingAgentProposal)
    : [];
  return html`
    <aside class="snes-inspector">
      <div class="snes-tabs" role="tablist">
        ${(
          ["project", "prompt", "scene", "assets", "story", "logic", "export", "agents"] as const
        ).map(
          (tab) => html`
            <button
              type="button"
              class=${selectedPanel === tab ? "active" : ""}
              @click=${() => selectPanel(host, tab)}
            >
              ${tab}
            </button>
          `,
        )}
      </div>
      ${selectedPanel === "project"
        ? html`
            <label>
              Project name
              <input
                .value=${project.name}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.name = inputValue(event);
                  })}
              />
            </label>
            <label>
              ROM base filename
              <input
                .value=${project.export.romBaseName}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.export.romBaseName = inputValue(event);
                  })}
              />
            </label>
            <label>
              Import project JSON or bundle
              <textarea
                rows="4"
                .value=${projectImportDraft}
                @input=${(event: Event) => {
                  projectImportDraft = inputValue(event);
                }}
              ></textarea>
            </label>
            <button type="button" @click=${() => importProjectDocument(host)}>
              Import Project Document
            </button>
            <label>
              Open project file
              <input
                type="file"
                accept=".json,application/json"
                @change=${(event: Event) => void importProjectFile(host, event)}
              />
            </label>
            <div class="snes-inspector__grid">
              <span>Profile</span
              ><strong>
                ${project.profile.mapMode.toUpperCase()} ${project.profile.region.toUpperCase()}
                ${project.profile.videoMode.toUpperCase()}
              </strong>
              <span>SuperFX</span><strong>${superFxReport.status}</strong> <span>SRAM</span
              ><strong>${project.profile.sramSizeKib} KiB</strong> <span>ROM</span
              ><strong>${project.profile.romSizeMbit} Mbit</strong>
            </div>
            ${(() => {
              const bundle = createSnesProjectBundle(project, projectVersions);
              return html`
                <div class="snes-agent-proposal">
                  <div class="snes-section-header">
                    <div>
                      <strong>Project Package QA</strong>
                      <p>Portable project bundle readiness for backup, review, and handoff.</p>
                    </div>
                    <strong>${bundle.manifest.readiness.status.toUpperCase()}</strong>
                  </div>
                  <div class="snes-inspector__grid">
                    <span>Versions</span><strong>${bundle.manifest.versionCount}</strong>
                    <span>ROM</span><strong>${bundle.manifest.fxpak.romFileName}</strong>
                    <span>FXPAK path</span><strong>${bundle.manifest.fxpak.romPath}</strong>
                  </div>
                </div>
              `;
            })()}
          `
        : nothing}
      ${selectedPanel === "prompt"
        ? html`
            <div class="snes-ai-header">
              <strong>AI Creator</strong>
              <p>
                Create the whole game or generate one editable component at a time with OpenClaw
                agents or Codex.
              </p>
            </div>
            ${renderAgentConnectionSummary(host)}
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>One-Prompt Game Proof</strong>
                  <p>Tracks whether a single prompt produced every editable game component.</p>
                </div>
                <strong>${onePromptReport.status} ${onePromptReport.score}/100</strong>
              </div>
              <div class="snes-inspector__grid">
                <span>Editable objects</span
                ><strong>${onePromptReport.editableObjectCount}</strong>
                <span>Required surfaces</span
                ><strong>${onePromptReport.prompt.requiredSurfaces.length}</strong>
                <span>Next edit panels</span
                ><strong>${onePromptReport.nextEditPanels.join(", ") || "none"}</strong>
              </div>
              <div class="snes-patch-list">
                ${onePromptReport.components.map(
                  (component) => html`
                    <code>${component.status}</code>
                    <span>${component.label}</span>
                    <small>${component.detail}</small>
                  `,
                )}
              </div>
            </div>
            <div class="snes-ai-grid">
              ${createSnesAiAuthoringPrompts(project).map((entry) =>
                renderAiCreatorCard(host, entry),
              )}
            </div>
            <label>
              Paste returned patch JSON
              <textarea
                rows="5"
                .value=${agentPatchDraft}
                @input=${(event: Event) => {
                  agentPatchDraft = inputValue(event);
                }}
              ></textarea>
            </label>
            <button type="button" @click=${() => importAgentPatchFromJson(host)}>
              Import Agent Patch JSON
            </button>
            ${pendingAgentProposal
              ? html`
                  <div class="snes-agent-proposal">
                    <strong>${pendingAgentProposal.summary}</strong>
                    <p>
                      Readiness: ${pendingAgentProposal.readiness.status.toUpperCase()}
                      ${pendingAgentProposal.readiness.score}/100
                    </p>
                    <div class="snes-approval-stepper" aria-label="AI approval steps">
                      <span class="active">1 Review</span>
                      <span>2 Approve</span>
                      <span>3 Edit</span>
                    </div>
                    <div class="snes-inspector__grid">
                      <span>Provider</span
                      ><strong
                        >${pendingAgentProposal.requestedAgent === "openclaw"
                          ? "OpenClaw"
                          : "Codex"}</strong
                      >
                      <span>Surface</span><strong>${pendingAgentProposal.surface}</strong>
                      <span>Source</span><strong>${pendingAgentProposal.source}</strong>
                    </div>
                    <div class="snes-patch-diff">
                      <strong>Path</strong>
                      <strong>Before</strong>
                      <strong>After</strong>
                      ${pendingPatchDiffs.slice(0, 14).map(
                        (diff) => html`
                          <code>${diff.path}</code>
                          <span>${formatPatchValue(diff.before)}</span>
                          <span>${formatPatchValue(diff.after)}</span>
                        `,
                      )}
                    </div>
                    ${pendingPatchDiffs.length > 14
                      ? html`<small>
                          ${pendingPatchDiffs.length - 14} more approved patch paths
                        </small>`
                      : nothing}
                    <div class="snes-toolbar">
                      <button type="button" class="primary" @click=${() => approveAgentPatch(host)}>
                        Approve Patch
                      </button>
                      <button type="button" @click=${() => discardAgentPatch(host)}>Discard</button>
                    </div>
                  </div>
                `
              : nothing}
            ${agentDispatchQueue.length > 0
              ? html`
                  <div class="snes-agent-proposal">
                    <strong>Queued OpenClaw/Codex tasks</strong>
                    <div class="snes-patch-list">
                      ${agentDispatchQueue.slice(0, 4).map(
                        (record) => html`
                          <code>${record.status}</code>
                          <span>${record.taskPacket.userPrompt || record.projectName}</span>
                          <button type="button" @click=${() => runQueuedAgentTask(host, record)}>
                            Run Local Agent
                          </button>
                          <button
                            type="button"
                            @click=${() => void sendQueuedAgentTaskToGateway(host, record)}
                          >
                            Send to Gateway Agent
                          </button>
                        `,
                      )}
                    </div>
                  </div>
                `
              : nothing}
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Live Agent Results</strong>
                  <p>Import returned OpenClaw/Codex patches without pasting JSON.</p>
                </div>
                <button type="button" @click=${() => refreshAgentResults(host)}>Refresh</button>
              </div>
              ${agentResultQueue.length > 0
                ? html`
                    <div class="snes-patch-list">
                      ${agentResultQueue.slice(0, 4).map(
                        (record) => html`
                          <code>${record.requestedAgent}</code>
                          <span>
                            ${record.surface} result for ${record.recordId}
                            <small>${record.createdAt}</small>
                          </span>
                          <button type="button" @click=${() => importAgentResult(host, record)}>
                            Import Result
                          </button>
                        `,
                      )}
                    </div>
                  `
                : html`<p class="snes-muted">No returned agent patches are waiting.</p>`}
              <p class="snes-muted">
                Live sync watches ${SNES_AGENT_RESULT_QUEUE_KEY}; last sync
                ${lastAgentSyncAt ?? "not yet"}.
              </p>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Live Agent Stream</strong>
                  <p>Watch OpenClaw/Codex streaming chunks and auto-import final patches.</p>
                </div>
                <button type="button" @click=${() => syncAgentQueuesFromStorage(host, true)}>
                  Sync Stream
                </button>
              </div>
              ${agentStreamRecords.length > 0
                ? html`
                    <div class="snes-patch-list">
                      ${agentStreamRecords.slice(0, 5).map(
                        (record) => html`
                          <code>${record.status}</code>
                          <span>
                            ${record.surface} via
                            ${record.requestedAgent === "openclaw" ? "OpenClaw" : "Codex"}
                            <small>${record.chunk ?? record.responseText ?? record.id}</small>
                          </span>
                          <button
                            type="button"
                            ?disabled=${!record.responseText}
                            @click=${() => ingestAgentStreamRecord(host, record)}
                          >
                            Import Stream Patch
                          </button>
                        `,
                      )}
                    </div>
                  `
                : html`<p class="snes-muted">No streaming agent output is active.</p>`}
              <p class="snes-muted">
                Stream sync watches ${SNES_AGENT_STREAM_QUEUE_KEY}; last stream
                ${lastAgentStreamAt ?? "not yet"}.
              </p>
            </div>
            <p class="snes-muted">
              Previews hardware-safe JSON patches for OpenClaw and Codex style assistance. Approved
              changes save a local snapshot first.
            </p>
          `
        : nothing}
      ${selectedPanel === "scene" && scene
        ? html`
            <div class="snes-oam-report">
              ${(() => {
                const report = createSnesSpriteOamBudgetReport(project);
                return html`
                  <div class="snes-section-header">
                    <div>
                      <span class="snes-eyebrow">Sprite OAM</span>
                      <strong> ${report.usedEntries}/${report.limitEntries} entries </strong>
                      <p>
                        ${report.status === "ready"
                          ? `${report.remainingEntries} OAM entries remain for the active scene.`
                          : report.warnings.join(" ")}
                      </p>
                    </div>
                    <strong>${report.status.toUpperCase()}</strong>
                  </div>
                  <div class="snes-oam-report__rows">
                    ${report.entities.map(
                      (entity) => html`
                        <article class=${`snes-oam-row snes-oam-row--${entity.risk}`}>
                          <span>${entity.kind}</span>
                          <strong>${entity.name}</strong>
                          <small>${entity.oamEntries} OBJ entries</small>
                        </article>
                      `,
                    )}
                  </div>
                `;
              })()}
            </div>
            <label>
              Scene width
              <input
                type="number"
                min="16"
                max="512"
                value=${scene.widthMetatiles}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    const current = draft.scenes[selectedSceneIndex];
                    if (current) current.widthMetatiles = inputNumber(event);
                  })}
              />
            </label>
            <label>
              Background tiles
              <input
                type="number"
                min="0"
                max="2048"
                value=${project.assets.backgroundTiles}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.assets.backgroundTiles = inputNumber(event);
                  })}
              />
            </label>
            <label>
              Sprite tiles
              <input
                type="number"
                min="0"
                max="1024"
                value=${project.assets.spriteTiles}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.assets.spriteTiles = inputNumber(event);
                  })}
              />
            </label>
            <label>
              Audio bytes
              <input
                type="number"
                min="0"
                max="65536"
                value=${project.assets.audioBytes}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    setAudioByteBudget(draft, inputNumber(event));
                  })}
              />
            </label>
            <div class="snes-agent-proposal snes-player-physics">
              <strong>Player Physics</strong>
              <label>
                Move speed
                <input
                  type="number"
                  min="1"
                  max="8"
                  .value=${String(project.physics.moveSpeed)}
                  @input=${(event: Event) =>
                    updateProject(host, (draft) => {
                      draft.physics.moveSpeed = inputNumber(event);
                    })}
                />
              </label>
              <label>
                Jump velocity
                <input
                  type="number"
                  min="-32"
                  max="-1"
                  .value=${String(project.physics.jumpVelocity)}
                  @input=${(event: Event) =>
                    updateProject(host, (draft) => {
                      draft.physics.jumpVelocity = inputNumber(event);
                    })}
                />
              </label>
              <label>
                Gravity
                <input
                  type="number"
                  min="1"
                  max="8"
                  .value=${String(project.physics.gravityPerFrame)}
                  @input=${(event: Event) =>
                    updateProject(host, (draft) => {
                      draft.physics.gravityPerFrame = inputNumber(event);
                    })}
                />
              </label>
              <label>
                Max fall speed
                <input
                  type="number"
                  min="1"
                  max="16"
                  .value=${String(project.physics.maxFallSpeed)}
                  @input=${(event: Event) =>
                    updateProject(host, (draft) => {
                      draft.physics.maxFallSpeed = inputNumber(event);
                    })}
                />
              </label>
            </div>
            <div class="snes-agent-list">
              ${scene.entities.map(
                (entity, index) => html`
                  <article
                    class=${focusedGeneratedObjectId === `${scene.id}:${entity.id}` ? "active" : ""}
                  >
                    <span>${entity.kind}</span>
                    <label>
                      Name
                      <input
                        value=${entity.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.scenes[selectedSceneIndex]?.entities[index];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      X
                      <input
                        type="number"
                        min="0"
                        max="4096"
                        value=${entity.x}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.scenes[selectedSceneIndex]?.entities[index];
                            if (current) current.x = inputNumber(event);
                          })}
                      />
                    </label>
                    <label>
                      Y
                      <input
                        type="number"
                        min="0"
                        max="2048"
                        value=${entity.y}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.scenes[selectedSceneIndex]?.entities[index];
                            if (current) current.y = inputNumber(event);
                          })}
                      />
                    </label>
                    <label>
                      Metasprite tiles
                      <input
                        type="number"
                        min="1"
                        max="64"
                        value=${entity.metaspriteTiles}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.scenes[selectedSceneIndex]?.entities[index];
                            if (current) current.metaspriteTiles = inputNumber(event);
                          })}
                      />
                    </label>
                    <div class="snes-toolbar">
                      <button
                        type="button"
                        @click=${() => setEntityMetaspritePreset(host, index, 2)}
                      >
                        Small
                      </button>
                      <button
                        type="button"
                        @click=${() => setEntityMetaspritePreset(host, index, 4)}
                      >
                        16x16
                      </button>
                      <button
                        type="button"
                        @click=${() => setEntityMetaspritePreset(host, index, 16)}
                      >
                        Boss
                      </button>
                    </div>
                    ${entity.kind === "enemy"
                      ? (() => {
                          const behavior = entity.behavior ?? defaultEnemyBehaviorForEntity(entity);
                          return html`
                            <div class="snes-agent-proposal snes-enemy-behavior">
                              <strong>Enemy Behavior</strong>
                              <label>
                                Pattern
                                <select
                                  .value=${behavior.kind}
                                  @change=${(event: Event) =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.kind = inputValue(
                                        event,
                                      ) as SnesEnemyBehaviorKind;
                                    })}
                                >
                                  ${(["stationary", "patrol", "chase", "guard"] as const).map(
                                    (kind) => html`<option value=${kind}>${kind}</option>`,
                                  )}
                                </select>
                              </label>
                              <label>
                                Speed
                                <input
                                  type="number"
                                  min="0"
                                  max="8"
                                  .value=${String(behavior.speed)}
                                  @input=${(event: Event) =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.speed = inputNumber(event);
                                    })}
                                />
                              </label>
                              <label>
                                Patrol start X
                                <input
                                  type="number"
                                  min="0"
                                  max="4096"
                                  .value=${String(behavior.patrolStartX)}
                                  @input=${(event: Event) =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.patrolStartX = inputNumber(event);
                                    })}
                                />
                              </label>
                              <label>
                                Patrol end X
                                <input
                                  type="number"
                                  min="0"
                                  max="4096"
                                  .value=${String(behavior.patrolEndX)}
                                  @input=${(event: Event) =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.patrolEndX = inputNumber(event);
                                    })}
                                />
                              </label>
                              <label>
                                Aggro range
                                <input
                                  type="number"
                                  min="0"
                                  max="512"
                                  .value=${String(behavior.aggroRange)}
                                  @input=${(event: Event) =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.aggroRange = inputNumber(event);
                                    })}
                                />
                              </label>
                              <div class="snes-toolbar">
                                <button
                                  type="button"
                                  class=${behavior.guardDirection === -1 ? "active" : ""}
                                  @click=${() =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.guardDirection = -1;
                                    })}
                                >
                                  Face Left
                                </button>
                                <button
                                  type="button"
                                  class=${behavior.guardDirection === 1 ? "active" : ""}
                                  @click=${() =>
                                    updateEnemyBehavior(host, index, (draftBehavior) => {
                                      draftBehavior.guardDirection = 1;
                                    })}
                                >
                                  Face Right
                                </button>
                              </div>
                            </div>
                          `;
                        })()
                      : nothing}
                  </article>
                `,
              )}
            </div>
          `
        : nothing}
      ${selectedPanel === "assets"
        ? html`
            <label>
              Background tiles
              <input
                type="number"
                min="0"
                max="2048"
                value=${project.assets.backgroundTiles}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.assets.backgroundTiles = inputNumber(event);
                  })}
              />
            </label>
            <label>
              Sprite tiles
              <input
                type="number"
                min="0"
                max="1024"
                value=${project.assets.spriteTiles}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.assets.spriteTiles = inputNumber(event);
                  })}
              />
            </label>
            <label>
              Audio bytes
              <input
                type="number"
                min="0"
                max="65536"
                value=${project.assets.audioBytes}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    setAudioByteBudget(draft, inputNumber(event));
                  })}
              />
            </label>
            <div class="snes-inspector__grid">
              <span>SPC700 driver</span><strong>${audioManifest.driver}</strong> <span>Music</span
              ><strong>${formatBytes(audioManifest.musicBytes)}</strong> <span>SFX</span
              ><strong>${formatBytes(audioManifest.soundEffectBytes)}</strong> <span>Samples</span
              ><strong>${formatBytes(audioManifest.sampleBytes)}</strong>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Asset Pipeline Proof</strong>
                  <p>SNES 4bpp import, dedupe, palette, VRAM, and CGRAM safety checks.</p>
                </div>
                <strong>${assetPipeline.status}</strong>
              </div>
              <div class="snes-inspector__grid">
                <span>Imported tilesets</span
                ><strong>${assetPipeline.importedTilesetCount}</strong> <span>Unique tiles</span
                ><strong>${assetPipeline.uniqueTileCount}</strong> <span>Deduped tiles</span
                ><strong>${assetPipeline.dedupedTileCount}</strong> <span>Imported CHR</span
                ><strong>${formatBytes(assetPipeline.importedChrBytes)}</strong>
                <span>VRAM remaining</span
                ><strong>${formatBytes(assetPipeline.vramBytes.remaining)}</strong>
                <span>CGRAM remaining</span><strong>${assetPipeline.cgramColors.remaining}</strong>
              </div>
              <div class="snes-patch-list">
                ${assetPipeline.checks.map(
                  (check) => html`
                    <code>${check.code}</code>
                    <span>${check.label}</span>
                    <small>${check.status}: ${check.detail}</small>
                  `,
                )}
              </div>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>SPC700 Sound Test</strong>
                  <p>Preview the audio manifest and ARAM budget before a playback driver lands.</p>
                </div>
                <button type="button" @click=${() => runSpc700Preview(host)}>
                  Run Audio Preview
                </button>
              </div>
              <p class="snes-muted">
                ${audioPreviewSummary ||
                "Not run yet. Production BRR playback still needs a linked SPC700 driver."}
              </p>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Prompt Sprite Generator</strong>
                  <p>Create editable SNES 4bpp sprite tiles and a metasprite entity from text.</p>
                </div>
              </div>
              <label>
                Sprite prompt
                <textarea
                  rows="3"
                  .value=${spritePromptDraft}
                  @input=${(event: Event) => {
                    spritePromptDraft = inputValue(event);
                    host.requestUpdate?.();
                  }}
                ></textarea>
              </label>
              <div class="snes-toolbar">
                <button type="button" @click=${() => generatePromptSprite(host, "player")}>
                  Generate Player Sprite
                </button>
                <button type="button" @click=${() => generatePromptSprite(host, "enemy")}>
                  Generate Enemy Sprite
                </button>
                <button type="button" @click=${() => generatePromptSprite(host, "npc")}>
                  Generate NPC Sprite
                </button>
                <button type="button" @click=${() => generatePromptSprite(host, "item")}>
                  Generate Item Sprite
                </button>
              </div>
            </div>
            <div class="snes-section-header">
              <div>
                <strong>Music Tracker</strong>
                <p>Edit pattern metadata before the production SPC700 driver lands.</p>
              </div>
              <button type="button" @click=${() => addMusicTrack(host)}>Add Track</button>
            </div>
            <div class="snes-agent-list">
              ${project.assets.audio.musicTracks.map(
                (track, trackIndex) => html`
                  <article>
                    <label>
                      Track name
                      <input
                        .value=${track.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.musicTracks[trackIndex];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Tempo
                      <input
                        type="number"
                        min="40"
                        max="240"
                        .value=${String(track.tempo)}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.musicTracks[trackIndex];
                            if (current) current.tempo = inputNumber(event);
                          })}
                      />
                    </label>
                    <label>
                      Pattern rows
                      <input
                        type="number"
                        min="16"
                        max="256"
                        .value=${String(track.patternRows)}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.musicTracks[trackIndex];
                            if (current) current.patternRows = inputNumber(event);
                          })}
                      />
                    </label>
                    <label>
                      Estimated bytes
                      <input
                        type="number"
                        min="0"
                        max="65536"
                        .value=${String(track.estimatedBytes)}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.musicTracks[trackIndex];
                            if (current) current.estimatedBytes = inputNumber(event);
                          })}
                      />
                    </label>
                    <button
                      type="button"
                      class="danger"
                      @click=${() => removeMusicTrack(host, trackIndex)}
                    >
                      Remove Track
                    </button>
                  </article>
                `,
              )}
            </div>
            <div class="snes-section-header">
              <div>
                <strong>Sound Effects</strong>
                <p>Fast sequence sketching for menus, pickups, and enemy feedback.</p>
              </div>
              <button type="button" @click=${() => addSoundEffect(host)}>Add SFX</button>
            </div>
            <div class="snes-agent-list">
              ${project.assets.audio.soundEffects.map(
                (effect, effectIndex) => html`
                  <article>
                    <div class="snes-section-header">
                      <span>${effect.id}</span>
                      <button
                        type="button"
                        class="danger"
                        @click=${() => removeSoundEffect(host, effectIndex)}
                      >
                        Remove SFX
                      </button>
                    </div>
                    <label>
                      SFX name
                      <input
                        .value=${effect.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.soundEffects[effectIndex];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Priority
                      <input
                        type="number"
                        min="0"
                        max="15"
                        .value=${String(effect.priority)}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.assets.audio.soundEffects[effectIndex];
                            if (current) current.priority = inputNumber(event);
                          })}
                      />
                    </label>
                    <p class="snes-muted">
                      Estimated ${formatBytes(effect.estimatedBytes)}, ${effect.steps.length}
                      step${effect.steps.length === 1 ? "" : "s"}.
                    </p>
                    <div class="snes-patch-list">
                      ${effect.steps.map(
                        (step, stepIndex) => html`
                          <code>${stepIndex + 1}</code>
                          <label>
                            Instrument
                            <select
                              .value=${step.instrument}
                              @change=${(event: Event) =>
                                updateProject(host, (draft) => {
                                  const current =
                                    draft.assets.audio.soundEffects[effectIndex]?.steps[stepIndex];
                                  const value = inputValue(event);
                                  if (
                                    current &&
                                    (value === "pulse" || value === "noise" || value === "sample")
                                  ) {
                                    current.instrument = value;
                                    const effectDraft =
                                      draft.assets.audio.soundEffects[effectIndex];
                                    if (effectDraft) refreshSoundEffectEstimate(effectDraft);
                                  }
                                })}
                            >
                              ${audioInstrumentOptions.map(
                                (instrument) =>
                                  html`<option value=${instrument}>${instrument}</option>`,
                              )}
                            </select>
                          </label>
                          <label>
                            Note
                            <input
                              .value=${step.note}
                              @input=${(event: Event) =>
                                updateProject(host, (draft) => {
                                  const current =
                                    draft.assets.audio.soundEffects[effectIndex]?.steps[stepIndex];
                                  if (current) current.note = inputValue(event).slice(0, 8);
                                })}
                            />
                          </label>
                          <label>
                            Ticks
                            <input
                              type="number"
                              min="1"
                              max="255"
                              .value=${String(step.ticks)}
                              @input=${(event: Event) =>
                                updateProject(host, (draft) => {
                                  const current =
                                    draft.assets.audio.soundEffects[effectIndex]?.steps[stepIndex];
                                  if (current) {
                                    current.ticks = inputNumber(event);
                                    const effectDraft =
                                      draft.assets.audio.soundEffects[effectIndex];
                                    if (effectDraft) refreshSoundEffectEstimate(effectDraft);
                                  }
                                })}
                            />
                          </label>
                          <label>
                            Volume
                            <input
                              type="number"
                              min="0"
                              max="15"
                              .value=${String(step.volume)}
                              @input=${(event: Event) =>
                                updateProject(host, (draft) => {
                                  const current =
                                    draft.assets.audio.soundEffects[effectIndex]?.steps[stepIndex];
                                  if (current) current.volume = inputNumber(event);
                                })}
                            />
                          </label>
                          <button
                            type="button"
                            class="danger"
                            @click=${() => removeSoundEffectStep(host, effectIndex, stepIndex)}
                          >
                            Remove Step
                          </button>
                        `,
                      )}
                    </div>
                    <button type="button" @click=${() => addSoundEffectStep(host, effectIndex)}>
                      Add SFX Step
                    </button>
                  </article>
                `,
              )}
            </div>
            <label>
              Custom brush name
              <input
                .value=${customBrushName}
                @input=${(event: Event) => {
                  customBrushName = inputValue(event);
                }}
              />
            </label>
            <label>
              Custom brush tile
              <input
                type="number"
                min="0"
                max="255"
                .value=${String(customBrushTile)}
                @input=${(event: Event) => {
                  customBrushTile = inputNumber(event);
                }}
              />
            </label>
            <label class="snes-checkbox">
              <input
                type="checkbox"
                .checked=${customBrushSolid}
                @change=${(event: Event) => {
                  customBrushSolid = (event.currentTarget as HTMLInputElement).checked;
                }}
              />
              Solid collision brush
            </label>
            <button type="button" @click=${() => addCustomBrush(host)}>Add Custom Brush</button>
            <label>
              Tileset name
              <input
                .value=${assetImportName}
                @input=${(event: Event) => {
                  assetImportName = inputValue(event);
                }}
              />
            </label>
            <label>
              Import width
              <input
                type="number"
                min="8"
                max="128"
                step="8"
                .value=${String(assetImportWidth)}
                @input=${(event: Event) => {
                  assetImportWidth = inputNumber(event);
                }}
              />
            </label>
            <label>
              Import height
              <input
                type="number"
                min="8"
                max="128"
                step="8"
                .value=${String(assetImportHeight)}
                @input=${(event: Event) => {
                  assetImportHeight = inputNumber(event);
                }}
              />
            </label>
            <label>
              Indexed pixels
              <textarea
                rows="5"
                .value=${assetImportPixels}
                @input=${(event: Event) => {
                  assetImportPixels = inputValue(event);
                }}
              ></textarea>
            </label>
            <button type="button" @click=${() => importIndexedTileset(host)}>
              Import Indexed Tileset
            </button>
            <label class="snes-checkbox">
              <input
                type="checkbox"
                .checked=${assetImportQuantizePng}
                @change=${(event: Event) => {
                  assetImportQuantizePng = (event.currentTarget as HTMLInputElement).checked;
                  host.requestUpdate?.();
                }}
              />
              Auto-quantize high-color PNGs to one SNES 4bpp palette
            </label>
            <div
              class="snes-drop-zone"
              @dragover=${(event: DragEvent) => event.preventDefault()}
              @drop=${(event: DragEvent) => void dropPngTileset(host, event)}
            >
              <strong>Drop PNG Tileset</strong>
              <p>
                Import 8px-aligned PNG pixel art directly into deduplicated SNES 4bpp CHR data.
                Transparent pixels become palette index 0; high-color art can be reduced into a safe
                15-visible-color SNES palette before export.
              </p>
              <label>
                Import PNG Tileset
                <input
                  type="file"
                  accept=".png,image/png"
                  @change=${(event: Event) => void importPngTilesetInput(host, event)}
                />
              </label>
            </div>
            <div class="snes-section-header">
              <div>
                <strong>Sprite Animations</strong>
                <p>Edit every frame, tile reference, offset, loop mode, and entity binding.</p>
              </div>
              <button type="button" @click=${() => addSpriteAnimation(host)}>Add Animation</button>
            </div>
            <div class="snes-agent-list">
              ${project.animations.map(
                (animation, animationIndex) => html`
                  <article class="snes-animation-card">
                    <div class="snes-section-header">
                      <span>${animation.entityKind} animation</span>
                      <button
                        type="button"
                        class="danger"
                        @click=${() => removeSpriteAnimation(host, animationIndex)}
                      >
                        Remove Animation
                      </button>
                    </div>
                    <label>
                      Name
                      <input
                        .value=${animation.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.animations[animationIndex];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Entity kind
                      <select
                        .value=${animation.entityKind}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.animations[animationIndex];
                            const value = inputValue(event);
                            if (
                              current &&
                              (value === "player" || value === "enemy" || value === "npc")
                            ) {
                              current.entityKind = value;
                            }
                          })}
                      >
                        <option value="player">player</option>
                        <option value="enemy">enemy</option>
                        <option value="npc">npc</option>
                      </select>
                    </label>
                    <label class="snes-checkbox">
                      <input
                        type="checkbox"
                        .checked=${animation.loop}
                        @change=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.animations[animationIndex];
                            if (current) {
                              current.loop = (event.currentTarget as HTMLInputElement).checked;
                            }
                          })}
                      />
                      Loop animation
                    </label>
                    <div class="snes-animation-timeline">
                      ${animation.frames.map(
                        (frame, frameIndex) => html`
                          <section class="snes-animation-frame">
                            <div class="snes-animation-frame__preview">
                              <span>${frameIndex + 1}</span>
                              <strong>Tile ${frame.tileIndex}</strong>
                            </div>
                            <label>
                              Ticks
                              <input
                                type="number"
                                min="1"
                                max="255"
                                .value=${String(frame.durationTicks)}
                                @input=${(event: Event) =>
                                  updateProject(host, (draft) => {
                                    const current =
                                      draft.animations[animationIndex]?.frames[frameIndex];
                                    if (current) current.durationTicks = inputNumber(event);
                                  })}
                              />
                            </label>
                            <label>
                              Tile index
                              <input
                                type="number"
                                min="0"
                                max="1023"
                                .value=${String(frame.tileIndex)}
                                @input=${(event: Event) =>
                                  updateProject(host, (draft) => {
                                    const current =
                                      draft.animations[animationIndex]?.frames[frameIndex];
                                    if (current) current.tileIndex = inputNumber(event);
                                  })}
                              />
                            </label>
                            <label>
                              X offset
                              <input
                                type="number"
                                min="-128"
                                max="127"
                                .value=${String(frame.xOffset)}
                                @input=${(event: Event) =>
                                  updateProject(host, (draft) => {
                                    const current =
                                      draft.animations[animationIndex]?.frames[frameIndex];
                                    if (current) current.xOffset = inputNumber(event);
                                  })}
                              />
                            </label>
                            <label>
                              Y offset
                              <input
                                type="number"
                                min="-128"
                                max="127"
                                .value=${String(frame.yOffset)}
                                @input=${(event: Event) =>
                                  updateProject(host, (draft) => {
                                    const current =
                                      draft.animations[animationIndex]?.frames[frameIndex];
                                    if (current) current.yOffset = inputNumber(event);
                                  })}
                              />
                            </label>
                            <div class="snes-toolbar">
                              <button
                                type="button"
                                @click=${() =>
                                  moveAnimationFrame(host, animationIndex, frameIndex, -1)}
                              >
                                Move Left
                              </button>
                              <button
                                type="button"
                                @click=${() =>
                                  moveAnimationFrame(host, animationIndex, frameIndex, 1)}
                              >
                                Move Right
                              </button>
                              <button
                                type="button"
                                @click=${() =>
                                  duplicateAnimationFrame(host, animationIndex, frameIndex)}
                              >
                                Duplicate Frame
                              </button>
                              <button
                                type="button"
                                class="danger"
                                @click=${() =>
                                  removeAnimationFrame(host, animationIndex, frameIndex)}
                              >
                                Remove Frame
                              </button>
                            </div>
                          </section>
                        `,
                      )}
                    </div>
                    <button type="button" @click=${() => addAnimationFrame(host, animationIndex)}>
                      Add Frame
                    </button>
                    <p>
                      ${animation.frames.length} frames, ${animation.loop ? "looping" : "one-shot"}.
                    </p>
                  </article>
                `,
              )}
              ${project.assets.customTileBrushes.map(
                (brush) => html`
                  <article>
                    <span>custom brush</span>
                    <strong>${brush.name}</strong>
                    <p>Tile ${brush.tile}, ${brush.solid ? "solid" : "passable"} collision.</p>
                  </article>
                `,
              )}
              ${project.assets.importedTilesets.map(
                (tileset) => html`
                  <article>
                    <span>${tileset.id}</span>
                    <strong>${tileset.name}</strong>
                    <p>
                      ${tileset.uniqueTileCount}/${tileset.sourceTileCount} unique tiles,
                      ${formatBytes(tileset.chrSizeBytes)} CHR, checksum ${tileset.chrChecksum}
                    </p>
                    <p>
                      ${tileset.quantized
                        ? `Quantized from ${tileset.sourceColorCount} source colors.`
                        : `${tileset.sourceColorCount || tileset.paletteColorsUsed.length} source colors.`}
                      ${tileset.warnings.length > 0 ? tileset.warnings.join(" ") : ""}
                    </p>
                    ${tileset.palettePreviewHex.length > 0
                      ? html`
                          <div class="snes-palette-strip" aria-label=${`${tileset.name} palette`}>
                            ${tileset.palettePreviewHex.map(
                              (color) => html`<span style=${`background:${color}`}></span>`,
                            )}
                          </div>
                        `
                      : nothing}
                  </article>
                `,
              )}
            </div>
          `
        : nothing}
      ${selectedPanel === "story"
        ? html`
            <div class="snes-section-header">
              <div>
                <h3>Dialogue and Cutscenes</h3>
                <p>${project.dialogue.length} cutscenes, editable after AI generation.</p>
              </div>
              <button
                type="button"
                @click=${() =>
                  updateProject(host, (draft) => {
                    const index = draft.dialogue.length + 1;
                    draft.dialogue.push({
                      id: `cutscene-${index}`,
                      name: `Cutscene ${index}`,
                      trigger: "on-start",
                      lines: [
                        {
                          id: `cutscene-${index}-line-1`,
                          speaker: "Guide",
                          text: "A new scene begins.",
                        },
                      ],
                    });
                  })}
              >
                Add Cutscene
              </button>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Cutscene Timeline</strong>
                  <p>Preview dialogue timing, triggers, and event links before ROM text runtime.</p>
                </div>
                <button type="button" @click=${() => previewCutsceneTimeline(host)}>
                  Preview Timeline
                </button>
              </div>
              <div class="snes-inspector__grid">
                <span>Status</span><strong>${cutsceneTimeline.status}</strong> <span>Cutscenes</span
                ><strong>${cutsceneTimeline.cutsceneCount}</strong> <span>Lines</span
                ><strong>${cutsceneTimeline.lineCount}</strong> <span>Duration</span
                ><strong>${cutsceneTimeline.totalDurationTicks} ticks</strong>
              </div>
              <p class="snes-muted">
                ${cutscenePreviewSummary ||
                "Not run yet. ROM-side text box rendering still needs emulator proof."}
              </p>
              <div class="snes-patch-list">
                ${cutsceneTimeline.steps.map(
                  (step) => html`
                    <code>${step.cutsceneId}:${step.lineIndex + 1}</code>
                    <span>${step.speaker}: ${step.text}</span>
                    <small
                      >${step.trigger}, ${step.durationTicks} ticks,
                      ${step.linkedEventIds.length > 0
                        ? `events ${step.linkedEventIds.join(", ")}`
                        : "no event link"}</small
                    >
                  `,
                )}
                ${cutsceneTimeline.warnings.map(
                  (warning) => html`
                    <code>warning</code>
                    <span>${warning}</span>
                    <small>timeline</small>
                  `,
                )}
              </div>
            </div>
            <div class="snes-agent-list">
              ${project.dialogue.map(
                (cutscene, cutsceneIndex) => html`
                  <article>
                    <span>${cutscene.id}</span>
                    <label>
                      Name
                      <input
                        .value=${cutscene.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.dialogue[cutsceneIndex];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Trigger
                      <input
                        .value=${cutscene.trigger}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.dialogue[cutsceneIndex];
                            if (current) current.trigger = inputValue(event);
                          })}
                      />
                    </label>
                    ${cutscene.lines.map(
                      (line, lineIndex) => html`
                        <label>
                          Speaker
                          <input
                            .value=${line.speaker}
                            @input=${(event: Event) =>
                              updateProject(host, (draft) => {
                                const current = draft.dialogue[cutsceneIndex]?.lines[lineIndex];
                                if (current) current.speaker = inputValue(event);
                              })}
                          />
                        </label>
                        <label>
                          Line
                          <textarea
                            rows="3"
                            .value=${line.text}
                            @input=${(event: Event) =>
                              updateProject(host, (draft) => {
                                const current = draft.dialogue[cutsceneIndex]?.lines[lineIndex];
                                if (current) current.text = inputValue(event);
                              })}
                          ></textarea>
                        </label>
                      `,
                    )}
                    <button
                      type="button"
                      @click=${() =>
                        updateProject(host, (draft) => {
                          const current = draft.dialogue[cutsceneIndex];
                          if (!current) return;
                          const index = current.lines.length + 1;
                          current.lines.push({
                            id: `${current.id}-line-${index}`,
                            speaker: "Guide",
                            text: "New dialogue line.",
                          });
                        })}
                    >
                      Add Line
                    </button>
                  </article>
                `,
              )}
            </div>
          `
        : nothing}
      ${selectedPanel === "logic"
        ? html`
            <div class="snes-section-header">
              <div>
                <h3>Event Scripts</h3>
                <p>No-code triggers that connect items, enemies, flags, and cutscenes.</p>
              </div>
              <button
                type="button"
                @click=${() =>
                  updateProject(host, (draft) => {
                    const index = draft.events.length + 1;
                    draft.events.push({
                      id: `event-${index}`,
                      name: `Event ${index}`,
                      trigger: "on-start",
                      targetId: draft.scenes[0]?.id ?? "scene",
                      actions: [
                        { type: "show-dialogue", cutsceneId: draft.dialogue[0]?.id ?? "intro" },
                      ],
                    });
                  })}
              >
                Add Event
              </button>
            </div>
            <div class="snes-agent-list">
              ${project.events.map(
                (eventScript, eventIndex) => html`
                  <article>
                    <span>${eventScript.id}</span>
                    <label>
                      Name
                      <input
                        .value=${eventScript.name}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.events[eventIndex];
                            if (current) current.name = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Trigger
                      <select
                        .value=${eventScript.trigger}
                        @change=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.events[eventIndex];
                            const nextTrigger = inputValue(event);
                            if (
                              current &&
                              [
                                "on-start",
                                "on-enter-zone",
                                "on-collect-item",
                                "on-defeat-enemy",
                              ].includes(nextTrigger)
                            ) {
                              current.trigger = nextTrigger as typeof current.trigger;
                            }
                          })}
                      >
                        ${(
                          [
                            "on-start",
                            "on-enter-zone",
                            "on-collect-item",
                            "on-defeat-enemy",
                          ] as const
                        ).map((trigger) => html`<option value=${trigger}>${trigger}</option>`)}
                      </select>
                    </label>
                    <label>
                      Target ID
                      <input
                        .value=${eventScript.targetId}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.events[eventIndex];
                            if (current) current.targetId = inputValue(event);
                          })}
                      />
                    </label>
                    <div class="snes-patch-list">
                      ${eventScript.actions.map(
                        (action) => html`
                          <code>${action.type}</code>
                          <span>${formatEventAction(action)}</span>
                        `,
                      )}
                    </div>
                  </article>
                `,
              )}
            </div>
          `
        : nothing}
      ${selectedPanel === "export"
        ? html`
            <div class="snes-inspector__grid">
              <span>Target</span><strong>${manifest.target}</strong> <span>Card</span
              ><strong>${manifest.cardSizeGb} GB FAT32</strong> <span>ROM path</span
              ><strong>${manifest.romPath}</strong> <span>Save path</span
              ><strong>${manifest.savePath ?? "No SRAM file"}</strong> <span>Save bytes</span
              ><strong
                >${formatBytes(saveManifest.totalBytes)} /
                ${formatBytes(saveManifest.sramSizeKib * 1024)}</strong
              >
              <span>Slot size</span><strong>${formatBytes(saveManifest.slotSizeBytes)}</strong>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>SRAM Save Simulator</strong>
                  <p>Write, read, validate, and compare a local save slot before hardware proof.</p>
                </div>
                <button type="button" @click=${() => simulateSramSaveLoad(host)}>
                  Simulate Save Load
                </button>
              </div>
              <p class="snes-muted">
                ${sramSimulationSummary ||
                "Not run yet. Real FXPAK PRO SRAM still needs power-cycle proof."}
              </p>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>SRAM Serialization Proof</strong>
                  <p>Versioned header, slot layout, field offsets, and image validation.</p>
                </div>
                <strong>${sramSerialization.status}</strong>
              </div>
              <div class="snes-inspector__grid">
                <span>Header checksum</span><strong>${sramSerialization.headerChecksumHex}</strong>
                <span>Base address</span
                ><strong>${sramSerialization.sramBaseAddressHex ?? "disabled"}</strong>
                <span>Slots</span><strong>${sramSerialization.slotCount}</strong>
                <span>Slot size</span
                ><strong>${formatBytes(sramSerialization.slotSizeBytes)}</strong>
                <span>Total save bytes</span
                ><strong>${formatBytes(sramSerialization.totalSaveBytes)}</strong>
                <span>SRAM image</span
                ><strong>${formatBytes(sramSerialization.imageSizeBytes)}</strong>
              </div>
              <div class="snes-patch-list">
                ${sramSerialization.fields.map(
                  (field) => html`
                    <code>${field.key}</code>
                    <span>${field.label}</span>
                    <small
                      >offset ${field.offset}, ${formatBytes(field.sizeBytes)}, ${field.type}</small
                    >
                  `,
                )}
                ${sramSerialization.checks.map(
                  (check) => html`
                    <code>${check.code}</code>
                    <span>${check.passed ? "pass" : "blocked"}</span>
                    <small>${check.detail}</small>
                  `,
                )}
              </div>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Emulator Proof</strong>
                  <p>Configure supported emulators before boot/screenshot validation.</p>
                </div>
                <button type="button" @click=${() => downloadEmulatorProof(host)}>
                  Export Proof
                </button>
              </div>
              <label>
                Available emulators
                <input
                  placeholder="ares, bsnes, mesen, snes9x"
                  .value=${emulatorSelectionDraft}
                  @input=${(event: Event) => {
                    emulatorSelectionDraft = inputValue(event);
                    host.requestUpdate?.();
                  }}
                />
              </label>
              ${(() => {
                try {
                  const artifact = buildSnesPreviewRom(project);
                  const proof = createSnesEmulatorBootProof(artifact, selectedEmulators());
                  const screenshotProof = createSnesEmulatorScreenshotComparison(artifact, null);
                  const replayProof = createSnesEmulatorReplayParityProof(
                    artifact,
                    currentRuntimeProject(),
                    currentRuntimeReplay(),
                    selectedEmulators(),
                  );
                  return html`
                    <div class="snes-inspector__grid">
                      <span>Status</span><strong>${proof.status}</strong> <span>Emulator</span
                      ><strong>${proof.evidence.emulator ?? "not configured"}</strong>
                      <span>Screenshot</span><strong>${proof.evidence.screenshotFileName}</strong>
                      <span>Screenshot diff</span><strong>${screenshotProof.status}</strong>
                      <span>Replay parity</span><strong>${replayProof.status}</strong>
                      <span>Expected state</span
                      ><strong>${replayProof.evidence.browserFinalStateHash}</strong>
                    </div>
                    <p class="snes-muted">
                      ${replayProof.blockers[0] ??
                      screenshotProof.blockers[0] ??
                      "Emulator replay parity is verified."}
                    </p>
                  `;
                } catch (error) {
                  return html`<p class="snes-issue snes-issue--error">
                    ${error instanceof Error ? error.message : "Preview ROM cannot be built."}
                  </p>`;
                }
              })()}
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>FXPAK Card Scanner</strong>
                  <p>Record the mounted FAT32 card profile before export.</p>
                </div>
                <button type="button" @click=${() => verifyFxpakCopyDryRun(host)}>
                  Verify Copy Dry Run
                </button>
              </div>
              <label class="snes-checkbox">
                <input
                  type="checkbox"
                  .checked=${fxpakProbe.mounted}
                  @change=${(event: Event) => {
                    fxpakProbe = {
                      ...fxpakProbe,
                      mounted: (event.currentTarget as HTMLInputElement).checked,
                    };
                    host.requestUpdate?.();
                  }}
                />
                FXPAK PRO card is mounted
              </label>
              <label>
                Volume path
                <input
                  .value=${fxpakProbe.volumePath}
                  @input=${(event: Event) => {
                    fxpakProbe = { ...fxpakProbe, volumePath: inputValue(event) };
                    host.requestUpdate?.();
                  }}
                />
              </label>
              <label>
                Free bytes
                <input
                  type="number"
                  min="0"
                  .value=${String(fxpakProbe.freeBytes)}
                  @input=${(event: Event) => {
                    fxpakProbe = { ...fxpakProbe, freeBytes: inputNumber(event) };
                    host.requestUpdate?.();
                  }}
                />
              </label>
              ${(() => {
                try {
                  const artifact = buildSnesPreviewRom(project);
                  const fxpakPackage = createSnesFxpakExportPackage(artifact);
                  const mounted = createSnesFxpakMountedExportValidation(fxpakPackage, fxpakProbe);
                  const volumeSelection = selectSnesFxpakMountedVolume(fxpakPackage, [fxpakProbe]);
                  const dryRun = createSnesFxpakCopyDryRun(fxpakPackage, fxpakProbe);
                  return html`
                    <div class="snes-inspector__grid">
                      <span>Status</span><strong>${mounted.status}</strong> <span>ROM copy</span
                      ><strong>${mounted.destinationRomPath}</strong> <span>SRAM copy</span
                      ><strong>${mounted.destinationSavePath ?? "none"}</strong>
                      <span>Volume scan</span><strong>${volumeSelection.status}</strong>
                      <span>Dry run</span><strong>${dryRun.status}</strong>
                    </div>
                    <div class="snes-patch-list">
                      ${dryRun.operations.map(
                        (operation) => html`
                          <code>${operation.action}</code>
                          <span>${operation.destinationPath}</span>
                          <small
                            >${formatBytes(operation.sizeBytes)} from ${operation.sourceName}</small
                          >
                        `,
                      )}
                    </div>
                  `;
                } catch (error) {
                  return html`<p class="snes-issue snes-issue--error">
                    ${error instanceof Error ? error.message : "FXPAK validation failed."}
                  </p>`;
                }
              })()}
              <button type="button" @click=${() => downloadHardwareQaBundle(host)}>
                Export Hardware QA Bundle
              </button>
            </div>
            <div class="snes-agent-proposal">
              <div class="snes-section-header">
                <div>
                  <strong>Runtime Completion Gates</strong>
                  <p>
                    Tracks the pieces that still need real emulator, FXPAK, or SNES runtime proof.
                  </p>
                </div>
              </div>
              <div class="snes-patch-list">
                <code>emulator</code>
                <span>Install a supported emulator, run boot, and capture screenshot bytes.</span>
                <small>${selectedEmulators().length > 0 ? "ready-to-run" : "blocked"}</small>
                <code>fxpak</code>
                <span>Mount the 128 GB FAT32 FXPAK PRO card and hash copied ROM bytes.</span>
                <small>${fxpakProbe.mounted ? "ready-to-copy" : "blocked"}</small>
                <code>sram</code>
                <span>Power-cycle hardware and compare pre/post .srm slot values.</span>
                <small>${project.save.enabled ? "wizard-ready" : "blocked"}</small>
                <code>dialogue-runtime</code>
                <span>Link font, text box, and event-trigger renderer into the ROM.</span>
                <small>blocked</small>
                <code>spc700-runtime</code>
                <span>Link production SPC700 driver and play generated tracker metadata.</span>
                <small>blocked</small>
                <code>superfx</code>
                <span>${superFxReport.blockers[0] ?? "SuperFX runtime is not enabled."}</span>
                <small>${superFxReport.status}</small>
              </div>
            </div>
            <label class="snes-checkbox">
              <input
                type="checkbox"
                .checked=${project.save.enabled}
                @change=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.save.enabled = (event.currentTarget as HTMLInputElement).checked;
                  })}
              />
              Enable SRAM save file
            </label>
            <label>
              Save slots
              <input
                type="number"
                min="1"
                max="16"
                value=${project.save.slots}
                @input=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.save.slots = inputNumber(event);
                  })}
              />
            </label>
            <div class="snes-agent-list">
              ${project.save.fields.map(
                (field, index) => html`
                  <article>
                    <label>
                      Key
                      <input
                        value=${field.key}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.save.fields[index];
                            if (current) current.key = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Label
                      <input
                        value=${field.label}
                        @input=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.save.fields[index];
                            if (current) current.label = inputValue(event);
                          })}
                      />
                    </label>
                    <label>
                      Type
                      <select
                        .value=${field.type}
                        @change=${(event: Event) =>
                          updateProject(host, (draft) => {
                            const current = draft.save.fields[index];
                            const nextType = inputValue(event);
                            if (current && ["flag", "u8", "u16", "u32"].includes(nextType)) {
                              current.type = nextType as typeof current.type;
                            }
                          })}
                      >
                        ${(["flag", "u8", "u16", "u32"] as const).map(
                          (type) => html`<option value=${type}>${type}</option>`,
                        )}
                      </select>
                    </label>
                    <button type="button" @click=${() => removeSaveField(host, index)}>
                      Remove
                    </button>
                  </article>
                `,
              )}
            </div>
            <button type="button" @click=${() => addSaveField(host)}>Add Save Field</button>
            <label class="snes-checkbox">
              <input
                type="checkbox"
                .checked=${project.profile.fxpak.preserveExistingSaves}
                @change=${(event: Event) =>
                  updateProject(host, (draft) => {
                    draft.profile.fxpak.preserveExistingSaves = (
                      event.currentTarget as HTMLInputElement
                    ).checked;
                  })}
              />
              Preserve existing FXPAK saves
            </label>
          `
        : nothing}
      ${selectedPanel === "agents"
        ? html`
            <div class="snes-agent-list">
              ${agentTasks.map(
                (task) => html`
                  <article>
                    <span>${task.role}</span>
                    <strong>${task.title}</strong>
                    <p>${task.prompt}</p>
                  </article>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="snes-issues">
        <h4>Build Readiness: ${readiness.status.toUpperCase()} ${readiness.score}/100</h4>
        ${readiness.issues.length === 0
          ? html`<p class="snes-ok">No blockers. Ready for deterministic build tooling.</p>`
          : readiness.issues.map(
              (issue) => html`
                <p class="snes-issue snes-issue--${issue.severity}">
                  <strong>${issue.code}</strong>
                  <span>${issue.message}</span>
                  <small>${issue.suggestion}</small>
                  <button type="button" @click=${() => fixReadinessIssue(host, issue.code)}>
                    Fix This with AI
                  </button>
                </p>
              `,
            )}
        <div class="snes-toolbar">
          <button type="button" @click=${() => repairPlayablePreview(host)}>Fix Build</button>
          <button type="button" @click=${() => downloadPreviewRom(host)}>Build Preview ROM</button>
        </div>
      </div>
    </aside>
  `;
}

function renderBeginnerWizard(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  return html`
    <div class="snes-kid-wizard" aria-label="Kid Builder">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Kid Builder</span>
          <strong>Describe, send, edit, play</strong>
          <p>Three obvious steps for making a working SNES game without knowing SNES terms.</p>
        </div>
        <strong>${readiness.status.toUpperCase()} ${readiness.score}/100</strong>
      </div>
      <div class="snes-kid-wizard__steps">
        <article>
          <span>1</span>
          <strong>Pick a game idea</strong>
          <p>Use a starter idea or type your own.</p>
          <div class="snes-prompt-chips">
            ${beginnerPromptChips.map(
              (chip) => html`
                <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
                  ${chip.label}
                </button>
              `,
            )}
          </div>
        </article>
        <article>
          <span>2</span>
          <strong>Send it to AI</strong>
          <p>OpenClaw or Codex creates a safe editable draft.</p>
          <button
            type="button"
            class="primary snes-send-command"
            @click=${() => createGameFromPrompt(host)}
          >
            Create Game
          </button>
        </article>
        <article>
          <span>3</span>
          <strong>Make it playable</strong>
          <p>Repair missing parts, build a SNES game file, then edit anything.</p>
          <div class="snes-toolbar">
            <button type="button" class="primary" @click=${() => finishPlayableDraft(host)}>
              Export My Game
            </button>
            <button type="button" @click=${() => repairPlayablePreview(host)}>Fix Build</button>
            <button type="button" @click=${() => createAndBuildPreviewRom(host)}>
              Create + Build Game File
            </button>
          </div>
        </article>
      </div>
    </div>
  `;
}

function renderLegacyGamePartsMap(host: HostUpdate) {
  return html`
    <div class="snes-game-parts-map">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">All Things Map</span>
          <strong>Everything you can create and edit</strong>
          <p>Each part has a prompt button and an edit button.</p>
        </div>
      </div>
      <div class="snes-game-parts-map__grid">
        ${gamePartMap.map(
          (part) => html`
            <article>
              <strong>${part.label}</strong>
              <span>${part.detail(project)}</span>
              <div class="snes-toolbar">
                <button
                  type="button"
                  @click=${() =>
                    part.surface === "full-game"
                      ? createGameFromPrompt(host)
                      : createEditableSurfaceFromPrompt(host, part.surface)}
                >
                  ${part.surface === "full-game" ? "Prompt" : "Create & Edit"}
                </button>
                <button type="button" @click=${() => selectPanel(host, part.panel)}>Edit</button>
              </div>
            </article>
          `,
        )}
      </div>
    </div>
  `;
}

function createTargetOptions(): Array<{ id: SnesCreateTarget; label: string; detail: string }> {
  return [
    { id: "full-game", label: "Whole Game", detail: "Create a complete playable draft." },
    { id: "level", label: "This Level", detail: "Paint and tune the selected scene." },
    { id: "selected-object", label: "Clicked Thing", detail: "Change what you clicked." },
    { id: "player", label: "Hero", detail: "Change the main character." },
    { id: "enemies", label: "Enemies", detail: "Create or tune enemy behavior." },
    { id: "items", label: "Items", detail: "Create collectibles and rewards." },
    {
      id: "background-music",
      label: "Music",
      detail: "Create or change the level music.",
    },
    {
      id: "beats-drums",
      label: "Beats / Drums",
      detail: "Create rhythm, pulse, and drum-like SNES patterns.",
    },
    {
      id: "melody-vocal",
      label: "Lead Melody",
      detail: "Create singable lead, chant, or sample-style ideas within SNES limits.",
    },
    {
      id: "sound-fx",
      label: "Sound Effects",
      detail: "Create jump, pickup, hit, door, or boss sounds.",
    },
    { id: "dialogue", label: "Story Text", detail: "Write story and NPC text." },
    {
      id: "game-logic",
      label: "Rules & Goals",
      detail: "Create triggers, goals, and simple events.",
    },
    { id: "save", label: "Save Points", detail: "Set progress saves." },
    { id: "build-fix", label: "Fix & Play", detail: "Ask AI to make the project playable." },
  ];
}

function createTargetShortcuts(): Array<{ id: SnesCreateTarget; label: string; detail: string }> {
  return [
    { id: "full-game", label: "Whole Game", detail: "Start with a playable draft." },
    { id: "level", label: "This Level", detail: "Change the level on the canvas." },
    { id: "selected-object", label: "Clicked Thing", detail: "Change only what you selected." },
    { id: "player", label: "Hero", detail: "Change the main character." },
    { id: "enemies", label: "Enemy", detail: "Add or tune enemies." },
    { id: "items", label: "Item", detail: "Add rewards and pickups." },
    { id: "dialogue", label: "Story", detail: "Write guides, signs, and scenes." },
    { id: "background-music", label: "Music", detail: "Make the level sound right." },
    { id: "build-fix", label: "Fix & Play", detail: "Repair anything blocking testing." },
  ];
}

function renderPromptTargetShortcuts(host: HostUpdate) {
  return html`
    <div class="snes-prompt-target-shortcuts" aria-label="Quick AI targets">
      <span>Pick what AI changes</span>
      <div>
        ${createTargetShortcuts().map(
          (shortcut) => html`
            <button
              type="button"
              class=${selectedCreateTarget === shortcut.id ? "active" : ""}
              title=${shortcut.detail}
              aria-pressed=${selectedCreateTarget === shortcut.id ? "true" : "false"}
              @click=${() => setCreateTarget(host, shortcut.id)}
            >
              ${shortcut.label}
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function promptTargetSummaryText() {
  if (selectedCreateTarget === "selected-object") {
    const object = focusedEditableObjectCard();
    return object ? `AI changes: ${object.label}` : "AI changes: Clicked thing";
  }
  return `AI changes: ${targetLabel(selectedCreateTarget)}`;
}

function surfaceForCreateTarget(target: SnesCreateTarget): SnesAiAuthoringSurface {
  if (
    target === "background-music" ||
    target === "beats-drums" ||
    target === "melody-vocal" ||
    target === "sound-fx"
  ) {
    return "audio";
  }
  if (target === "game-logic") {
    return "dialogue";
  }
  if (target === "build-fix") {
    return "export";
  }
  if (target !== "selected-object") {
    return target;
  }
  const object = focusedEditableObjectCard();
  if (!object) {
    return "level";
  }
  if (object.kind === "game") return "full-game";
  if (object.kind === "level") return "level";
  if (object.kind === "audio") return "audio";
  if (object.kind === "dialogue") return "dialogue";
  if (object.kind === "save") return "save";
  if (object.kind === "export") return "export";
  if (object.kind === "entity" && object.label.toLowerCase().includes("player")) return "player";
  if (object.kind === "entity") return "enemies";
  return "level";
}

function targetLabel(target: SnesCreateTarget) {
  return createTargetOptions().find((item) => item.id === target)?.label ?? target;
}

function promptPlaceholderForTarget(target: SnesCreateTarget) {
  const projectName = project.name || "this game";
  if (target === "background-music") {
    return `Create background music for ${projectName}: describe mood, tempo, loop feel, and where it plays.`;
  }
  if (target === "beats-drums") {
    return "Create a SNES-safe beat or drum pattern with pulse/noise rhythm, tempo, and intensity.";
  }
  if (target === "melody-vocal") {
    return "Create a vocal-like lead: a singable melody, chant, or sample-style hook within SNES limits.";
  }
  if (target === "sound-fx") {
    return "Create sound FX for jump, pickup, hit, door, and boss actions with clear priorities.";
  }
  if (target === "game-logic") {
    return "Create simple game logic: triggers, goals, NPC hints, doors, and win conditions.";
  }
  if (target === "build-fix") {
    return "Fix anything that blocks this game from being playable, then explain the change plainly.";
  }
  if (target === "selected-object") {
    const focused = focusedEditableObjectCard();
    return focused
      ? `Change ${focused.label}: make it clearer, more fun, and easier to test.`
      : "Click anything in the game, then describe how it should change.";
  }
  return (
    createSnesAiAuthoringPrompts(project).find((entry) => entry.surface === target)?.placeholder ??
    "Describe what to create or change."
  );
}

function targetSurfaceDefaults() {
  const catalogDefaults = createSnesAiAuthoringPrompts(project).map((entry) => entry.placeholder);
  return new Set([
    ...catalogDefaults,
    ...createTargetOptions().map((option) => promptPlaceholderForTarget(option.id)),
  ]);
}

function createFromPromptTarget(host: HostUpdate, target: SnesCreateTarget) {
  if (target === "build-fix") {
    repairPlayablePreview(host);
    selectedMode = "edit";
    selectedPanel = "scene";
    return;
  }
  const surface = surfaceForCreateTarget(target);
  if (surface === "full-game") {
    createGameFromPrompt(host);
    return;
  }
  createEditableSurfaceFromPrompt(host, surface);
}

function createFromUniversalPrompt(host: HostUpdate) {
  createFromPromptTarget(host, selectedCreateTarget);
}

function openBuildForAiFeedback(host: HostUpdate) {
  selectedMode = "edit";
  selectedPanel = "scene";
  if (selectedCreateTarget === "full-game") {
    selectedCreateTarget = "level";
  }
  pushConsole(host, "Opened the canvas so you can change the AI result.");
  host.requestUpdate?.();
}

function openReviewForAiFeedback(host: HostUpdate) {
  selectedMode = "make";
  selectedPanel = "prompt";
  pushConsole(host, "Opened the AI preview for review.");
  host.requestUpdate?.();
}

function useInstantDraftInstead(host: HostUpdate) {
  const surface = surfaceForCreateTarget(selectedCreateTarget);
  agentDispatchQueue = agentDispatchQueue.filter((record) => record.surface !== surface);
  saveAgentDispatchQueue();
  pushConsole(host, "Used the built-in instant draft path so you can keep building now.");
  createFromUniversalPrompt(host);
}

function renderAiActionFeedback(host: HostUpdate, mini = false) {
  if (!lastAiActionFeedback) {
    return nothing;
  }
  const feedback = lastAiActionFeedback;
  const providerLabel = feedback.provider === "openclaw" ? "OpenClaw Agent" : "Codex";
  if (mini && feedback.status === "ready") {
    return html`
      <div
        class="snes-ai-action-feedback snes-ai-action-feedback--mini ready"
        role="status"
        aria-live="polite"
      >
        <strong>${feedback.title}</strong>
        <div class="snes-ai-action-feedback__actions">
          <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
            Test it
          </button>
          <button type="button" @click=${() => openBuildForAiFeedback(host)}>Change it</button>
          <button type="button" @click=${() => clearAiActionFeedback(host)}>Keep it</button>
        </div>
      </div>
    `;
  }
  return html`
    <div
      class=${`snes-ai-action-feedback ${feedback.status}`}
      role=${feedback.status === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      <div>
        <span>${providerLabel} -> ${feedback.target}</span>
        <strong>${feedback.title}</strong>
        <p>${feedback.detail}</p>
      </div>
      <div class="snes-ai-action-feedback__actions">
        ${feedback.status === "working"
          ? html`
              <span class="snes-ai-action-feedback__pulse">Working</span>
              <button type="button" class="primary" @click=${() => useInstantDraftInstead(host)}>
                Use Instant Draft
              </button>
              <button
                type="button"
                @click=${() => {
                  selectedPanel = "prompt";
                  host.requestUpdate?.();
                }}
              >
                AI Details
              </button>
            `
          : feedback.status === "error"
            ? html`
                <button type="button" class="primary" @click=${() => useInstantDraftInstead(host)}>
                  Use Instant Draft
                </button>
                <button
                  type="button"
                  @click=${() => {
                    selectedMode = "make";
                    selectedPanel = "prompt";
                    host.requestUpdate?.();
                  }}
                >
                  Change prompt
                </button>
                <button type="button" @click=${() => clearAiActionFeedback(host)}>Dismiss</button>
              `
            : html`
                ${feedback.status === "review" && pendingAgentProposal
                  ? html`
                      <button
                        type="button"
                        class="primary"
                        @click=${() => openReviewForAiFeedback(host)}
                      >
                        Review it
                      </button>
                    `
                  : html`
                      <button
                        type="button"
                        class="primary"
                        @click=${() => startPreviewPlaytest(host)}
                      >
                        Test it
                      </button>
                    `}
                <button type="button" @click=${() => openBuildForAiFeedback(host)}>
                  Change it
                </button>
                <button type="button" @click=${() => clearAiActionFeedback(host)}>Keep it</button>
              `}
      </div>
    </div>
  `;
}

function firstMinuteGuideIsReady() {
  return lastAppliedFullGamePrompt.trim().length > 0;
}

function openFirstMinuteBuild(host: HostUpdate) {
  selectedMode = "edit";
  selectedPanel = "scene";
  pushConsole(host, "Opened Build. Drag a piece, draw ground, or ask AI for one clear change.");
  host.requestUpdate?.();
}

function primeFirstMinuteAiChange(host: HostUpdate) {
  selectedMode = "edit";
  selectedPanel = "scene";
  selectedCreateTarget = "level";
  updateAiPrompt(
    "level",
    "Make this first level easier to understand: add one reward, one safe challenge, and a clear path to the goal.",
  );
  pushConsole(host, "Ready: the next AI prompt changes this level, not the whole game.");
  host.requestUpdate?.();
}

function renderFirstMinuteGuide(host: HostUpdate, placement: "build" | "play") {
  if (!firstMinuteGuideIsReady()) {
    return nothing;
  }
  const guideTitle = placement === "play" ? "You made a game. Try it now." : "Shape the game next.";
  const guideDetail =
    placement === "play"
      ? "If the scene is moving, the prompt worked. Use the buttons below for the next obvious step."
      : "Click the level, move one thing, or ask AI for one small change before testing again.";
  return html`
    <section
      class=${`snes-first-minute-guide snes-first-minute-guide--${placement}`}
      aria-label="First 60 seconds after creating a game"
    >
      <div class="snes-first-minute-guide__copy">
        <span class="snes-eyebrow">First 60 Seconds</span>
        <strong>${guideTitle}</strong>
        <p>${guideDetail}</p>
      </div>
      <div class="snes-first-minute-guide__steps" aria-label="Recommended next steps">
        <article>
          <span>1</span>
          <strong>Play it</strong>
          <small>See the hero move and watch what changed.</small>
        </article>
        <article>
          <span>2</span>
          <strong>Move one thing</strong>
          <small>Drag a reward, enemy, door, or goal on the level.</small>
        </article>
        <article>
          <span>3</span>
          <strong>Ask one change</strong>
          <small>Tell AI exactly what should feel better.</small>
        </article>
      </div>
      <div class="snes-first-minute-guide__actions">
        <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
          Play Game
        </button>
        <button type="button" @click=${() => openFirstMinuteBuild(host)}>Build Level</button>
        <button type="button" @click=${() => primeFirstMinuteAiChange(host)}>
          Change One Thing
        </button>
        <button type="button" @click=${() => selectStudioMode(host, "ship")}>Export Later</button>
      </div>
    </section>
  `;
}

function setCreateTarget(host: HostUpdate, target: SnesCreateTarget) {
  selectedCreateTarget = target;
  const surface = surfaceForCreateTarget(target);
  selectedPanel = surface === "full-game" ? "prompt" : panelForSurface(surface);
  const current = aiPromptDrafts[surface];
  if (!current || targetSurfaceDefaults().has(current)) {
    updateAiPrompt(surface, promptPlaceholderForTarget(target));
  }
  pushConsole(host, `Create target set to ${targetLabel(target)}.`);
}

function selectStudioMode(host: HostUpdate, mode: SnesStudioMode) {
  if (mode === "play") {
    startPreviewPlaytest(host, true, true);
    return;
  }
  selectedMode = mode;
  if (mode === "make") {
    selectedPanel = "project";
    if (selectedCreateTarget === "selected-object" && !focusedEditableObjectCard()) {
      selectedCreateTarget = "full-game";
    }
  }
  if (mode === "edit") selectedPanel = "scene";
  if (mode === "ship") selectedPanel = "export";
  host.requestUpdate?.();
}

function focusGeneratedObject(host: HostUpdate, object: SnesEditableObjectCard) {
  focusedGeneratedObjectId = object.id;
  selectedCreateTarget = "selected-object";
  if (object.kind === "level") {
    const levelIndex = Number(object.id.replace("level:", ""));
    if (Number.isInteger(levelIndex) && project.scenes[levelIndex]) {
      selectedSceneIndex = levelIndex;
    }
  }
  selectedPanel = object.editPanel;
  selectedMode = object.editPanel === "export" ? "ship" : "edit";
  pushConsole(host, `Focused ${object.label}.`);
}

function promptChangeGeneratedObject(host: HostUpdate, object: SnesEditableObjectCard) {
  focusedGeneratedObjectId = object.id;
  selectedCreateTarget =
    object.kind === "game" ? "full-game" : object.kind === "level" ? "level" : "selected-object";
  selectedMode = object.kind === "game" ? "make" : object.editPanel === "export" ? "ship" : "edit";
  selectedPanel = object.editPanel;
  const surface =
    object.kind === "game"
      ? "full-game"
      : object.kind === "level"
        ? "level"
        : surfaceForCreateTarget("selected-object");
  updateAiPrompt(surface, `Change ${object.label}: make it clearer, more fun, and easier to test.`);
  pushConsole(host, `Ready for a prompt change to ${object.label}.`);
}

function selectedObjectPromptTarget(object: SnesEditableObjectCard): SnesCreateTarget {
  if (object.kind === "game") return "full-game";
  if (object.kind === "level") return "level";
  return "selected-object";
}

function selectedObjectPromptSurface(object: SnesEditableObjectCard): SnesAiAuthoringSurface {
  if (object.kind === "game") return "full-game";
  if (object.kind === "level") return "level";
  return surfaceForCreateTarget("selected-object");
}

function primeSelectedObjectPrompt(object: SnesEditableObjectCard) {
  focusedGeneratedObjectId = object.id;
  selectedCreateTarget = selectedObjectPromptTarget(object);
}

function createSelectedObjectChange(host: HostUpdate, object: SnesEditableObjectCard) {
  primeSelectedObjectPrompt(object);
  const surface = selectedObjectPromptSurface(object);
  if (surface === "full-game") {
    createGameFromPrompt(host);
    return;
  }
  createEditableSurfaceFromPrompt(host, surface);
}

function previewSelectedObjectChange(host: HostUpdate, object: SnesEditableObjectCard) {
  primeSelectedObjectPrompt(object);
  previewAgentPatchForSurface(host, selectedObjectPromptSurface(object), selectedCreateTarget);
}

function duplicateGeneratedObject(host: HostUpdate, object: SnesEditableObjectCard) {
  if (object.kind === "game") {
    snapshotProject(host);
    pushConsole(host, "Duplicated the current game as a recovery snapshot.");
    return;
  }
  if (object.kind === "level") {
    const levelIndex = Number(object.id.replace("level:", ""));
    try {
      rememberUndo();
      project = duplicateSnesProjectScene(project, levelIndex);
      selectedSceneIndex = project.scenes.length - 1;
      saveProject();
      selectedMode = "edit";
      selectedPanel = "scene";
      pushConsole(host, `Duplicated ${object.label}.`);
    } catch (error) {
      pushConsole(host, error instanceof Error ? error.message : "Level duplication failed.");
    }
    return;
  }
  updateProject(host, (draft) => {
    if (object.kind === "entity") {
      const [sceneId, entityId] = object.id.split(":");
      const scene = draft.scenes.find((candidate) => candidate.id === sceneId);
      const entity = scene?.entities.find((candidate) => candidate.id === entityId);
      if (scene && entity) {
        scene.entities.push({
          ...entity,
          id: `${entity.id}-copy-${scene.entities.length + 1}`,
          name: `${entity.name} Copy`,
          x: entity.x + 16,
        });
      }
    } else if (object.kind === "dialogue") {
      const cutscene = draft.dialogue.find((candidate) => candidate.id === object.id);
      if (cutscene) {
        draft.dialogue.push({
          ...cutscene,
          id: `${cutscene.id}-copy-${draft.dialogue.length + 1}`,
          name: `${cutscene.name} Copy`,
        });
      }
    } else if (object.kind === "event") {
      const event = draft.events.find((candidate) => candidate.id === object.id);
      if (event) {
        draft.events.push({
          ...event,
          id: `${event.id}-copy-${draft.events.length + 1}`,
          name: `${event.name} Copy`,
        });
      }
    } else if (object.kind === "audio") {
      const track = draft.assets.audio.musicTracks.find((candidate) => candidate.id === object.id);
      const effect = draft.assets.audio.soundEffects.find(
        (candidate) => candidate.id === object.id,
      );
      if (track) {
        draft.assets.audio.musicTracks.push({
          ...track,
          id: `${track.id}-copy-${draft.assets.audio.musicTracks.length + 1}`,
          name: `${track.name} Copy`,
        });
      } else if (effect) {
        draft.assets.audio.soundEffects.push({
          ...effect,
          id: `${effect.id}-copy-${draft.assets.audio.soundEffects.length + 1}`,
          name: `${effect.name} Copy`,
        });
      }
    }
  });
  pushConsole(host, `Duplicated ${object.label}.`);
}

function deleteGeneratedObject(host: HostUpdate, object: SnesEditableObjectCard) {
  if (object.kind === "game") {
    startBlankProject(host);
    pushConsole(host, "Cleared the current game into a blank project.");
    return;
  }
  if (object.kind === "level") {
    const levelIndex = Number(object.id.replace("level:", ""));
    try {
      rememberUndo();
      const removed = project.scenes[levelIndex]?.name ?? object.label;
      project = removeSnesProjectScene(project, levelIndex);
      selectedSceneIndex = Math.min(selectedSceneIndex, project.scenes.length - 1);
      saveProject();
      pushConsole(host, `Removed ${removed}.`);
    } catch (error) {
      pushConsole(host, error instanceof Error ? error.message : "Level removal failed.");
    }
    return;
  }
  updateProject(host, (draft) => {
    if (object.kind === "entity") {
      const [sceneId, entityId] = object.id.split(":");
      const scene = draft.scenes.find((candidate) => candidate.id === sceneId);
      if (scene) {
        scene.entities = scene.entities.filter((entity) => entity.id !== entityId);
      }
    } else if (object.kind === "dialogue") {
      draft.dialogue = draft.dialogue.filter((cutscene) => cutscene.id !== object.id);
    } else if (object.kind === "event") {
      draft.events = draft.events.filter((event) => event.id !== object.id);
    } else if (object.kind === "audio") {
      draft.assets.audio.musicTracks = draft.assets.audio.musicTracks.filter(
        (track) => track.id !== object.id,
      );
      draft.assets.audio.soundEffects = draft.assets.audio.soundEffects.filter(
        (effect) => effect.id !== object.id,
      );
    } else if (object.kind === "save") {
      draft.save.enabled = false;
    }
  });
  if (focusedGeneratedObjectId === object.id) {
    focusedGeneratedObjectId = null;
  }
  pushConsole(host, `Removed ${object.label}.`);
}

function testGeneratedObject(host: HostUpdate, object: SnesEditableObjectCard) {
  focusGeneratedObject(host, object);
  if (object.editPanel === "export") {
    selectedMode = "ship";
    pushConsole(host, `Opened Ship checks for ${object.label}.`);
    host.requestUpdate?.();
    return;
  }
  startPreviewPlaytest(host);
}

function objectCardDisplayKind(object: SnesEditableObjectCard): string {
  if (object.kind !== "entity") {
    return object.kind;
  }
  const lower = object.label.toLowerCase();
  if (lower.includes("player") || lower.includes("hero")) return "hero";
  if (lower.includes("goal")) return "goal";
  if (lower.includes("door")) return "door";
  return object.detail.startsWith("enemy")
    ? "enemy"
    : object.detail.startsWith("item")
      ? "item"
      : "guide";
}

function renderHelpTerm(id: SnesHelpTermId, labelOverride?: string) {
  const term = helpTerms[id];
  return html`
    <span class="snes-help-term">
      <span class="snes-help-term__label">${labelOverride ?? term.label}</span>
      <button
        type="button"
        aria-label=${`What is ${term.label}?`}
        title=${`${term.label}: ${term.definition} ${term.why} ${term.careNow}`}
      >
        ?
      </button>
      <span class="snes-help-popover" role="tooltip">
        <strong>${term.label}</strong>
        <span>${term.definition}</span>
        <small>${term.why} ${term.careNow}</small>
      </span>
    </span>
  `;
}

function learningTermIdsForMode(): SnesHelpTermId[] {
  if (selectedMode === "edit") {
    return ["sprite", "level-square", "bump-map", "palette", "sprite-size"];
  }
  if (selectedMode === "play") {
    return ["sprite", "bump-map", "save-memory", "snes-game-file"];
  }
  if (selectedMode === "ship") {
    return ["snes-game-file", "flash-cart", "save-memory", "superfx", "checksum"];
  }
  return ["sprite", "level-square", "snes-game-file", "save-memory"];
}

function renderLearningDrawer() {
  return html`
    <details class="snes-learning-drawer">
      <summary>
        <span class="snes-learning-drawer__mark" aria-hidden="true">?</span>
        <span>
          <strong>Words explained</strong>
          <small>Open for plain-English meanings. Hover any ? for quick help.</small>
        </span>
      </summary>
      <div class="snes-learning-drawer__grid" aria-label="Plain-language SNES word guide">
        ${learningTermIdsForMode().map((id) => {
          const term = helpTerms[id];
          return html`
            <article>
              <strong>${term.label}</strong>
              <span>${term.definition}</span>
              <small>${term.careNow}</small>
            </article>
          `;
        })}
      </div>
    </details>
  `;
}

function objectCardDisplayDetail(object: SnesEditableObjectCard): string {
  return object.detail
    .replace(/\bNPC\b/gu, "Guide")
    .replace(/\bnpc\b/gu, "guide")
    .replace(/collision cells?/giu, "bump-rule squares")
    .replace(/metasprite tiles?/giu, "sprite size budget");
}

function objectCardMatchesFilter(object: SnesEditableObjectCard): boolean {
  if (objectCardFilter === "all") return true;
  if (objectCardFilter === "levels") return object.kind === "game" || object.kind === "level";
  if (objectCardFilter === "characters") {
    return object.kind === "entity" || object.kind === "animation";
  }
  if (objectCardFilter === "story") return object.kind === "dialogue" || object.kind === "event";
  if (objectCardFilter === "audio") return object.kind === "audio";
  return object.kind === "save" || object.kind === "export";
}

function objectCardMatchesSearch(object: SnesEditableObjectCard): boolean {
  const query = objectCardSearchDraft.trim().toLowerCase();
  if (!query) return true;
  return `${object.label} ${objectCardDisplayDetail(object)} ${objectCardDisplayKind(object)}`
    .toLowerCase()
    .includes(query);
}

function createEditableObjectCards(): SnesEditableObjectCard[] {
  const objects = createSnesGeneratedObjectSummary(project);
  const levelCards: SnesEditableObjectCard[] = project.scenes.map((scene, index) => ({
    id: `level:${index}`,
    kind: "level",
    label: scene.name,
    editPanel: "scene",
    detail: `${scene.widthMetatiles}x${scene.heightMetatiles} scene with ${scene.entities.length} game piece${scene.entities.length === 1 ? "" : "s"} and ${scene.collisionTiles} collision cells.`,
  }));
  return [
    {
      id: "game",
      kind: "game",
      label: project.name,
      detail: `${project.scenes.length} level${project.scenes.length === 1 ? "" : "s"}, ${objects.length} editable generated pieces.`,
      editPanel: "project" as const,
    },
    ...levelCards,
    ...objects,
  ];
}

function focusedEditableObjectCard(): SnesEditableObjectCard | undefined {
  return createEditableObjectCards().find((object) => object.id === focusedGeneratedObjectId);
}

function renderModeRail(host: HostUpdate) {
  const modes: Array<{ id: SnesStudioMode; label: string; detail: string }> = [
    { id: "make", label: "Start", detail: "Make a game from one prompt." },
    { id: "edit", label: "Build", detail: "See it, drag it, change it." },
    { id: "play", label: "Play", detail: "Test instantly." },
    { id: "ship", label: "Export", detail: "Create the SNES game file." },
  ];
  return html`
    <nav class="snes-mode-rail" aria-label="SNES Game Builder modes">
      ${modes.map(
        (mode, index) => html`
          <button
            type="button"
            class=${selectedMode === mode.id ? "active" : ""}
            aria-current=${selectedMode === mode.id ? "page" : nothing}
            aria-label=${`${mode.label}: ${mode.detail}${selectedMode === mode.id ? " You are here." : ""}`}
            @click=${() => selectStudioMode(host, mode.id)}
          >
            <span class="snes-mode-rail__step" aria-hidden="true">${index + 1}</span>
            <span class="snes-mode-rail__copy">
              <strong>${mode.label}</strong>
              <span class="snes-mode-rail__detail">${mode.detail}</span>
            </span>
            ${selectedMode === mode.id
              ? html`<span class="snes-mode-rail__status">You are here</span>`
              : nothing}
          </button>
        `,
      )}
    </nav>
  `;
}

function promptComposerLabel(target: SnesCreateTarget, object?: SnesEditableObjectCard) {
  if (target === "full-game") {
    return "Write the whole game idea";
  }
  if (target === "selected-object") {
    return object ? `Change ${object.label}` : "Click a thing, then write how to change it";
  }
  return `Write what to make for ${targetLabel(target)}`;
}

function promptConfirmationLabel(target: SnesCreateTarget, object?: SnesEditableObjectCard) {
  if (target === "selected-object") {
    return object
      ? `AI will change only ${object.label}`
      : "Click something first, then AI can change it";
  }
  return "AI will build from this prompt";
}

function promptComposerPreview(prompt: string) {
  const trimmed = prompt.trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return "Add a few words, then AI will build from exactly what you typed.";
  }
  return trimmed.length > 170 ? `${trimmed.slice(0, 167)}...` : trimmed;
}

function renderSelectedPromptContext(object: SnesEditableObjectCard | undefined) {
  if (selectedCreateTarget !== "selected-object") {
    return nothing;
  }
  if (!object) {
    return html`
      <div class="snes-selected-prompt-context empty" role="status">
        <span>No thing selected yet</span>
        <strong>Click an enemy, item, level, sound, or story part first.</strong>
      </div>
    `;
  }
  return html`
    <div class="snes-selected-prompt-context" role="status" aria-live="polite">
      <span>Next prompt changes only</span>
      <strong>${object.label}</strong>
      <small>${objectCardDisplayKind(object)} · ${objectCardDisplayDetail(object)}</small>
    </div>
  `;
}

function renderPromptTargetDrawer(host: HostUpdate) {
  return html`
    <details class="snes-prompt-target-drawer">
      <summary>
        <span>${promptTargetSummaryText()}</span>
        <small>Open choices</small>
      </summary>
      ${renderPromptTargetShortcuts(host)}
    </details>
  `;
}

async function askAgentForPreview(
  host: HostUpdate,
  targetOverride: SnesCreateTarget = selectedCreateTarget,
) {
  const surface = surfaceForCreateTarget(targetOverride);
  const provider = aiProviderBySurface[surface];
  const record = createSnesAgentDispatchRecord(
    project,
    surfacePromptDraft(surface),
    new Date().toISOString(),
    provider,
    surface,
  );
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  selectedPanel = "prompt";
  const connected = isGatewayLiveReady(host);
  setAiActionFeedback(host, {
    status: "working",
    title: connected ? "Asking connected AI for a preview" : "Making a preview change",
    detail: connected
      ? "SNES Studio is asking the connected agent for an editable change preview. You can keep building immediately with Make Now."
      : "SNES Studio is making an editable preview you can review before anything changes.",
    provider,
    target: targetLabel(targetOverride),
  });
  if (connected) {
    await sendQueuedAgentTaskToGateway(host, record);
    return;
  }
  await runQueuedAgentTask(host, record);
}

async function askAiGameStageLiveAgent(host: HostUpdate) {
  const selected = selectedSceneThing();
  const targetOverride: SnesCreateTarget = selected ? "selected-object" : "full-game";
  const surface = aiGameStageSurface();
  const provider = aiGameStageResolvedProvider(surface);
  const prompt = aiGameStagePromptDraft().trim();
  const checkedAt = new Date().toISOString();

  if (!prompt) {
    setAiActionFeedback(host, {
      status: "error",
      title: "Tell AI what to make first",
      detail:
        "Type one sentence in the prompt box, then Ask Live OpenClaw can request worker output for Codex review.",
      provider,
      target: targetLabel(targetOverride),
    });
    pushConsole(host, "Live agent prompt needs text before it can run.");
    host.requestUpdate?.();
    return;
  }

  aiProviderBySurface = { ...aiProviderBySurface, [surface]: provider };
  selectedCreateTarget = targetOverride;
  selectedPanel = "prompt";

  const readiness = probeSnesLiveAiReadiness(host);
  if (readiness.status !== "ready") {
    const detail = readiness.detail;
    setLiveAgentProofState(host, {
      status: "needs-setup",
      title: readiness.title,
      detail,
      checkedAt,
    });
    setAiActionFeedback(host, {
      status: "error",
      title: "Live agent needs setup",
      detail,
      provider,
      target: targetLabel(targetOverride),
    });
    pushConsole(host, `Ask Live OpenClaw blocked: ${detail}`);
    host.requestUpdate?.();
    return;
  }

  const record = createSnesAgentDispatchRecord(project, prompt, checkedAt, provider, surface);
  agentDispatchQueue = appendSnesAgentDispatchRecord(agentDispatchQueue, record);
  saveAgentDispatchQueue();
  globalThis.dispatchEvent?.(new CustomEvent(SNES_AGENT_DISPATCH_EVENT, { detail: record }));
  setLiveAgentProofState(host, {
    status: "running",
    title: "Asking live agent",
    detail: `${liveAgentProviderLabel(provider)} is preparing an editable ${targetLabel(targetOverride)} preview through ${agentGatewaySessionKey}.`,
    checkedAt,
    recordId: record.id,
  });
  setAiActionFeedback(host, {
    status: "working",
    title: "Asking live agent",
    detail:
      "OpenClaw/Codex is preparing a reviewed change. Nothing will be changed until you approve the preview.",
    provider,
    target: targetLabel(targetOverride),
  });

  await sendQueuedAgentTaskToGateway(host, record);
  const stream = latestAgentStreamForRecord(record.id);
  if (stream?.status === "complete" && pendingAgentProposal) {
    pendingInlineReviewObjectId = selected ? `${selected.scene.id}:${selected.entity.id}` : "";
    setLiveAgentProofState(host, {
      status: "passed",
      title: "Live agent preview ready",
      detail:
        "The connected agent returned editable patch JSON. Review it on this screen before applying.",
      checkedAt,
      recordId: record.id,
    });
    pushConsole(host, `Live ${liveAgentProviderLabel(provider)} preview ready for review.`);
    host.requestUpdate?.();
    return;
  }
  if (stream?.status === "error") {
    setLiveAgentProofState(host, {
      status: "failed",
      title: "Live agent failed",
      detail: stream.chunk ?? "The connected agent failed before returning an editable preview.",
      checkedAt,
      recordId: record.id,
    });
    return;
  }
  setLiveAgentProofState(host, {
    status: "needs-setup",
    title: "Waiting for editable preview",
    detail:
      "The Gateway accepted the prompt, but no editable patch JSON was returned in this request yet.",
    checkedAt,
    recordId: record.id,
  });
  host.requestUpdate?.();
}

function renderAiConnectionCoach(
  host: HostUpdate,
  compact = false,
  targetOverride: SnesCreateTarget = selectedCreateTarget,
) {
  const connected = isGatewayLiveReady(host);
  const surface = surfaceForCreateTarget(targetOverride);
  const provider = aiProviderBySurface[surface];
  const providerLabel = provider === "openclaw" ? "OpenClaw Agent" : "Codex";
  const readyLabel = connected ? `${providerLabel} connected` : "Instant builder ready";
  return html`
    <div
      class=${`snes-ai-connection-coach${compact ? " compact" : ""}${connected ? " connected" : " local"}`}
      aria-label="AI helper"
    >
      <div>
        <span>AI helper</span>
        <strong>${readyLabel}</strong>
        <p>
          ${connected
            ? "Make Now changes the game immediately so you can play. Agent Preview asks the connected agent for a review first."
            : `${providerLabel} is selected. Make Now creates immediately; Preview Change uses the local approval flow.`}
        </p>
      </div>
      <div class="snes-ai-connection-coach__actions">
        <button
          type="button"
          class="primary"
          @click=${() => createFromPromptTarget(host, targetOverride)}
        >
          Make Now
        </button>
        <button type="button" @click=${() => void askAgentForPreview(host, targetOverride)}>
          ${connected ? "Agent Preview" : "Preview Change"}
        </button>
        <button
          type="button"
          @click=${() => {
            selectedPanel = "prompt";
            host.requestUpdate?.();
          }}
        >
          AI Details
        </button>
      </div>
    </div>
  `;
}

function renderAiRouteBadges(
  host: HostUpdate,
  selectedProvider: SnesAgentProvider,
  compact = false,
) {
  const connected = isGatewayLiveReady(host);
  const providerLabel = selectedProvider === "openclaw" ? "OpenClaw Agent" : "Codex";
  const badges = compact
    ? [
        { title: "Instant", detail: "Creates now" },
        { title: providerLabel, detail: connected ? "Gateway ready" : "Local preview" },
      ]
    : [
        { title: "Instant builder", detail: "Creates now" },
        { title: providerLabel, detail: connected ? "Connected preview" : "Local plan" },
        { title: "Live agent", detail: connected ? "Gateway ready" : "Needs setup" },
      ];
  return html`
    <div class=${`snes-ai-route-badges${compact ? " compact" : ""}`} aria-label="AI build path">
      ${badges.map(
        (badge) => html`
          <article>
            <strong>${badge.title}</strong>
            <small>${badge.detail}</small>
          </article>
        `,
      )}
    </div>
  `;
}

function renderAiLiveAgentCheck(
  host: HostUpdate,
  selectedProvider: SnesAgentProvider,
  compact = false,
) {
  if (compact) {
    return nothing;
  }
  const connected = isGatewayLiveReady(host);
  const providerLabel = selectedProvider === "openclaw" ? "OpenClaw Agent" : "Codex";
  return html`
    <aside
      class=${`snes-ai-live-check${connected ? " connected" : " local"}`}
      aria-label="Live agent connection check"
    >
      <span>AI connection check</span>
      <strong>${connected ? "Gateway route ready" : "Instant builder works now"}</strong>
      <p>
        ${connected
          ? `${providerLabel} can send previews to ${agentGatewaySessionKey}.`
          : "Create and play now. Real agent proof needs a Gateway session."}
      </p>
      <small
        class=${`snes-ai-live-check__proof snes-ai-live-check__proof--${liveAgentProofState.status}`}
        >Live proof: ${liveAgentProofState.title}</small
      >
      <div class="snes-ai-live-check__actions">
        <button
          type="button"
          @click=${() => {
            selectedPanel = "prompt";
            host.requestUpdate?.();
          }}
        >
          Open AI setup
        </button>
        <button
          type="button"
          ?disabled=${liveAgentProofState.status === "running"}
          title=${liveAgentProofState.detail}
          @click=${() => void runLiveAgentProof(host)}
        >
          ${liveAgentProofState.status === "running" ? "Checking" : "Run proof"}
        </button>
        <button
          type="button"
          ?disabled=${liveAgentProofState.status === "running"}
          @click=${() => void runLocalAgentProof(host)}
        >
          Run local proof
        </button>
      </div>
    </aside>
  `;
}

function renderUniversalCreateBar(host: HostUpdate, compact = false) {
  const activeCreateTarget: SnesCreateTarget = compact ? selectedCreateTarget : "full-game";
  const surface = surfaceForCreateTarget(activeCreateTarget);
  const selectedProvider = aiProviderBySurface[surface];
  const focusedObject = compact ? focusedEditableObjectCard() : undefined;
  const disabled = activeCreateTarget === "selected-object" && !focusedObject;
  const promptDraft = surfacePromptDraft(surface);
  const hasSelectedPromptContext =
    activeCreateTarget === "selected-object" && Boolean(focusedObject);
  const canvasFirstCompact =
    compact &&
    (selectedMode === "edit" || selectedMode === "play") &&
    lastAiActionFeedback?.status === "ready";
  return html`
    <section
      class=${compact
        ? `snes-create-bar snes-president-prompt-bar compact${canvasFirstCompact ? " canvas-first" : ""}${hasSelectedPromptContext ? " has-selected-context" : " no-selected-context"}`
        : "snes-create-bar snes-president-prompt-bar"}
      aria-label="Ask AI to create or change the game"
    >
      <div class="snes-create-bar__intro">
        <strong>Ask AI</strong>
        <span>Type what you want. SNES Studio makes it editable, playable, and exportable.</span>
      </div>
      <div class="snes-create-bar__topline">
        ${compact
          ? html`
              <label class="snes-create-bar__target">
                Make or change
                <select
                  .value=${selectedCreateTarget}
                  @change=${(event: Event) =>
                    setCreateTarget(
                      host,
                      (event.target as HTMLSelectElement).value as SnesCreateTarget,
                    )}
                >
                  ${createTargetOptions().map(
                    (option) => html`
                      <option value=${option.id} ?selected=${selectedCreateTarget === option.id}>
                        ${option.label}
                      </option>
                    `,
                  )}
                </select>
              </label>
            `
          : html`
              <div class="snes-create-bar__start-scope" aria-label="Start creates a whole game">
                <span>Make</span>
                <strong>Whole game</strong>
              </div>
            `}
        <div class="snes-create-bar__provider" aria-label="AI provider">
          ${(["openclaw", "codex"] as const).map(
            (provider) => html`
              <button
                type="button"
                class=${selectedProvider === provider ? "active" : ""}
                @click=${() => setAiProvider(host, surface, provider)}
              >
                ${provider === "openclaw" ? "OpenClaw Agent" : "Codex"}
              </button>
            `,
          )}
        </div>
        ${renderAiRouteBadges(host, selectedProvider, compact)}
        ${renderAiLiveAgentCheck(host, selectedProvider, compact)}
      </div>
      ${compact ? renderPromptTargetDrawer(host) : nothing}
      ${renderSelectedPromptContext(focusedObject)}
      ${compact && lastAiActionFeedback?.status === "ready"
        ? nothing
        : compact
          ? renderAiConnectionCoach(host, compact, activeCreateTarget)
          : nothing}
      <label class="snes-create-bar__prompt">
        <span
          >${compact
            ? "Tell AI what to build"
            : promptComposerLabel(activeCreateTarget, focusedObject)}</span
        >
        <textarea
          rows=${compact ? "1" : "4"}
          .value=${promptDraft}
          placeholder=${promptPlaceholderForTarget(activeCreateTarget)}
          @input=${(event: Event) => updateAiPrompt(surface, inputValue(event))}
        ></textarea>
      </label>
      <div class=${`snes-create-bar__actions${compact ? "" : " start"}`}>
        <button
          type="button"
          class="primary snes-create-bar__send"
          ?disabled=${disabled}
          title=${disabled ? "Pick a thing before changing it." : ""}
          @click=${() => createFromPromptTarget(host, activeCreateTarget)}
        >
          ${surface === "full-game"
            ? "Create Game + Play"
            : `Create / Change ${targetLabel(activeCreateTarget)}`}
        </button>
        ${compact
          ? html`
              <button
                type="button"
                class="snes-create-bar__preview"
                ?disabled=${disabled}
                title=${disabled ? "Pick a thing before previewing a selected-thing change." : ""}
                @click=${() => previewAgentPatchForSurface(host, surface, activeCreateTarget)}
              >
                Preview First
              </button>
              <button type="button" @click=${() => startPreviewPlaytest(host)}>Play Now</button>
              <button
                type="button"
                ?disabled=${undoStack.length === 0}
                @click=${() => undoProjectChange(host)}
              >
                Undo
              </button>
            `
          : nothing}
      </div>
      ${compact
        ? nothing
        : html`
            <div class="snes-prompt-confirmation" aria-live="polite">
              <span>${promptConfirmationLabel(activeCreateTarget, focusedObject)}</span>
              <strong>${promptComposerPreview(promptDraft)}</strong>
            </div>
          `}
      ${compact ? nothing : renderBeginnerPromptChips(host, "snes-prompt-chips--inside-create")}
      ${compact
        ? nothing
        : html`
            <details class="snes-start-advanced-actions">
              <summary>Preview or advanced AI</summary>
              <div>
                <button
                  type="button"
                  class="snes-create-bar__preview"
                  ?disabled=${disabled}
                  title=${disabled ? "Pick a thing before previewing a selected-thing change." : ""}
                  @click=${() => previewAgentPatchForSurface(host, surface, activeCreateTarget)}
                >
                  Preview First
                </button>
                <button
                  type="button"
                  @click=${() => void askAgentForPreview(host, activeCreateTarget)}
                >
                  ${isGatewayLiveReady(host) ? "Agent Preview" : "Preview Change"}
                </button>
                <button
                  type="button"
                  @click=${() => {
                    selectedPanel = "prompt";
                    host.requestUpdate?.();
                  }}
                >
                  AI Details
                </button>
                <button
                  type="button"
                  ?disabled=${undoStack.length === 0}
                  @click=${() => undoProjectChange(host)}
                >
                  Undo
                </button>
              </div>
            </details>
          `}
      ${renderAiActionFeedback(host, canvasFirstCompact)}
      <small>
        ${focusedObject
          ? `Selected thing: ${focusedObject.label}. The next selected-thing prompt changes only this.`
          : `1. Describe it. 2. Pick OpenClaw or Codex. 3. Create + Play. Using ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}.`}
      </small>
    </section>
  `;
}

function summarizeAiReviewValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "empty";
  if (typeof value === "string") return value.slice(0, 72) || "empty text";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value).length} field object`;
  return "changed";
}

function pendingInlineReviewMatches(object: SnesEditableObjectCard | undefined) {
  return Boolean(pendingAgentProposal && object && pendingInlineReviewObjectId === object.id);
}

function primaryAiReviewDiffs() {
  return pendingAgentProposal
    ? diffSnesAgentPatchProposal(project, pendingAgentProposal).slice(0, 2)
    : [];
}

function renderInlineAiReviewPanel(
  host: HostUpdate,
  object: SnesEditableObjectCard | undefined,
  placement: "canvas" | "side",
) {
  if (!pendingAgentProposal || !pendingInlineReviewMatches(object)) {
    return nothing;
  }
  const targetObject = object;
  if (!targetObject) {
    return nothing;
  }
  const diffs = primaryAiReviewDiffs();
  const primaryDiff = diffs[0];
  return html`
    <section
      class=${`snes-inline-ai-review snes-inline-ai-review--${placement}`}
      aria-label="Inline AI preview for selected thing"
    >
      <div class="snes-inline-ai-review__header">
        <span>Review Before Apply</span>
        <strong>AI Preview for ${targetObject.label}</strong>
      </div>
      <p>${pendingAgentProposal.rationale[0] ?? "AI prepared a change you can approve first."}</p>
      <div class="snes-inline-ai-review__before-after" aria-label="Before and after preview">
        <span>Before</span>
        <strong
          >${primaryDiff ? summarizeAiReviewValue(primaryDiff.before) : "current version"}</strong
        >
        <span>After</span>
        <strong
          >${primaryDiff ? summarizeAiReviewValue(primaryDiff.after) : "updated version"}</strong
        >
      </div>
      ${diffs.length > 1
        ? html`<small
            >${diffs.length - 1} more change${diffs.length === 2 ? "" : "s"} ready.</small
          >`
        : nothing}
      <div class="snes-inline-ai-review__actions">
        <button type="button" class="primary" @click=${() => approveAgentPatch(host)}>
          Apply Change
        </button>
        <button type="button" @click=${() => discardAgentPatch(host)}>Discard</button>
      </div>
    </section>
  `;
}

function renderAiReviewDrawer(host: HostUpdate) {
  if (!pendingAgentProposal) {
    return nothing;
  }
  const diffs = diffSnesAgentPatchProposal(project, pendingAgentProposal);
  return html`
    <section class="snes-ai-review" aria-label="AI change review">
      <div>
        <span class="snes-eyebrow">Review Before Apply</span>
        <h3>${pendingAgentProposal.summary}</h3>
        <p>
          ${pendingAgentProposal.requestedAgent === "openclaw" ? "OpenClaw Agent" : "Codex"}
          prepared an editable ${pendingAgentProposal.surface} change. Apply it, discard it, or
          adjust the prompt first.
        </p>
      </div>
      <div class="snes-ai-review__meta">
        <span>Readiness</span><strong>${pendingAgentProposal.readiness.status}</strong>
        <span>Score</span><strong>${pendingAgentProposal.readiness.score}/100</strong>
        <span>Changes</span><strong>${pendingAgentProposal.operations.length}</strong>
      </div>
      <div class="snes-ai-review__diffs">
        ${diffs.slice(0, 5).map(
          (diff) => html`
            <article>
              <strong>${diff.path}</strong>
              <small
                >${summarizeAiReviewValue(diff.before)} ->
                ${summarizeAiReviewValue(diff.after)}</small
              >
            </article>
          `,
        )}
      </div>
      <div class="snes-toolbar">
        <button type="button" class="primary" @click=${() => approveAgentPatch(host)}>
          Apply Change
        </button>
        <button type="button" @click=${() => discardAgentPatch(host)}>Discard</button>
        <button
          type="button"
          @click=${() => {
            selectedMode = "make";
            selectedPanel = "prompt";
            pushConsole(host, "Kept AI change in review so the prompt can be adjusted.");
          }}
        >
          Edit Prompt
        </button>
      </div>
    </section>
  `;
}

function renderMakeSteps(_host: HostUpdate) {
  return html`
    <div class="snes-make-steps" aria-label="Fast game creation steps">
      <article>
        <span>1</span>
        <strong>Describe</strong>
        <small>Write the whole game idea.</small>
      </article>
      <article>
        <span>2</span>
        <strong>Create</strong>
        <small>Use the big Create button.</small>
      </article>
      <article>
        <span>3</span>
        <strong>Play</strong>
        <small>Test instantly.</small>
      </article>
    </div>
  `;
}

function recentActivityLines() {
  const defaults = new Set(createDefaultConsoleLines());
  return consoleLines.filter((line) => !defaults.has(line)).slice(0, 6);
}

function renderRecentActivity() {
  const lines = recentActivityLines();
  if (lines.length === 0) {
    return nothing;
  }
  return html`
    <aside class="snes-recent-activity" aria-live="polite">
      <strong>Recent</strong>
      ${lines.map((line) => html`<span>${line}</span>`)}
    </aside>
  `;
}

function renderPlayRecentDrawer() {
  const lines = recentActivityLines();
  if (lines.length === 0) {
    return nothing;
  }
  return html`
    <details class="snes-play-drawer snes-play-recent-drawer">
      <summary>Recent test notes</summary>
      <aside class="snes-recent-activity" aria-live="polite">
        <strong>Recent</strong>
        ${lines.map((line) => html`<span>${line}</span>`)}
      </aside>
    </details>
  `;
}

function renderPromptFirstHero(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  return html`
    <section class="snes-start-loop-coach" aria-label="Start guide">
      <div class="snes-start-loop-coach__copy">
        <span class="snes-eyebrow">Quick Start</span>
        <h2>Ask. Play. Change.</h2>
        <p>Use the prompt above, then test and edit anything on the canvas.</p>
      </div>
      <div class="snes-start-loop" aria-label="Simple creation path">
        <article>
          <span>Ask</span>
          <strong>Describe the game</strong>
          <small>Type one line or tap a starter idea.</small>
        </article>
        <article>
          <span>Play</span>
          <strong>Try it immediately</strong>
          <small>Create Game + Play opens the test.</small>
        </article>
        <article>
          <span>Change</span>
          <strong>Click, drag, prompt</strong>
          <small>Change any level, hero, enemy, item, or sound.</small>
        </article>
      </div>
      <div class="snes-start-loop-coach__side">
        <div class="snes-start-loop-coach__status" aria-label="Current project status">
          <span>Game</span>
          <strong>${project.name}</strong>
          <span>Playable</span>
          <strong>${readiness.status === "ready" ? "Ready" : "Needs Fixing"}</strong>
          <span>Levels</span>
          <strong>${project.scenes.length}</strong>
        </div>
        <div class="snes-start-actions" aria-label="Simple start actions">
          <button type="button" @click=${() => startBlankProject(host)}>Start Blank</button>
          <button
            type="button"
            @click=${() => {
              selectedPanel = "project";
              host.requestUpdate?.();
            }}
          >
            Open / Import
          </button>
        </div>
      </div>
    </section>
  `;
}

function gameMapGroups(cards: SnesEditableObjectCard[]) {
  return [
    {
      id: "core",
      label: "Game",
      cards: cards.filter((card) => card.kind === "game" || card.kind === "level").slice(0, 6),
    },
    {
      id: "pieces",
      label: "Pieces",
      cards: cards
        .filter((card) => card.kind === "entity" || card.kind === "animation")
        .slice(0, 6),
    },
    {
      id: "story",
      label: "Story",
      cards: cards.filter((card) => card.kind === "dialogue" || card.kind === "event").slice(0, 4),
    },
    {
      id: "sound",
      label: "Sound & Saves",
      cards: cards
        .filter((card) => card.kind === "audio" || card.kind === "save" || card.kind === "export")
        .slice(0, 6),
    },
  ].filter((group) => group.cards.length > 0);
}

function renderGamePartsMap(host: HostUpdate, compact = false) {
  const cards = createEditableObjectCards();
  const groups = gameMapGroups(cards);
  return html`
    <section
      class=${compact ? "snes-game-map compact" : "snes-game-map"}
      aria-label="All Things Map"
    >
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">All Things Map</span>
          <h3>Parts Shelf: everything you can change</h3>
          <p>Pick a part, prompt it, drag it where it belongs, edit it, or test it.</p>
        </div>
        <button type="button" @click=${() => selectStudioMode(host, "edit")}>Open Build</button>
      </div>
      <div class="snes-game-map__grid">
        ${groups.map(
          (group) => html`
            <article class="snes-game-map__group">
              <header>${group.label}</header>
              ${group.cards.map(
                (object) => html`
                  <button
                    type="button"
                    class=${focusedGeneratedObjectId === object.id ? "active" : ""}
                    draggable="true"
                    @dragstart=${() => {
                      draggedPart = { id: object.id, kind: object.kind, label: object.label };
                      draggedEntityId =
                        object.kind === "entity" ? (object.id.split(":").at(-1) ?? null) : null;
                      draggedPalettePiece = null;
                      pushConsole(host, `Dragging ${object.label}. Drop it on a matching target.`);
                    }}
                    @dragend=${() => {
                      draggedPart = null;
                      draggedEntityId = null;
                    }}
                    @click=${() => focusGeneratedObject(host, object)}
                  >
                    <span>${objectCardDisplayKind(object)}</span>
                    <strong>${object.label}</strong>
                    <small>${objectCardDisplayDetail(object)}</small>
                  </button>
                `,
              )}
            </article>
          `,
        )}
      </div>
      <div class="snes-game-map__actions">
        <button
          type="button"
          @click=${() => {
            const focusedCard = focusedEditableObjectCard();
            if (focusedCard) {
              promptChangeGeneratedObject(host, focusedCard);
              return;
            }
            selectedCreateTarget = "selected-object";
            host.requestUpdate?.();
          }}
        >
          Ask AI To Change Selection
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host)}>Test</button>
        <button
          type="button"
          @click=${() => undoProjectChange(host)}
          ?disabled=${undoStack.length === 0}
        >
          Undo
        </button>
      </div>
    </section>
  `;
}
function renderProjectAccess(host: HostUpdate) {
  const templates = createSnesProjectTemplates();
  return html`
    <details class="snes-project-access" ?open=${selectedPanel === "project"}>
      <summary>Open, import, templates, and recovery</summary>
      <div class="snes-template-gallery snes-template-gallery--compact">
        ${templates.map(
          (template) => html`
            <button type="button" @click=${() => applyProjectTemplate(host, template.id)}>
              <strong>${template.name}</strong>
              <small>${template.summary}</small>
            </button>
          `,
        )}
      </div>
      <label>
        Project name
        <input
          .value=${project.name}
          @input=${(event: Event) =>
            updateProject(host, (draft) => {
              draft.name = inputValue(event);
            })}
        />
      </label>
      <label>
        Import project JSON or bundle
        <textarea
          rows="3"
          .value=${projectImportDraft}
          @input=${(event: Event) => {
            projectImportDraft = inputValue(event);
          }}
        ></textarea>
      </label>
      <div class="snes-toolbar">
        <button type="button" @click=${() => importProjectDocument(host)}>
          Import Project Document
        </button>
        <label class="snes-file-button">
          Open Project File
          <input
            type="file"
            accept=".json,application/json"
            @change=${(event: Event) => void importProjectFile(host, event)}
          />
        </label>
        <button type="button" @click=${() => snapshotProject(host)}>Snapshot</button>
        <button
          type="button"
          @click=${() => {
            showRecoveryPanel = true;
            host.requestUpdate?.();
          }}
        >
          Recovery
        </button>
      </div>
    </details>
  `;
}

function renderVersionHistory(host: HostUpdate) {
  if (projectVersions.length === 0) {
    return nothing;
  }
  return html`
    <section class="snes-version-history" aria-label="Version History">
      <div>
        <span class="snes-eyebrow">Version History</span>
        <h3>${projectVersions.length} saved snapshots</h3>
        <p>Restore a safe project state from a snapshot or saved version.</p>
      </div>
      <button type="button" @click=${() => restoreLastSnapshot(host)}>Restore Snapshot</button>
      <div class="snes-version-history__list">
        ${projectVersions
          .slice(0, 5)
          .map(
            (version) => html`
              <button type="button" @click=${() => restoreProjectVersion(host, version)}>
                ${version.reason} · ${version.projectName}
              </button>
            `,
          )}
      </div>
    </section>
  `;
}

function renderMakeMode(host: HostUpdate) {
  return html`
    <section class="snes-make-mode snes-create-mode" aria-label="Create a SNES game">
      ${renderPromptFirstHero(host)} ${renderAiReviewDrawer(host)}
      <div class="snes-create-home-grid">
        <details class="snes-game-map-drawer">
          <summary>
            <span>All Things Map</span>
            <strong>Open after AI creates the first draft</strong>
          </summary>
          ${renderGamePartsMap(host, true)}
        </details>
        <aside class="snes-beginner-path" aria-label="Three step beginner path">
          <span class="snes-eyebrow">3 Steps</span>
          ${renderMakeSteps(host)}
        </aside>
      </div>
      ${renderProjectAccess(host)} ${renderVersionHistory(host)}
      <details class="snes-make-ai-tools" ?open=${selectedPanel === "prompt"}>
        <summary
          @click=${() => {
            selectedPanel = "prompt";
          }}
        >
          Professional AI details
        </summary>
        ${renderInspector(host)}
      </details>
      ${renderRecentActivity()}
    </section>
  `;
}

function sceneEntityCanvasLabel(entity: SnesStudioProject["scenes"][number]["entities"][number]) {
  if (entity.name.toLowerCase().includes("door")) return "Door";
  if (entity.name.toLowerCase().includes("goal")) return "Goal";
  if (entity.kind === "player") return "Hero";
  if (entity.kind === "enemy") return "Enemy";
  if (entity.kind === "item") return "Item";
  if (entity.kind === "npc") return "Guide";
  return "Thing";
}

function sceneEntityCanvasBadge(entity: SnesStudioProject["scenes"][number]["entities"][number]) {
  const label = sceneEntityCanvasLabel(entity);
  return label === "Guide" ? "G" : label.charAt(0);
}

function selectSceneEntity(
  host: HostUpdate,
  scene: SnesStudioProject["scenes"][number],
  entity: SnesStudioProject["scenes"][number]["entities"][number],
) {
  focusedGeneratedObjectId = `${scene.id}:${entity.id}`;
  selectedCreateTarget = "selected-object";
  pushConsole(host, `Selected ${entity.name}. Drag it, edit it, or ask AI to change it.`);
  host.requestUpdate?.();
}

function focusFirstSceneThing(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const entity =
    scene.entities.find((candidate) => candidate.kind === "player") ?? scene.entities[0];
  if (!entity) {
    addScenePalettePiece(host, "hero");
    return;
  }
  selectSceneEntity(host, scene, entity);
}

function renderBuildNextStepCoach(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const focusedObject = focusedEditableObjectCard();
  const selectedSceneThing =
    focusedObject?.id.startsWith(`${scene.id}:`) ||
    focusedObject?.id === `level:${selectedSceneIndex}`;
  return html`
    <section class="snes-next-step-coach" aria-label="Next best step">
      <div>
        <span class="snes-eyebrow">Next Best Step</span>
        <h4>
          ${selectedSceneThing && focusedObject
            ? `${focusedObject.label} is ready to change`
            : "Pick a thing, shape the level, or test it"}
        </h4>
        <p>
          ${selectedSceneThing && focusedObject
            ? `The next selected-thing prompt changes only ${focusedObject.label}.`
            : "Start by picking the hero or using one of the buttons below. Everything stays editable."}
        </p>
      </div>
      <div class="snes-next-step-coach__actions">
        ${selectedSceneThing && focusedObject
          ? html`
              <button
                type="button"
                @click=${() => promptChangeGeneratedObject(host, focusedObject)}
              >
                Ask AI About This
              </button>
            `
          : html`
              <button type="button" @click=${() => focusFirstSceneThing(host, scene)}>
                Pick Hero
              </button>
            `}
        <button type="button" @click=${() => paintLevelFromPrompt(host)}>Draw Level With AI</button>
        <button type="button" @click=${() => addScenePalettePiece(host, "enemy")}>Add Enemy</button>
        <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
          Play Game
        </button>
      </div>
    </section>
  `;
}

function formatReadinessCoachMeter(meter: SnesBudgetMeter | undefined) {
  if (!meter) return "Waiting for project data.";
  const remaining = Math.max(0, meter.limit - meter.used);
  const unit =
    meter.unit === "bytes"
      ? "bytes"
      : meter.unit === "colors"
        ? "color slots"
        : meter.unit === "entries"
          ? "slots"
          : "Mbit";
  return `${remaining.toLocaleString()} ${unit} left.`;
}

function readinessCoachStatus(severity: SnesBudgetMeter["severity"] | "ready" | "warning") {
  return severity === "error" ? "fix" : severity === "warning" ? "watch" : "ready";
}

function renderBuildReadinessCoach(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const readiness = buildSnesReadiness(project);
  const spriteReport = createSnesSpriteOamBudgetReport(project);
  const artMemory = readiness.budgets.find((meter) => meter.label === "VRAM");
  const colors = readiness.budgets.find((meter) => meter.label === "CGRAM");
  const movingThingsStatus =
    spriteReport.status === "blocked"
      ? "fix"
      : spriteReport.status === "warning"
        ? "watch"
        : "ready";
  const bumpStatus = scene.collisionTiles > 0 ? "ready" : "watch";
  const statusLabel =
    readiness.status === "ready"
      ? "Ready for SNES"
      : readiness.status === "caution"
        ? "Needs a quick look"
        : "Needs fixes";
  const checks = [
    {
      label: "Level art memory",
      status: readinessCoachStatus(artMemory?.severity ?? "ready"),
      detail: formatReadinessCoachMeter(artMemory),
    },
    {
      label: "Moving things",
      status: movingThingsStatus,
      detail: `${scene.entities.length} pieces placed. ${spriteReport.remainingEntries} sprite slots left.`,
    },
    {
      label: "Colors",
      status: readinessCoachStatus(colors?.severity ?? "ready"),
      detail: formatReadinessCoachMeter(colors),
    },
    {
      label: "Where the player bumps",
      status: bumpStatus,
      detail:
        scene.collisionTiles > 0
          ? `${scene.collisionTiles} squares are marked for ground, water, danger, or walls.`
          : "Paint ground or danger so the hero knows what to stand on.",
    },
  ];
  return html`
    <section class="snes-build-readiness-coach" aria-label="SNES fit check">
      <div class="snes-build-readiness-coach__header">
        <div>
          <span class="snes-eyebrow">SNES Fit Check</span>
          <h4>${statusLabel}</h4>
          <p>This keeps the game friendly to real Super Nintendo limits while you build.</p>
        </div>
        <strong>${readiness.score}/100</strong>
      </div>
      <div class="snes-build-readiness-coach__checks">
        ${checks.map(
          (check) => html`
            <article class=${`snes-fit-check snes-fit-check--${check.status}`}>
              <span
                >${check.status === "ready"
                  ? "Ready"
                  : check.status === "watch"
                    ? "Watch"
                    : "Fix"}</span
              >
              <strong>${check.label}</strong>
              <small>${check.detail}</small>
            </article>
          `,
        )}
      </div>
      <details class="snes-build-readiness-coach__expert">
        <summary>Why this matters on real SNES</summary>
        <p>
          The expert names are ${renderHelpTerm("vram")}, ${renderHelpTerm("cgram")},
          ${renderHelpTerm("oam")}, and ${renderHelpTerm("bump-map")}. You can ignore them while the
          cards above say Ready.
        </p>
        ${readiness.issues.length > 0
          ? html`
              <ul>
                ${readiness.issues.slice(0, 3).map((issue) => html`<li>${issue.suggestion}</li>`)}
              </ul>
            `
          : html`<p>No current blockers. Keep testing after every big visual change.</p>`}
        <div class="snes-toolbar">
          <button type="button" @click=${() => repairPlayablePreview(host)}>Fix With AI</button>
          <button type="button" @click=${() => startPreviewPlaytest(host)}>Test Game</button>
        </div>
      </details>
    </section>
  `;
}

function renderCanvasEntity(
  host: HostUpdate,
  scene: SnesStudioProject["scenes"][number],
  entity: SnesStudioProject["scenes"][number]["entities"][number],
) {
  const widthPixels = Math.max(16, scene.widthMetatiles * 16);
  const heightPixels = Math.max(16, scene.heightMetatiles * 16);
  const left = Math.max(0, Math.min(100, (entity.x / widthPixels) * 100));
  const top = Math.max(0, Math.min(100, (entity.y / heightPixels) * 100));
  const labelLeft = Math.max(10, Math.min(90, left));
  const labelTop = Math.max(10, Math.min(94, top));
  const labelShiftX = left <= 10 ? "0%" : left >= 90 ? "-100%" : "-50%";
  const labelShiftY = top <= 10 ? "0%" : "-70%";
  const focused = focusedGeneratedObjectId === `${scene.id}:${entity.id}`;
  const kind = sceneEntityCanvasLabel(entity).toLowerCase();
  return html`
    <button
      type="button"
      class=${`snes-canvas-object snes-canvas-object--${kind} ${focused ? "active" : ""}`}
      data-piece-kind=${kind}
      style=${`left:${labelLeft}%;top:${labelTop}%;--canvas-object-x:${labelShiftX};--canvas-object-y:${labelShiftY};`}
      draggable="true"
      aria-label=${`${sceneEntityCanvasLabel(entity)} ${entity.name}. Click to edit, drag to move, then ask AI or test it.`}
      title="Click to edit. Drag to move. Ask AI or test after selecting."
      @pointerdown=${() => {
        draggedEntityId = entity.id;
        draggedPalettePiece = null;
        draggedPart = null;
      }}
      @dragstart=${(event: DragEvent) => {
        event.dataTransfer?.setData("text/plain", entity.id);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
        }
        draggedEntityId = entity.id;
        draggedPalettePiece = null;
        draggedPart = null;
      }}
      @click=${() => selectSceneEntity(host, scene, entity)}
    >
      <span
        class="snes-canvas-object__badge"
        data-letter=${sceneEntityCanvasBadge(entity)}
        aria-hidden="true"
      >
        <span class="snes-piece-glyph"></span>
      </span>
      <strong>${entity.name}</strong>
      <small>Click · Drag · AI</small>
    </button>
  `;
}

function renderCanvasInlineAiReview(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  if (!pendingAgentProposal || !pendingInlineReviewObjectId.startsWith(`${scene.id}:`)) {
    return nothing;
  }
  const [, entityId] = pendingInlineReviewObjectId.split(":");
  const entity = scene.entities.find((candidate) => candidate.id === entityId);
  const object = focusedEditableObjectCard();
  if (!entity || !pendingInlineReviewMatches(object)) {
    return nothing;
  }
  const widthPixels = Math.max(16, scene.widthMetatiles * 16);
  const heightPixels = Math.max(16, scene.heightMetatiles * 16);
  const left = Math.max(14, Math.min(86, (entity.x / widthPixels) * 100 + 8));
  const top = Math.max(14, Math.min(82, (entity.y / heightPixels) * 100 - 4));
  const shiftX = left > 72 ? "-100%" : "0%";
  const shiftY = top > 68 ? "-100%" : "0%";
  return html`
    <div
      class="snes-canvas-inline-review-anchor"
      style=${`left:${left}%;top:${top}%;--inline-review-x:${shiftX};--inline-review-y:${shiftY};`}
    >
      ${renderInlineAiReviewPanel(host, object, "canvas")}
    </div>
  `;
}

function startDraggingPalettePiece(
  host: HostUpdate,
  piece: { id: SnesScenePalettePiece; label: string },
  event?: DragEvent,
) {
  event?.dataTransfer?.setData("text/plain", piece.id);
  if (event?.dataTransfer) {
    event.dataTransfer.effectAllowed = "copy";
  }
  draggedPalettePiece = piece.id;
  draggedEntityId = null;
  draggedPart = null;
  if (event) {
    pushConsole(host, `Dragging new ${piece.label}. Drop it on any square.`);
  }
}

function renderCanvasPieceShelf(
  host: HostUpdate,
  palettePieces: Array<{ id: SnesScenePalettePiece; label: string; detail: string }>,
) {
  return html`
    <div class="snes-canvas-piece-shelf" aria-label="Add pieces to the level">
      <div class="snes-canvas-tool-label">
        <strong>Add pieces</strong>
        <span>Click to add. Drag to place.</span>
      </div>
      <div class="snes-canvas-piece-shelf__pieces">
        ${palettePieces.map(
          (piece) => html`
            <button
              type="button"
              class=${`snes-canvas-piece-shelf__piece snes-canvas-piece-shelf__piece--${piece.id}`}
              data-piece-kind=${piece.id}
              draggable="true"
              title=${`${piece.label}: ${piece.detail}. Click to add, or drag into the scene.`}
              @pointerdown=${() => startDraggingPalettePiece(host, piece)}
              @dragstart=${(event: DragEvent) => startDraggingPalettePiece(host, piece, event)}
              @click=${() => {
                draggedPalettePiece = null;
                addScenePalettePiece(host, piece.id);
              }}
            >
              <span class="snes-piece-glyph" aria-hidden="true"></span>
              <strong>${piece.label}</strong>
              <small>${piece.detail}</small>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderCanvasBrushDock(host: HostUpdate) {
  const current = currentBeginnerBrushId();
  return html`
    <div class="snes-canvas-brush-dock" aria-label="Draw the level">
      <div class="snes-canvas-tool-label">
        <strong>Draw level</strong>
        <span>Pick one, then click.</span>
      </div>
      <div class="snes-canvas-brush-dock__buttons">
        ${beginnerBrushes().map(
          (brush) => html`
            <button
              type="button"
              class=${current === brush.id ? "active" : ""}
              aria-pressed=${current === brush.id ? "true" : "false"}
              @click=${() => selectBeginnerBrush(host, brush.id)}
            >
              <strong>${brush.label}</strong>
              <small>${brush.detail}</small>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderCanvasBuildTools(
  host: HostUpdate,
  palettePieces: Array<{ id: SnesScenePalettePiece; label: string; detail: string }>,
) {
  return html`
    <div class="snes-canvas-build-tools" aria-label="Build tools">
      <div class="snes-canvas-build-tools__intro">
        <strong>Build tools</strong>
        <span>Add pieces or draw the level without opening a drawer.</span>
      </div>
      ${renderCanvasPieceShelf(host, palettePieces)} ${renderCanvasBrushDock(host)}
    </div>
  `;
}

function renderCanvasNextStep(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const focusedObject = focusedEditableObjectCard();
  const selectedSceneThing =
    focusedObject?.id.startsWith(`${scene.id}:`) ||
    focusedObject?.id === `level:${selectedSceneIndex}`;
  return html`
    <div class="snes-canvas-next-step" aria-label="Next action on the canvas">
      <div class="snes-canvas-next-step__copy">
        <span>Next on the canvas</span>
        <strong>
          ${selectedSceneThing && focusedObject
            ? `Change ${focusedObject.label}`
            : "Pick, draw, or play"}
        </strong>
        <small>
          ${selectedSceneThing && focusedObject
            ? "Ask AI to change only this thing, or play the level right away."
            : "Use these three buttons first. Everything else can wait."}
        </small>
      </div>
      <div class="snes-canvas-next-step__actions">
        ${selectedSceneThing && focusedObject
          ? html`
              <button
                type="button"
                @click=${() => promptChangeGeneratedObject(host, focusedObject)}
              >
                Ask AI
              </button>
            `
          : html`
              <button type="button" @click=${() => focusFirstSceneThing(host, scene)}>
                Pick Hero
              </button>
            `}
        <button type="button" @click=${() => paintLevelFromPrompt(host)}>Draw with AI</button>
        <button type="button" @click=${() => addScenePalettePiece(host, "enemy")}>Add Enemy</button>
        <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
          Play
        </button>
      </div>
    </div>
  `;
}

function renderCanvasActionLoop(host: HostUpdate, scene: SnesStudioProject["scenes"][number]) {
  const focusedObject = focusedEditableObjectCard();
  const selectedSceneThing =
    focusedObject?.id.startsWith(`${scene.id}:`) ||
    focusedObject?.id === `level:${selectedSceneIndex}`;
  const selectedLabel = selectedSceneThing && focusedObject ? focusedObject.label : "";
  const loopSteps = [
    {
      label: "1",
      title: "Pick",
      detail: selectedLabel ? `${selectedLabel} is selected.` : "Click a game piece.",
    },
    {
      label: "2",
      title: "Move",
      detail: "Drag it on the canvas.",
    },
    {
      label: "3",
      title: "Ask AI",
      detail: selectedLabel ? `Change only ${selectedLabel}.` : "Prompt a change.",
    },
    {
      label: "4",
      title: "Play",
      detail: "Play right away.",
    },
  ];
  return html`
    <section class="snes-canvas-action-loop" aria-label="Build loop">
      <div class="snes-canvas-action-loop__intro">
        <span>Next moves</span>
        <strong>Pick, move, ask AI, play.</strong>
        <small>
          ${selectedLabel ? `Now changing ${selectedLabel}.` : "Start by clicking a game piece."}
        </small>
      </div>
      <div class="snes-canvas-action-loop__steps">
        ${loopSteps.map(
          (step) => html`
            <article title=${step.detail}>
              <span>${step.label}</span>
              <strong>${step.title}</strong>
            </article>
          `,
        )}
      </div>
      <div class="snes-canvas-action-loop__actions">
        ${selectedLabel && focusedObject
          ? html`
              <button
                type="button"
                @click=${() => promptChangeGeneratedObject(host, focusedObject)}
              >
                Ask AI About This
              </button>
            `
          : html`
              <button type="button" @click=${() => focusFirstSceneThing(host, scene)}>
                Pick Hero
              </button>
            `}
        <button
          type="button"
          class="primary"
          @click=${() => startPreviewPlaytest(host, true, true)}
        >
          Play Game
        </button>
      </div>
    </section>
  `;
}

function renderBuildHelpDrawer(
  host: HostUpdate,
  scene: SnesStudioProject["scenes"][number],
  palettePieces: Array<{ id: SnesScenePalettePiece; label: string; detail: string }>,
) {
  return html`
    <details class="snes-build-help-drawer">
      <summary>
        <span>
          <strong>Need help or checks?</strong>
          <small>Open when you want guided steps, SNES checks, or extra tools.</small>
        </span>
      </summary>
      <div class="snes-build-help-drawer__content">
        ${renderBuildNextStepCoach(host, scene)} ${renderBuildReadinessCoach(host, scene)}
        <section class="snes-level-builder" aria-label="Build this level">
          <div class="snes-level-builder__intro">
            <span class="snes-eyebrow">Build This Level</span>
            <h4>Four simple moves: ask, draw, drop, test.</h4>
          </div>
          <div class="snes-level-builder__steps">
            <button
              type="button"
              class="snes-level-builder__step"
              @click=${() => paintLevelFromPrompt(host)}
            >
              <span>1</span>
              <strong>Ask AI</strong>
              <small>Paint the level from your prompt.</small>
            </button>
            <button
              type="button"
              class=${selectedPaintMode === "tile" && selectedTileBrush === 1
                ? "snes-level-builder__step active"
                : "snes-level-builder__step"}
              @click=${() => {
                selectPaintMode(host, "tile");
                selectTileBrush(host, 1);
              }}
            >
              <span>2</span>
              <strong>Draw</strong>
              <small>Click squares to make ground.</small>
            </button>
            <button
              type="button"
              class="snes-level-builder__step"
              @click=${() => addScenePalettePiece(host, "enemy")}
            >
              <span>3</span>
              <strong>Drop</strong>
              <small>Add an enemy, item, door, or goal.</small>
            </button>
            <button
              type="button"
              class="snes-level-builder__step primary"
              @click=${() => startPreviewPlaytest(host)}
            >
              <span>4</span>
              <strong>Play</strong>
              <small>Play from this scene now.</small>
            </button>
          </div>
        </section>
        <details class="snes-scene-more-tools">
          <summary>More drawing and object tools</summary>
          <div class="snes-scene-tools snes-scene-tools--secondary" aria-label="More scene tools">
            <button
              type="button"
              @click=${() => {
                selectPaintMode(host, "tile");
                selectTileBrush(host, 1);
              }}
            >
              Draw Ground
            </button>
            <button type="button" @click=${() => addScenePalettePiece(host, "enemy")}>
              Add Enemy
            </button>
            <button type="button" @click=${() => addScenePalettePiece(host, "item")}>
              Add Item
            </button>
            <button type="button" @click=${() => addScenePalettePiece(host, "door")}>
              Add Door
            </button>
            <button type="button" @click=${() => addScenePalettePiece(host, "goal")}>
              Add Goal
            </button>
            <button type="button" @click=${() => addScenePalettePiece(host, "guide")}>
              Add Guide
            </button>
            <button
              type="button"
              @click=${() => {
                selectPaintMode(host, "collision");
                selectCollisionMaterial(host, 2);
              }}
            >
              Paint Danger
            </button>
            <button
              type="button"
              @click=${() => {
                selectPaintMode(host, "collision");
                selectCollisionMaterial(host, 4);
              }}
            >
              Paint Water
            </button>
            <button type="button" @click=${() => fillGroundBand(host)}>Fill Ground</button>
            <button type="button" @click=${() => paintLevelFromPrompt(host)}>
              Paint Level From Prompt
            </button>
          </div>
        </details>
        <div class="snes-scene-object-palette" aria-label="Pieces to drop">
          ${palettePieces.map(
            (piece) => html`
              <button
                type="button"
                draggable="true"
                @pointerdown=${() => startDraggingPalettePiece(host, piece)}
                @dragstart=${(event: DragEvent) => startDraggingPalettePiece(host, piece, event)}
                @click=${() => {
                  draggedPalettePiece = null;
                  addScenePalettePiece(host, piece.id);
                }}
              >
                <span>${piece.label}</span>
                <small>${piece.detail}. Click or drag into the scene.</small>
              </button>
            `,
          )}
        </div>
        <div class="snes-level-tabs" aria-label="Levels">
          ${project.scenes.map(
            (candidate, index) => html`
              <button
                type="button"
                class=${selectedSceneIndex === index ? "active" : ""}
                @click=${() => {
                  selectedSceneIndex = index;
                  pushConsole(host, `Selected ${candidate.name}.`);
                }}
              >
                ${candidate.name}
              </button>
            `,
          )}
        </div>
        <details class="snes-object-tray-drawer">
          <summary>All things in this level</summary>
          <div class="snes-object-tray" aria-label="Draggable game pieces">
            ${scene.entities.map(
              (entity) => html`
                <button
                  type="button"
                  draggable="true"
                  @dragstart=${() => {
                    draggedEntityId = entity.id;
                    draggedPalettePiece = null;
                  }}
                  @click=${() => selectSceneEntity(host, scene, entity)}
                >
                  <strong>${entity.name}</strong>
                  <span>${sceneEntityCanvasLabel(entity)} at ${entity.x}, ${entity.y}</span>
                </button>
              `,
            )}
          </div>
        </details>
        <details class="snes-advanced-details">
          <summary>Expert Details</summary>
          ${renderLevelPreview(host)} ${renderInspector(host)}
        </details>
      </div>
    </details>
  `;
}

function sceneCellMaterialLabel(material: string) {
  if (material === "ground") return "Ground";
  if (material === "danger") return "Danger";
  if (material === "water") return "Water";
  if (material === "path") return "Path";
  return "Air";
}

function sceneCellMaterial(tile: number, collisionMaterial: SnesCollisionMaterial) {
  if (collisionMaterial === 2) return "danger";
  if (collisionMaterial === 4) return "water";
  if (collisionMaterial === 1 || collisionMaterial === 3) return "ground";
  if (tile > 0) return "path";
  return "air";
}

function renderSceneBuilder(host: HostUpdate) {
  const scene = selectedScene();
  if (!scene) {
    return nothing;
  }
  const palettePieces: Array<{
    id: SnesScenePalettePiece;
    label: string;
    detail: string;
  }> = [
    { id: "hero", label: "Hero", detail: "Start point" },
    { id: "enemy", label: "Enemy", detail: "Challenge" },
    { id: "item", label: "Item", detail: "Reward" },
    { id: "door", label: "Door", detail: "Exit" },
    { id: "goal", label: "Goal", detail: "Win" },
    { id: "guide", label: "Guide", detail: "Hint" },
  ];
  const sceneCells = Array.from({ length: scene.tilemap.length }, (_, index) => {
    const tile = scene.tilemap[index] ?? 0;
    const collisionMaterial = (scene.collisionMap[index] ?? 0) as SnesCollisionMaterial;
    const label = sceneCellMaterial(tile, collisionMaterial);
    const materialLabel = sceneCellMaterialLabel(label);
    return html`
      <button
        type="button"
        class=${`snes-scene-cell snes-scene-cell--${label} tile-${tile}`}
        data-material=${label}
        aria-label=${`${materialLabel} square ${index}. Click to paint ${currentBeginnerBrushLabel()}.`}
        title=${`${materialLabel}. Click to paint ${currentBeginnerBrushLabel()}.`}
        @click=${() => paintSceneCell(host, index)}
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          event.stopPropagation();
          moveEntityToCell(host, index);
        }}
      >
        <span class="snes-scene-cell__motif" aria-hidden="true"></span>
      </button>
    `;
  });
  return html`
    <section class="snes-scene-builder" aria-label="Canvas-first level builder">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Build On The Canvas</span>
          <h3>${scene.name}</h3>
          <p>
            Click any game piece on the canvas to change it. Paint
            ${renderHelpTerm("level-square", "level squares")}, drop game pieces, then test right
            away.
          </p>
        </div>
        <div class="snes-toolbar">
          <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
            Test From Here
          </button>
          <button type="button" @click=${() => addLevel(host)}>Add Level</button>
        </div>
      </div>
      <div class="snes-scene-canvas" aria-label="Game world canvas">
        ${renderCanvasBuildTools(host, palettePieces)} ${renderCanvasNextStep(host, scene)}
        ${renderCanvasActionLoop(host, scene)}
        <div class="snes-scene-stage-wrap">
          <div
            class=${`snes-scene-stage brush-${currentBeginnerBrushId()}${draggedEntityId || draggedPalettePiece ? " is-dragging" : ""}`}
            aria-label="Playable level canvas"
            @dragover=${(event: DragEvent) => event.preventDefault()}
            @drop=${(event: DragEvent) => dropSceneObjectOnStage(host, event)}
          >
            ${sceneCells}
          </div>
          <div class="snes-scene-entity-layer" aria-label="Things on the canvas">
            ${scene.entities.map((entity) => renderCanvasEntity(host, scene, entity))}
            ${renderCanvasInlineAiReview(host, scene)}
          </div>
        </div>
      </div>
      ${renderBuildHelpDrawer(host, scene, palettePieces)}
    </section>
  `;
}

function updateEditableObjectLabel(
  host: HostUpdate,
  object: SnesEditableObjectCard,
  value: string,
) {
  const nextLabel = value.trim();
  if (!nextLabel) {
    pushConsole(host, "Object name cannot be empty.");
    return;
  }
  updateProject(host, (draft) => {
    if (object.kind === "game") {
      draft.name = nextLabel;
      return;
    }
    if (object.kind === "level") {
      const levelIndex = Number(object.id.replace("level:", ""));
      const scene = draft.scenes[levelIndex];
      if (scene) scene.name = nextLabel;
      return;
    }
    if (object.kind === "entity") {
      const [sceneId, entityId] = object.id.split(":");
      const scene = draft.scenes.find((candidate) => candidate.id === sceneId);
      const entity = scene?.entities.find((candidate) => candidate.id === entityId);
      if (entity) entity.name = nextLabel;
      return;
    }
    if (object.kind === "dialogue") {
      const cutscene = draft.dialogue.find((candidate) => candidate.id === object.id);
      if (cutscene) cutscene.name = nextLabel;
      return;
    }
    if (object.kind === "event") {
      const event = draft.events.find((candidate) => candidate.id === object.id);
      if (event) event.name = nextLabel;
      return;
    }
    if (object.kind === "audio") {
      const track = draft.assets.audio.musicTracks.find((candidate) => candidate.id === object.id);
      const effect = draft.assets.audio.soundEffects.find(
        (candidate) => candidate.id === object.id,
      );
      if (track) track.name = nextLabel;
      if (effect) effect.name = nextLabel;
      return;
    }
    if (object.kind === "export") {
      draft.export.romBaseName = nextLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return;
    }
    if (object.kind === "save") {
      draft.save.enabled = true;
    }
  });
  pushConsole(host, `Renamed ${object.label} to ${nextLabel}.`);
}

function renderSelectedObjectEditor(host: HostUpdate, object: SnesEditableObjectCard | undefined) {
  if (!object) {
    return html`
      <aside
        class="snes-selected-object-editor snes-selected-object-editor--empty"
        aria-label="Selected object editor"
      >
        <span class="snes-eyebrow">Clicked Thing</span>
        <h3>Click a game piece to change it</h3>
        <p>
          Click the hero, an enemy, an item, a door, a goal, or a sound. Then ask AI, drag it, or
          test it.
        </p>
      </aside>
    `;
  }
  const surface = selectedObjectPromptSurface(object);
  return html`
    <aside
      class="snes-selected-object-editor snes-selected-object-editor--compact snes-clicked-thing-card"
      aria-label="Selected object editor"
    >
      <div class="snes-selected-object-editor__summary">
        <span class="snes-eyebrow">Clicked Thing</span>
        <h3>${object.label}</h3>
        <p>Tell AI what to change on this one thing, then preview or play it.</p>
      </div>
      <div class="snes-selected-object-editor__scope" role="status">
        <span>Only this thing changes</span>
        <strong>${object.label}</strong>
      </div>
      <label class="snes-selected-object-editor__prompt">
        Tell AI how to change it
        <textarea
          rows="2"
          .value=${surfacePromptDraft(surface)}
          placeholder=${`Make ${object.label} more fun, clearer, or easier to test.`}
          @input=${(event: Event) => updateAiPrompt(surface, inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-toolbar snes-selected-object-editor__actions">
        <button
          type="button"
          class="primary"
          @click=${() => createSelectedObjectChange(host, object)}
        >
          Ask AI to Change
        </button>
        <button type="button" @click=${() => previewSelectedObjectChange(host, object)}>
          Preview First
        </button>
        <button type="button" @click=${() => testGeneratedObject(host, object)}>Play Test</button>
      </div>
      ${renderInlineAiReviewPanel(host, object, "side")}
      <details class="snes-selected-object-editor__details">
        <summary>More options</summary>
        <label class="snes-selected-object-editor__name">
          Rename
          <input
            .value=${object.label}
            @change=${(event: Event) => updateEditableObjectLabel(host, object, inputValue(event))}
          />
        </label>
        <p>${objectCardDisplayKind(object)} · ${objectCardDisplayDetail(object)}</p>
        <div class="snes-selected-object-editor__secondary-actions">
          <button type="button" @click=${() => duplicateGeneratedObject(host, object)}>
            Duplicate
          </button>
          <button
            type="button"
            ?disabled=${undoStack.length === 0}
            @click=${() => undoProjectChange(host)}
          >
            Undo
          </button>
        </div>
      </details>
    </aside>
  `;
}

function renderEditableObjectCards(host: HostUpdate) {
  const cards = createEditableObjectCards();
  const visibleCards = cards.filter(objectCardMatchesFilter).filter(objectCardMatchesSearch);
  const filters: Array<{ id: SnesObjectCardFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "levels", label: "Levels" },
    { id: "characters", label: "Characters" },
    { id: "story", label: "Story" },
    { id: "audio", label: "Audio" },
    { id: "hardware", label: "Hardware" },
  ];
  return html`
    <section class="snes-object-cards snes-generated-inspector" aria-label="Editable game objects">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">All Things</span>
          <h3>Everything AI created</h3>
          <p>
            Use this list when you want to find something by name. The canvas is still the fastest
            way to change level pieces.
          </p>
        </div>
        <button
          type="button"
          @click=${() => undoProjectChange(host)}
          ?disabled=${undoStack.length === 0}
        >
          Undo Last Change
        </button>
      </div>
      <div class="snes-object-card-controls">
        <div class="snes-generated-filter" aria-label="Object card groups">
          ${filters.map(
            (filter) => html`
              <button
                type="button"
                class=${objectCardFilter === filter.id ? "active" : ""}
                @click=${() => {
                  objectCardFilter = filter.id;
                  pushConsole(host, `Showing ${filter.label.toLowerCase()} things.`);
                }}
              >
                ${filter.label}
              </button>
            `,
          )}
        </div>
        <label>
          Find
          <input
            .value=${objectCardSearchDraft}
            placeholder="hero, key, boss, save..."
            @input=${(event: Event) => {
              objectCardSearchDraft = inputValue(event);
              host.requestUpdate?.();
            }}
          />
        </label>
      </div>
      <div class="snes-object-card-grid snes-agent-list">
        ${visibleCards.slice(0, 24).map(
          (object) => html`
            <article
              class=${focusedGeneratedObjectId === object.id ? "active" : ""}
              draggable="true"
              @dragstart=${() => {
                draggedPart = { id: object.id, kind: object.kind, label: object.label };
                draggedEntityId =
                  object.kind === "entity" ? (object.id.split(":").at(-1) ?? null) : null;
                draggedPalettePiece = null;
                pushConsole(host, `Dragging ${object.label}. Drop it on a matching target.`);
              }}
              @dragend=${() => {
                draggedPart = null;
                draggedEntityId = null;
              }}
            >
              <span>${objectCardDisplayKind(object)}</span>
              <strong>${object.label}</strong>
              <p>${objectCardDisplayDetail(object)}</p>
              <div class="snes-toolbar">
                <button
                  type="button"
                  aria-label=${`Edit ${object.label}`}
                  @click=${() => focusGeneratedObject(host, object)}
                >
                  Edit
                </button>
                <button type="button" @click=${() => promptChangeGeneratedObject(host, object)}>
                  Ask AI
                </button>
                <button type="button" @click=${() => duplicateGeneratedObject(host, object)}>
                  Duplicate
                </button>
                <button type="button" @click=${() => testGeneratedObject(host, object)}>
                  Test
                </button>
                <button type="button" @click=${() => deleteGeneratedObject(host, object)}>
                  ${object.kind === "game" ? "Start Blank" : "Delete"}
                </button>
              </div>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderSoundDropZone(host: HostUpdate, key: SnesSoundBindingKey) {
  return html`
    <button
      type="button"
      class="snes-sound-binding"
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        bindDraggedSoundPart(host, key);
      }}
      @click=${() =>
        selectSoundPromptTarget(host, key === "level-music" ? "background-music" : "sound-fx")}
    >
      <span>${soundBindingLabels[key]}</span>
      <strong>${soundBindings[key] ?? "Drop sound here"}</strong>
    </button>
  `;
}

function renderSoundDesk(host: HostUpdate) {
  const manifest = createSnesAudioManifest(project);
  const soundMemoryStatus =
    manifest.warnings.length > 0
      ? "Needs attention"
      : manifest.utilization > 0.86
        ? "Getting full"
        : "Good";
  const promptCards: Array<{ target: SnesCreateTarget; title: string; detail: string }> = [
    {
      target: "background-music",
      title: "Background Music",
      detail: "Mood, tempo, loop, and level assignment.",
    },
    {
      target: "beats-drums",
      title: "Beats / Drums",
      detail: "Rhythm, pulse, noise drums, and intensity.",
    },
    {
      target: "melody-vocal",
      title: "Melody / Vocal-like Lead",
      detail: "Singable hooks, chants, or sample-style lead ideas.",
    },
    {
      target: "sound-fx",
      title: "Sound FX",
      detail: "Jump, pickup, hit, boss, and door sound cues.",
    },
  ];
  return html`
    <section class="snes-sound-desk" aria-label="Sound Desk">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Sound Desk</span>
          <h3>Make music, beats, vocal-like leads, and sound FX by prompt</h3>
          <p>
            Drag sounds onto levels or actions. “Vocals” means vocal-like melodies, chants, leads,
            or sample-style ideas that fit SNES limits.
          </p>
        </div>
        <strong>Sound memory: ${soundMemoryStatus}</strong>
      </div>
      <div class="snes-sound-prompt-grid" aria-label="Sound prompt shortcuts">
        ${promptCards.map(
          (card) => html`
            <button type="button" @click=${() => selectSoundPromptTarget(host, card.target)}>
              <strong>${card.title}</strong>
              <span>${card.detail}</span>
            </button>
          `,
        )}
      </div>
      <div class="snes-sound-bindings" aria-label="Drag sound cards to bind them">
        ${(["level-music", "jump", "pickup", "hit", "boss", "door"] as const).map((key) =>
          renderSoundDropZone(host, key),
        )}
      </div>
      <div class="snes-sound-library" aria-label="Draggable sound library">
        <article>
          <header>
            <strong>Background tracks</strong>
            <button type="button" @click=${() => addMusicTrack(host)}>Add Track</button>
          </header>
          ${project.assets.audio.musicTracks.map(
            (track) => html`
              <button
                type="button"
                draggable="true"
                @dragstart=${() => {
                  draggedPart = { id: track.id, kind: "audio", label: track.name };
                  draggedEntityId = null;
                  draggedPalettePiece = null;
                  pushConsole(host, `Dragging ${track.name}. Drop it on current level music.`);
                }}
                @dragend=${() => {
                  draggedPart = null;
                }}
                @click=${() => {
                  focusedGeneratedObjectId = track.id;
                  selectedCreateTarget = "selected-object";
                  host.requestUpdate?.();
                }}
              >
                <strong>${track.name}</strong>
                <span>${track.tempo} bpm · ${track.patternRows} rows</span>
              </button>
            `,
          )}
        </article>
        <article>
          <header>
            <strong>Sound FX</strong>
            <button type="button" @click=${() => addSoundEffect(host)}>Add SFX</button>
          </header>
          ${project.assets.audio.soundEffects.map(
            (effect) => html`
              <button
                type="button"
                draggable="true"
                @dragstart=${() => {
                  draggedPart = { id: effect.id, kind: "audio", label: effect.name };
                  draggedEntityId = null;
                  draggedPalettePiece = null;
                  pushConsole(host, `Dragging ${effect.name}. Drop it on an action.`);
                }}
                @dragend=${() => {
                  draggedPart = null;
                }}
                @click=${() => {
                  focusedGeneratedObjectId = effect.id;
                  selectedCreateTarget = "selected-object";
                  host.requestUpdate?.();
                }}
              >
                <strong>${effect.name}</strong>
                <span
                  >${effect.steps.length} step${effect.steps.length === 1 ? "" : "s"} · priority
                  ${effect.priority}</span
                >
              </button>
            `,
          )}
        </article>
      </div>
      <div class="snes-toolbar">
        <button
          type="button"
          class="primary"
          @click=${() => createEditableSurfaceFromPrompt(host, "audio")}
        >
          Apply Sound Prompt
        </button>
        <button type="button" @click=${() => previewAgentPatchForSurface(host, "audio")}>
          Preview Sound Change
        </button>
        <button type="button" @click=${() => runSpc700Preview(host)}>Run Sound Preview</button>
      </div>
      ${audioPreviewSummary
        ? html`<p class="snes-sound-summary">${audioPreviewSummary}</p>`
        : nothing}
      <details class="snes-advanced-details">
        <summary>Professional sound details</summary>
        ${renderInspector(host)}
      </details>
    </section>
  `;
}

function renderEditMode(host: HostUpdate) {
  const panelButtons: Array<{ id: SnesStudioPanel; label: string }> = [
    { id: "scene", label: "Level Canvas" },
    { id: "assets", label: "Sound" },
    { id: "story", label: "Story" },
    { id: "logic", label: "Rules" },
    { id: "export", label: "Export Setup" },
  ];
  return html`
    <section class="snes-edit-mode snes-arrange-mode" aria-label="Build game on canvas">
      ${renderAiReviewDrawer(host)}
      <div class="snes-arrange-layout">
        <main class="snes-arrange-canvas" aria-label="Level canvas and editor">
          <div class="snes-build-control-strip" aria-label="Build controls">
            <div class="snes-build-control-strip__copy">
              <span class="snes-eyebrow">Build</span>
              <strong>Use the canvas first. Add, move, ask AI, then play.</strong>
              <small>Switch shelves only when you want sound, story, rules, or export setup.</small>
            </div>
            <div class="snes-build-control-strip__actions">
              <button
                type="button"
                ?disabled=${undoStack.length === 0}
                @click=${() => undoProjectChange(host)}
              >
                Undo
              </button>
              <button
                type="button"
                ?disabled=${redoStack.length === 0}
                @click=${() => redoProjectChange(host)}
              >
                Redo
              </button>
              <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
                Test Game
              </button>
              <details class="snes-safety-menu">
                <summary>Save / recover</summary>
                <button type="button" @click=${() => snapshotProject(host)}>Make Checkpoint</button>
                <button
                  type="button"
                  @click=${() => {
                    showRecoveryPanel = true;
                    host.requestUpdate?.();
                  }}
                >
                  Recover Project
                </button>
              </details>
            </div>
            <div class="snes-editor-panel-rail" aria-label="Editor shelves">
              ${panelButtons.map(
                (panel) => html`
                  <button
                    type="button"
                    class=${selectedPanel === panel.id ? "active" : ""}
                    @click=${() => selectPanel(host, panel.id)}
                  >
                    ${panel.label}
                  </button>
                `,
              )}
            </div>
          </div>
          ${selectedPanel === "scene"
            ? renderSceneBuilder(host)
            : selectedPanel === "assets"
              ? renderSoundDesk(host)
              : renderInspector(host)}
          ${selectedPanel === "scene" ? renderFirstMinuteGuide(host, "build") : nothing}
        </main>
        <aside class="snes-side-editor" aria-label="Selected part editor">
          ${renderSelectedObjectEditor(host, focusedEditableObjectCard())}
          <details class="snes-object-drawer">
            <summary>
              <span>Find by list</span>
              <strong>All Things</strong>
            </summary>
            ${renderEditableObjectCards(host)}
          </details>
        </aside>
        <details class="snes-game-map-drawer">
          <summary>
            <span>All Things Map</span>
            <strong>Open only when you want a list instead of the canvas</strong>
          </summary>
          ${renderGamePartsMap(host, true)}
        </details>
      </div>
      ${projectVersions.length > 0
        ? html`
            <details class="snes-build-recovery-drawer">
              <summary>Checkpoints and recent AI changes</summary>
              ${renderVersionHistory(host)}
              <div class="snes-diff-drawer">${renderDiffTimeline()}</div>
            </details>
          `
        : nothing}
      ${renderRecentActivity()}
    </section>
  `;
}

function renderPlayMode(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  return html`
    <section
      class="snes-play-mode"
      aria-label="Play test game"
      tabindex="-1"
      @keydown=${(event: KeyboardEvent) => handlePlayModeKeydown(host, event)}
      @keyup=${(event: KeyboardEvent) => handlePlayModeKeyup(host, event)}
    >
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Play</span>
          <h3>Test the game now</h3>
          <p>
            ${project.name} · Level ${selectedSceneIndex + 1}/${project.scenes.length} · Run the
            current level, switch scenes, and use simple controller buttons.
          </p>
        </div>
        <strong>Build Readiness: ${readiness.status.toUpperCase()} ${readiness.score}/100</strong>
        <div class="snes-toolbar">
          <button type="button" class="primary" @click=${() => startPreviewPlaytest(host)}>
            Start
          </button>
          <button type="button" @click=${() => resetPreviewPlaytest(host)}>Restart</button>
          <button type="button" @click=${() => selectStudioMode(host, "edit")}>Build Scene</button>
        </div>
      </div>
      <div class="snes-play-path" aria-label="Play loop">
        <span>1. Game</span>
        <span>2. What happened</span>
        <span>3. Change it</span>
      </div>
      ${renderGameTestPanel(host)}
      <div class="snes-play-loop" aria-label="Game, results, and next action">
        ${renderPlayNowCoach(host)} ${renderPlaytestFeedback()}
      </div>
      ${renderFirstMinuteGuide(host, "play")}
      <div class="snes-play-pieces" aria-label="Active game pieces">
        ${selectedScene()?.entities.map((entity) => html`<span>${entity.name}</span>`)}
      </div>
      ${renderPlayRecentDrawer()}
      <details class="snes-advanced-details">
        <summary>Expert Details</summary>
        ${renderRomRuntimeProof()}
      </details>
    </section>
  `;
}

function planProofBlockerWithAi(
  host: HostUpdate,
  proof: "emulator" | "fxpak" | "sram" | "live-agent",
) {
  const prompt =
    proof === "emulator"
      ? "Plan the exact emulator boot proof needed for this SNES game file. Keep the static checks passing, identify supported emulator setup, screenshot evidence, and what remains blocked until a real emulator run exists."
      : proof === "fxpak"
        ? "Plan the exact flash cart export proof for this SNES game. Preserve save memory, require a 128 GB FAT32 microSD card, list the copy destination, free-space checks, and what remains blocked until hardware is mounted."
        : proof === "sram"
          ? "Plan the save memory verification for this SNES game. Keep automatic flash cart save preservation, describe simulator proof, hardware power-cycle proof, and what must be checked before claiming verified saves."
          : "Plan a live OpenClaw/Codex Gateway agent proof for this SNES game builder. Include the session, provider, prompt, returned patch JSON, approval step, and verification evidence.";
  selectedMode = "make";
  selectedCreateTarget = "export";
  updateAiPrompt("export", prompt);
  previewAgentPatchForSurface(host, "export");
  pushConsole(host, `Prepared AI proof plan for ${proof.replace("-", " ")}.`);
}

function renderShipProofPanel(host: HostUpdate) {
  let emulatorProof: ReturnType<typeof createSnesEmulatorBootProof> | null = null;
  let emulatorPlan: ReturnType<typeof createSnesEmulatorBootPlan> | null = null;
  let emulatorReplayProof: ReturnType<typeof createSnesEmulatorReplayParityProof> | null = null;
  let emulatorRunPack: ReturnType<typeof createSnesEmulatorReplayRunPack> | null = null;
  let fxpakStatus = "blocked";
  let fxpakDestination = "Build a preview ROM first.";
  try {
    const artifact = buildSnesPreviewRom(project);
    emulatorPlan = createSnesEmulatorBootPlan(artifact, selectedEmulators());
    emulatorProof = createSnesEmulatorBootProof(artifact, selectedEmulators());
    emulatorReplayProof = createSnesEmulatorReplayParityProof(
      artifact,
      currentRuntimeProject(),
      currentRuntimeReplay(),
      selectedEmulators(),
    );
    emulatorRunPack = createSnesEmulatorReplayRunPack(
      artifact,
      currentRuntimeProject(),
      currentRuntimeReplay(),
      selectedEmulators(),
    );
    const fxpakPackage = createSnesFxpakExportPackage(artifact);
    const mounted = createSnesFxpakMountedExportValidation(fxpakPackage, fxpakProbe);
    fxpakStatus = mounted.status;
    fxpakDestination = mounted.destinationRomPath;
  } catch (error) {
    fxpakDestination = error instanceof Error ? error.message : "Preview ROM cannot be built.";
  }
  return html`
    <details class="snes-ship-proof" open>
      <summary>
        Emulator, flash cart ${renderHelpTerm("flash-cart")}, and save memory
        ${renderHelpTerm("save-memory")} proof
      </summary>
      <div class="snes-ship-proof__grid">
        <article>
          <strong>Emulator boot proof</strong>
          <label>
            Available emulators
            <input
              placeholder="ares, bsnes, mesen, snes9x"
              .value=${emulatorSelectionDraft}
              @input=${(event: Event) => {
                emulatorSelectionDraft = inputValue(event);
                host.requestUpdate?.();
              }}
            />
          </label>
          <div class="snes-inspector__grid">
            <span>Status</span><strong>${emulatorProof?.status ?? "blocked"}</strong>
            <span>Command</span><strong>${emulatorPlan?.command.join(" ") || "not ready"}</strong>
            <span>Screenshot</span
            ><strong>${emulatorPlan?.screenshotFileName ?? "not ready"}</strong>
            <span>Replay parity</span><strong>${emulatorReplayProof?.status ?? "blocked"}</strong>
            <span>Run script</span><strong>${emulatorRunPack?.status ?? "blocked"}</strong>
            <span>Expected state</span
            ><strong>${emulatorReplayProof?.evidence.browserFinalStateHash ?? "not ready"}</strong>
          </div>
          ${emulatorRunPack
            ? html`
                <div
                  class=${`snes-emulator-run-pack snes-emulator-run-pack--${emulatorRunPack.status}`}
                  aria-label="Emulator proof run pack"
                >
                  <strong>
                    ${emulatorRunPack.status === "ready"
                      ? "Ready to run local emulator proof"
                      : "Emulator run is blocked"}
                  </strong>
                  <small>
                    ${emulatorRunPack.status === "ready"
                      ? `${emulatorRunPack.selectedEmulator} will boot ${emulatorRunPack.romFileName} and capture screenshot proof. Expected state ${emulatorRunPack.expectedFinalStateHash}.`
                      : (emulatorRunPack.blockers[0] ??
                        "Add an emulator name above to create the run script.")}
                  </small>
                  ${emulatorRunPack.command.length > 0
                    ? html`<code>${emulatorRunPack.command.join(" ")}</code>`
                    : nothing}
                </div>
              `
            : nothing}
          <button type="button" @click=${() => downloadEmulatorProof(host)}>
            Export Emulator Proof
          </button>
          <button type="button" @click=${() => downloadEmulatorRunScript(host)}>
            Download Emulator Run Script
          </button>
          <button type="button" @click=${() => planProofBlockerWithAi(host, "emulator")}>
            Plan Emulator Fix with AI
          </button>
        </article>
        <article>
          <strong>Flash cart proof ${renderHelpTerm("flash-cart")}</strong>
          <label class="snes-checkbox">
            <input
              type="checkbox"
              .checked=${fxpakProbe.mounted}
              @change=${(event: Event) => {
                fxpakProbe = {
                  ...fxpakProbe,
                  mounted: (event.currentTarget as HTMLInputElement).checked,
                };
                host.requestUpdate?.();
              }}
            />
            Card mounted
          </label>
          <label>
            Volume path
            <input
              .value=${fxpakProbe.volumePath}
              placeholder="/Volumes/FXPAKPRO"
              @input=${(event: Event) => {
                fxpakProbe = { ...fxpakProbe, volumePath: inputValue(event) };
                host.requestUpdate?.();
              }}
            />
          </label>
          <label>
            Free bytes
            <input
              type="number"
              min="0"
              .value=${String(fxpakProbe.freeBytes)}
              @input=${(event: Event) => {
                fxpakProbe = { ...fxpakProbe, freeBytes: inputNumber(event) };
                host.requestUpdate?.();
              }}
            />
          </label>
          <div class="snes-inspector__grid">
            <span>Status</span><strong>${fxpakStatus}</strong> <span>Destination</span
            ><strong>${fxpakDestination}</strong>
          </div>
          <button type="button" @click=${() => downloadFxpakPackagePlan(host)}>
            Export Flash Cart Package
          </button>
          <button type="button" @click=${() => planProofBlockerWithAi(host, "fxpak")}>
            Plan Flash Cart Fix with AI
          </button>
        </article>
        <article>
          <strong>Save memory proof ${renderHelpTerm("save-memory")}</strong>
          <p>${sramSimulationSummary || "Run the simulator before real hardware proof."}</p>
          <div class="snes-toolbar">
            <button type="button" @click=${() => simulateSramSaveLoad(host)}>
              Save Memory Simulator
            </button>
            <button type="button" @click=${() => downloadHardwareQaBundle(host)}>
              Export QA Bundle
            </button>
            <button type="button" @click=${() => planProofBlockerWithAi(host, "sram")}>
              Plan Save Fix with AI
            </button>
          </div>
        </article>
        <article>
          <strong>Live OpenClaw/Codex proof</strong>
          ${(() => {
            const readiness = probeSnesLiveAiReadiness(host);
            return html`<p>${readiness.title}. ${readiness.detail}</p>`;
          })()}
          <p>${liveAgentProofState.title}. ${liveAgentProofState.detail}</p>
          <div class="snes-inspector__grid">
            <span>Gateway</span
            ><strong
              >${probeSnesLiveAiReadiness(host).gatewayConnected
                ? "connected"
                : "not connected"}</strong
            >
            <span>Auth</span
            ><strong
              >${probeSnesLiveAiReadiness(host).authenticated ? "ready" : "needs setup"}</strong
            >
            <span>Proof</span><strong>${liveAgentProofState.status}</strong>
            <span>Queued tasks</span><strong>${agentDispatchQueue.length}</strong>
            <span>Returned patches</span><strong>${agentResultQueue.length}</strong>
          </div>
          <div class="snes-toolbar">
            <button
              type="button"
              class="primary"
              ?disabled=${liveAgentProofState.status === "running"}
              @click=${() => void runLiveAgentProof(host)}
            >
              ${liveAgentProofState.status === "running"
                ? "Checking Live Agent"
                : "Run Live Agent Proof"}
            </button>
            <button
              type="button"
              ?disabled=${liveAgentProofState.status === "running"}
              @click=${() => void runLocalAgentProof(host)}
            >
              Run Local Agent Proof
            </button>
            <button type="button" @click=${() => planProofBlockerWithAi(host, "live-agent")}>
              Plan Live Agent Proof with AI
            </button>
          </div>
        </article>
      </div>
    </details>
  `;
}

function renderShipMode(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  const manifest = createFxpakExportManifest(project);
  return html`
    <section class="snes-ship-mode" aria-label="Export SNES game">
      <div class="snes-section-header">
        <div>
          <span class="snes-eyebrow">Export</span>
          <h3>
            ${readiness.status === "ready"
              ? "Ready to make the SNES game file"
              : "Needs fixes before hardware"}
          </h3>
          <p>${manifest.romPath} ${renderHelpTerm("snes-game-file")}</p>
        </div>
        <strong>${readiness.status.toUpperCase()} ${readiness.score}/100</strong>
      </div>
      <div class="snes-ship-actions">
        <button type="button" class="primary" @click=${() => downloadPreviewRom(host)}>
          Build Preview SNES Game File
        </button>
        <button
          type="button"
          @click=${() =>
            pushConsole(host, `Validated ${manifest.romFileName}: ${readiness.status}.`)}
        >
          Validate SNES Game File
        </button>
        <button type="button" @click=${() => downloadFxpakPackagePlan(host)}>
          Export Flash Cart Package
        </button>
        <button type="button" @click=${() => downloadRomMap(host)}>Export Expert File Map</button>
        <button type="button" @click=${() => downloadEmulatorProof(host)}>
          Export Emulator Proof
        </button>
        <button type="button" @click=${() => downloadHardwareQaBundle(host)}>
          Export QA Bundle
        </button>
      </div>
      <div class="snes-budget-strip">${readiness.budgets.map(renderMeter)}</div>
      ${renderShipProofPanel(host)}
      <details class="snes-advanced-details" open>
        <summary>Expert Details</summary>
        ${renderInspector(host)}
      </details>
      ${renderRecentActivity()}
    </section>
  `;
}

function renderCurrentStudioMode(host: HostUpdate) {
  if (selectedMode === "edit") return renderEditMode(host);
  if (selectedMode === "play") return renderPlayMode(host);
  if (selectedMode === "ship") return renderShipMode(host);
  return renderMakeMode(host);
}

function renderAgentConnectionSummary(host: HostUpdate) {
  const readiness = probeSnesLiveAiReadiness(host);
  const gatewayStatus = readiness.status === "ready" ? "Gateway live ready" : readiness.title;
  return html`
    <div class="snes-agent-connection" aria-label="OpenClaw and Codex connection status">
      <article>
        <span>OpenClaw</span>
        <strong>${gatewayStatus}</strong>
        <small>${agentDispatchQueue.length} queued</small>
      </article>
      <article>
        <span>Codex</span>
        <strong>${gatewayStatus}</strong>
        <small>${agentResultQueue.length} result${agentResultQueue.length === 1 ? "" : "s"}</small>
      </article>
      <article>
        <span>Approval</span>
        <strong>${pendingAgentProposal ? "Patch ready" : "Direct create ready"}</strong>
        <small
          >${aiProviderBySurface["full-game"] === "openclaw"
            ? "OpenClaw selected"
            : "Codex selected"}</small
        >
      </article>
      <article class="snes-agent-session">
        <label>
          <span>Gateway session</span>
          <input
            aria-label="Gateway agent session"
            .value=${agentGatewaySessionKey}
            @input=${(event: Event) => updateAgentGatewaySessionKey(host, inputValue(event))}
          />
        </label>
        <small>Used by Send to Gateway Agent.</small>
      </article>
      <article class=${`snes-agent-proof snes-agent-proof--${liveAgentProofState.status}`}>
        <span>Live proof</span>
        <strong>${liveAgentProofState.title}</strong>
        <small>${readiness.detail} ${liveAgentProofState.detail}</small>
        <button
          type="button"
          ?disabled=${liveAgentProofState.status === "running"}
          @click=${() => void runLiveAgentProof(host)}
        >
          ${liveAgentProofState.status === "running"
            ? "Checking live agent"
            : "Run Live Agent Proof"}
        </button>
        <button
          type="button"
          ?disabled=${liveAgentProofState.status === "running"}
          @click=${() => void runLocalAgentProof(host)}
        >
          Run Local Agent Proof
        </button>
      </article>
    </div>
  `;
}

function renderButtonAuditPanel() {
  return html`
    <div class="snes-button-audit" aria-label="Critical button health">
      <div class="snes-button-audit__title">
        <strong>Critical button health</strong>
        <small>Every major action is labeled as verified, tested, or blocked.</small>
      </div>
      ${buttonAuditItems.map(
        (item) => html`
          <article class=${`snes-button-audit__item snes-button-audit__item--${item.status}`}>
            <span>${item.status}</span>
            <strong>${item.label}</strong>
            <small>${item.evidence}</small>
          </article>
        `,
      )}
    </div>
  `;
}

function renderQuickCreatePanel(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  const manifest = createFxpakExportManifest(project);
  const checklist = createSnesGuidedBuildChecklist(project);
  const fullGamePrompt =
    createSnesAiAuthoringPrompts(project).find((entry) => entry.surface === "full-game")
      ?.placeholder ?? "Create a complete SNES game.";
  const selectedProvider = aiProviderBySurface["full-game"];
  const templates = createSnesProjectTemplates();
  const aiBuildPlan = createSnesAiBuildPlan(project);
  return html`
    <section class="snes-start-panel">
      <div class="snes-start-panel__create">
        <div class="snes-section-header">
          <div>
            <span class="snes-eyebrow">Start Here</span>
            <h3>Create the whole game from one prompt</h3>
          </div>
          <strong>${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}</strong>
        </div>
        <label>
          Game prompt
          <textarea
            rows="4"
            .value=${surfacePromptDraft("full-game") || fullGamePrompt}
            placeholder=${fullGamePrompt}
            @input=${(event: Event) => updateAiPrompt("full-game", inputValue(event))}
          ></textarea>
        </label>
        <div class="snes-prompt-chips" aria-label="Beginner prompt ideas">
          ${beginnerPromptChips.map(
            (chip) => html`
              <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
                ${chip.label}
              </button>
            `,
          )}
        </div>
        <div class="snes-provider-toggle" aria-label="Quick Create AI provider">
          ${(["openclaw", "codex"] as const).map(
            (provider) => html`
              <button
                type="button"
                class=${selectedProvider === provider ? "active" : ""}
                @click=${() => setAiProvider(host, "full-game", provider)}
              >
                ${provider === "openclaw" ? "OpenClaw" : "Codex"}
              </button>
            `,
          )}
        </div>
        ${renderAgentConnectionSummary(host)} ${renderButtonAuditPanel()}
        <div class="snes-toolbar">
          <button
            type="button"
            class="primary snes-send-command"
            @click=${() => createGameFromPrompt(host)}
          >
            Create Game with ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}
          </button>
          <button type="button" class="primary" @click=${() => finishPlayableDraft(host)}>
            Export Playable Draft
          </button>
          <button type="button" @click=${() => startPreviewPlaytest(host)}>Test Game</button>
          <button type="button" @click=${() => previewAgentPatchForSurface(host, "full-game")}>
            Create Game Preview
          </button>
          <button type="button" @click=${() => createAndBuildPreviewRom(host)}>
            Create + Build ROM
          </button>
          <button type="button" @click=${() => dispatchCodexTask(host, "full-game")}>
            Queue ${selectedProvider === "openclaw" ? "OpenClaw" : "Codex"}
          </button>
          <button type="button" @click=${() => sendAiPrompt(host, "full-game")}>
            Ask Gateway Agent
          </button>
          <button type="button" @click=${() => selectPanel(host, "prompt")}>All AI Tools</button>
          <button type="button" @click=${() => startBlankProject(host)}>Start Blank</button>
        </div>
      </div>
      <div class="snes-start-panel__status">
        <article>
          <span>Project</span>
          <strong>${project.name}</strong>
        </article>
        <article>
          <span>Readiness</span>
          <strong>${readiness.status.toUpperCase()} ${readiness.score}/100</strong>
        </article>
        <article>
          <span>ROM</span>
          <strong>${manifest.romFileName}</strong>
        </article>
        <article>
          <span>FXPAK</span>
          <strong>${manifest.cardSizeGb} GB FAT32</strong>
        </article>
      </div>
      <div class="snes-start-panel__flow">
        <button type="button" @click=${() => selectPanel(host, "scene")}>
          <strong>Edit Level</strong>
          <span>${project.scenes.length} level${project.scenes.length === 1 ? "" : "s"}</span>
        </button>
        <button type="button" @click=${() => selectPanel(host, "assets")}>
          <strong>Import Art</strong>
          <span>${project.assets.importedTilesets.length} tilesets</span>
        </button>
        <button type="button" @click=${() => selectPanel(host, "logic")}>
          <strong>Events</strong>
          <span>${project.events.length} scripts</span>
        </button>
        <button type="button" @click=${() => downloadPreviewRom(host)}>
          <strong>Build ROM</strong>
          <span>${readiness.status}</span>
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host)}>
          <strong>Test Game</strong>
          <span>${previewSimulationState ? "running" : "ready"}</span>
        </button>
        <button type="button" @click=${() => repairPlayablePreview(host)}>
          <strong>Make Playable</strong>
          <span>AI repair</span>
        </button>
      </div>
      ${renderBeginnerWizard(host)} ${renderLegacyGamePartsMap(host)}
      <div class="snes-ai-build-flow">
        <div class="snes-section-header">
          <div>
            <span class="snes-eyebrow">Build With AI</span>
            <strong>Prompt every game part, then edit it</strong>
            <p>
              Start from nothing, generate the full game or one component at a time, and jump
              straight into the editor for each generated result.
            </p>
          </div>
          <button type="button" @click=${() => startBlankProject(host)}>Start Blank</button>
        </div>
        <div class="snes-ai-stage-list">
          ${aiBuildPlan.map(
            (stage) => html`
              <article class=${`snes-ai-stage snes-ai-stage--${stage.status}`}>
                <span>${stage.status}</span>
                <strong>${stage.title}</strong>
                <p>${stage.promptGoal}</p>
                <small>${stage.acceptance}</small>
                <em>${stage.dragDropHint}</em>
                <div class="snes-toolbar">
                  <button
                    type="button"
                    class=${stage.status === "recommended"
                      ? "primary snes-send-command"
                      : "snes-send-command"}
                    @click=${() =>
                      stage.surface === "full-game"
                        ? createGameFromPrompt(host)
                        : createEditableSurfaceFromPrompt(host, stage.surface)}
                  >
                    ${stage.surface === "full-game" ? "Create Game" : "Create & Edit"}
                  </button>
                  <button
                    type="button"
                    @click=${() => previewAgentPatchForSurface(host, stage.surface)}
                  >
                    Generate ${stage.surface === "full-game" ? "Entire Game" : stage.surface}
                  </button>
                  <button type="button" @click=${() => dispatchCodexTask(host, stage.surface)}>
                    Queue
                    ${aiProviderBySurface[stage.surface] === "openclaw" ? "OpenClaw" : "Codex"}
                  </button>
                  <button type="button" @click=${() => sendAiPrompt(host, stage.surface)}>
                    Ask Gateway
                  </button>
                  ${stage.surface === "level"
                    ? html`
                        <button type="button" @click=${() => paintLevelFromPrompt(host)}>
                          Paint Level From Prompt
                        </button>
                      `
                    : nothing}
                  <button type="button" @click=${() => selectPanel(host, stage.editPanel)}>
                    Edit Generated
                  </button>
                </div>
              </article>
            `,
          )}
        </div>
      </div>
      ${renderGeneratedObjectInspector(host)}
      <div class="snes-template-gallery">
        <div class="snes-section-header">
          <div>
            <strong>Templates</strong>
            <p>Start fast, then edit everything.</p>
          </div>
        </div>
        <label class="snes-template-gallery__detail">
          Template details
          <input
            .value=${templateDetailDraft}
            @input=${(event: Event) => {
              templateDetailDraft = inputValue(event);
              host.requestUpdate?.();
            }}
          />
        </label>
        ${templates.map(
          (template) => html`
            <button type="button" @click=${() => applyProjectTemplate(host, template.id)}>
              <strong>${template.name}</strong>
              <span>${template.status === "ready" ? "Ready" : "Concept blocked"}</span>
              <small>${template.summary}</small>
            </button>
          `,
        )}
      </div>
      <div class="snes-guided-checklist">
        <div class="snes-section-header">
          <div>
            <strong>Next Steps</strong>
            <p>Follow these in order to get to hardware proof.</p>
          </div>
        </div>
        ${checklist.map(
          (item) => html`
            <article class=${`snes-check-item snes-check-item--${item.status}`}>
              <span>${item.status}</span>
              <strong>${item.label}</strong>
              <p>${item.detail}</p>
              <small>${item.nextAction}</small>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

export function renderSnesStudioLegacy(host: HostUpdate = {}) {
  ensureAgentResultListener(host);
  ensureKeyboardShortcuts(host);
  const readiness = buildSnesReadiness(project);
  const manifest = createFxpakExportManifest(project);
  const pipeline = createSnesBuildPipeline(project);
  return html`
    <div class="snes-studio">
      <section class="snes-hero">
        <div>
          <span class="snes-eyebrow">OpenClaw SNES Studio</span>
          <h2>Full SNES editor workbench</h2>
          <p>
            Build a hardware-true LoROM platformer slice, keep SNES budgets visible, and prepare
            FXPAK PRO exports without risking SRAM data.
          </p>
        </div>
        <div class="snes-hero__actions">
          <button type="button" @click=${() => snapshotProject(host)}>Snapshot</button>
          <button
            type="button"
            @click=${() => {
              showRecoveryPanel = true;
              host.requestUpdate?.();
            }}
          >
            Recovery
          </button>
          <button
            type="button"
            ?disabled=${undoStack.length === 0}
            @click=${() => undoProjectChange(host)}
          >
            Undo
          </button>
          <button
            type="button"
            ?disabled=${redoStack.length === 0}
            @click=${() => redoProjectChange(host)}
          >
            Redo
          </button>
          <button type="button" @click=${() => downloadProjectJson(host)}>
            Export Project JSON
          </button>
          <button type="button" @click=${() => downloadProjectBundle(host)}>
            Export Project Bundle
          </button>
          <button type="button" @click=${() => downloadPreviewRom(host)}>Build Preview ROM</button>
          <button type="button" @click=${() => startPreviewPlaytest(host)}>Test Game</button>
          <button type="button" @click=${() => downloadRomMap(host)}>Export ROM Map</button>
          <button type="button" @click=${() => downloadBuildManifest(host)}>
            Export Build Manifest
          </button>
          <button type="button" @click=${() => downloadEmulatorProof(host)}>
            Export Emulator Proof
          </button>
          <button type="button" @click=${() => downloadFxpakPackagePlan(host)}>
            Export FXPAK Package
          </button>
          <button
            type="button"
            class="primary"
            @click=${() =>
              pushConsole(host, `Validated ${manifest.romFileName}: ${readiness.status}.`)}
          >
            Validate Build
          </button>
        </div>
      </section>

      ${renderRecoveryPanel(host)} ${renderQuickCreatePanel(host)}

      <section class="snes-command-palette" aria-label="SNES Studio command palette">
        <button
          type="button"
          aria-keyshortcuts="Control+B Meta+B"
          class="primary snes-send-command"
          @click=${() => createGameFromPrompt(host)}
        >
          Create Game From Prompt
          <small>Ctrl+B</small>
        </button>
        <button
          type="button"
          aria-keyshortcuts="Control+Shift+B Meta+Shift+B"
          @click=${() => finishPlayableDraft(host)}
        >
          Export Playable Draft
          <small>Ctrl+Shift+B</small>
        </button>
        <button type="button" @click=${() => selectPanel(host, "scene")}>Edit Current Level</button>
        <button type="button" @click=${() => selectPanel(host, "assets")}>Open Asset Tools</button>
        <button type="button" @click=${() => selectPanel(host, "export")}>
          Open Hardware Proof
        </button>
        <button type="button" @click=${() => downloadHardwareQaBundle(host)}>
          Export QA Bundle
        </button>
        <button
          type="button"
          aria-keyshortcuts="Control+K Meta+K"
          @click=${() => selectPanel(host, "prompt")}
        >
          AI Creator
          <small>Ctrl+K</small>
        </button>
      </section>

      <section class="snes-budget-strip">${readiness.budgets.map(renderMeter)}</section>

      <main class="snes-workspace">
        <aside class="snes-assets">
          <div class="snes-section-header">
            <div>
              <h3>Project Kit</h3>
              <p>v0.1 vertical slice</p>
            </div>
          </div>
          <button type="button" @click=${() => selectPanel(host, "scene")}>Level Editor</button>
          <button type="button" @click=${() => selectPanel(host, "prompt")}>Text Generator</button>
          <button type="button" @click=${() => addLevel(host)}>Add Level</button>
          <button type="button" @click=${() => selectPanel(host, "assets")}>
            Tiles and Palettes
          </button>
          <button type="button" @click=${() => selectPanel(host, "scene")}>
            Sprites and Entities
          </button>
          <button type="button" @click=${() => selectPanel(host, "story")}>
            Dialogue and Cutscenes
          </button>
          <button type="button" @click=${() => selectPanel(host, "logic")}>Events and Logic</button>
          <button type="button" @click=${() => selectPanel(host, "export")}>FXPAK Export</button>
          <button type="button" @click=${() => selectPanel(host, "agents")}>OpenClaw Agents</button>
          <button type="button" class="danger" @click=${() => resetProject(host)}>
            Reset Starter
          </button>
          ${lastSnapshotAt
            ? html`<p class="snes-muted">Last snapshot: ${lastSnapshotAt}</p>`
            : nothing}
          ${projectVersions.length > 0
            ? html`
                <div class="snes-agent-list">
                  <article>
                    <span>Version History</span>
                    <strong>${projectVersions.length} saved</strong>
                    ${projectVersions
                      .slice(0, 3)
                      .map(
                        (version) => html`
                          <button
                            type="button"
                            @click=${() => restoreProjectVersion(host, version)}
                          >
                            ${version.reason} · ${version.projectName}
                          </button>
                        `,
                      )}
                  </article>
                </div>
              `
            : nothing}
          ${renderDiffTimeline()}
        </aside>

        ${renderLevelPreview(host)} ${renderInspector(host)}
      </main>

      <section class="snes-bottom">
        <div class="snes-pipeline">
          <div class="snes-section-header">
            <div>
              <h3>Build Pipeline</h3>
              <p>Deterministic ROM path from project schema to FXPAK PRO deployment.</p>
            </div>
          </div>
          ${pipeline.map(
            (step, index) => html`
              <article>
                <span>${index + 1}</span>
                <div>
                  <strong>${step.label}</strong>
                  <p>${step.description}</p>
                </div>
              </article>
            `,
          )}
        </div>
        <div class="snes-console">
          <div class="snes-section-header">
            <div>
              <h3>Build Console</h3>
              <p>${manifest.romPath}</p>
            </div>
          </div>
          ${consoleLines.map((line) => html`<code>${line}</code>`)}
        </div>
      </section>
    </div>
  `;
}

function renderAdvancedWorkbench(host: HostUpdate = {}) {
  const readiness = buildSnesReadiness(project);
  const manifest = createFxpakExportManifest(project);
  const pipeline = createSnesBuildPipeline(project);
  const assetPipeline = createSnesAssetPipelineReport(project);
  const audio = createSnesSpc700ExportPlan(project);
  const superFx = createSnesSuperFxProfileReport(project);
  const saveManifest = createSnesSaveManifest(project);
  return html`
    <div class="snes-pro-drawers">
      <details class="snes-pro-drawer" open>
        <summary>Project Safety</summary>
        <div class="snes-toolbar">
          <button type="button" @click=${() => snapshotProject(host)}>Snapshot</button>
          <button
            type="button"
            ?disabled=${undoStack.length === 0}
            @click=${() => undoProjectChange(host)}
          >
            Undo
          </button>
          <button
            type="button"
            ?disabled=${redoStack.length === 0}
            @click=${() => redoProjectChange(host)}
          >
            Redo
          </button>
          <button type="button" @click=${() => downloadProjectJson(host)}>
            Export Project JSON
          </button>
          <button type="button" @click=${() => downloadProjectBundle(host)}>
            Export Project Bundle
          </button>
        </div>
      </details>
      <details class="snes-pro-drawer">
        <summary>Agent Details</summary>
        ${renderAgentConnectionSummary(host)} ${renderButtonAuditPanel()}
      </details>
      <details class="snes-pro-drawer">
        <summary>Hardware Budgets</summary>
        <div class="snes-budget-strip">${readiness.budgets.map(renderMeter)}</div>
      </details>
      <details class="snes-pro-drawer">
        <summary>Build Console</summary>
        <div class="snes-pipeline">
          ${pipeline.map(
            (step, index) => html`
              <article>
                <span>${index + 1}</span>
                <div>
                  <strong>${step.label}</strong>
                  <p>${step.description}</p>
                </div>
              </article>
            `,
          )}
        </div>
        <div class="snes-console">${consoleLines.map((line) => html`<code>${line}</code>`)}</div>
      </details>
      <details class="snes-pro-drawer">
        <summary>ROM Manifest</summary>
        <div class="snes-inspector__grid">
          <span>ROM path</span><strong>${manifest.romPath}</strong> <span>ROM file</span
          ><strong>${manifest.romFileName}</strong> <span>SRAM path</span
          ><strong>${manifest.savePath ?? "disabled"}</strong> <span>FXPAK card</span
          ><strong>${manifest.cardSizeGb} GB ${manifest.requiredFileSystem}</strong>
          <span>SuperFX</span><strong>${superFx.status}</strong>
        </div>
        <div class="snes-toolbar">
          <button type="button" @click=${() => downloadPreviewRom(host)}>Build Preview ROM</button>
          <button type="button" @click=${() => downloadRomMap(host)}>Export ROM Map</button>
          <button type="button" @click=${() => downloadBuildManifest(host)}>
            Export Build Manifest
          </button>
        </div>
      </details>
      <details class="snes-pro-drawer">
        <summary>Asset Pipeline</summary>
        <div class="snes-inspector__grid">
          <span>Imported tilesets</span><strong>${project.assets.importedTilesets.length}</strong>
          <span>CHR bytes</span><strong>${formatBytes(assetPipeline.importedChrBytes)}</strong>
          <span>Audio ARAM</span
          ><strong
            >${formatBytes(
              audio.aramMap.reduce((sum, section) => sum + section.sizeBytes, 0),
            )}</strong
          >
          <span>SPC700 status</span><strong>${audio.status}</strong> <span>Pipeline checks</span
          ><strong>${assetPipeline.checks.length}</strong>
        </div>
        <div class="snes-toolbar">
          <button type="button" @click=${() => selectPanel(host, "assets")}>
            Open Asset Tools
          </button>
          <button type="button" @click=${() => runSpc700Preview(host)}>SPC700 Sound Test</button>
        </div>
      </details>
      <details class="snes-pro-drawer">
        <summary>Emulator Proof</summary>
        ${renderRomRuntimeProof()}
        <div class="snes-toolbar">
          <button type="button" @click=${() => downloadEmulatorProof(host)}>
            Export Emulator Proof
          </button>
          <button type="button" @click=${() => downloadHardwareQaBundle(host)}>
            Export QA Bundle
          </button>
        </div>
      </details>
      <details class="snes-pro-drawer">
        <summary>FXPAK Export</summary>
        <div class="snes-inspector__grid">
          <span>SRAM</span
          ><strong>${saveManifest.enabled ? `${saveManifest.sramSizeKib} KiB` : "disabled"}</strong>
          <span>Save slots</span><strong>${project.save.slots}</strong> <span>Destination</span
          ><strong>${manifest.romPath}</strong> <span>Preserve saves</span
          ><strong>${project.profile.fxpak.preserveExistingSaves ? "yes" : "no"}</strong>
        </div>
        <div class="snes-toolbar">
          <button type="button" @click=${() => downloadFxpakPackagePlan(host)}>
            Export FXPAK Package
          </button>
          <button type="button" @click=${() => simulateSramSaveLoad(host)}>
            SRAM Save Simulator
          </button>
          <button type="button" @click=${() => selectPanel(host, "export")}>
            Open Export Details
          </button>
        </div>
      </details>
      <details class="snes-pro-drawer">
        <summary>Generated Object Audit</summary>
        ${renderGeneratedObjectInspector(host)}
      </details>
    </div>
  `;
}

function renderAiStagePrompt(host: HostUpdate) {
  const selected = selectedSceneThing();
  const surface = aiGameStageSurface();
  const prompt = aiGameStagePromptDraft();
  const resolvedProvider = aiGameStageResolvedProvider(surface);
  return html`
    <section class="snes-ai-stage-ask" aria-label="Ask AI to make or change the game">
      <div class="snes-ai-stage-ask__copy">
        <span class="snes-eyebrow">Ask AI</span>
        <h2>${selected ? `Change ${selected.entity.name}` : "What game do you want to make?"}</h2>
        <p>
          ${selected
            ? `This prompt changes only the selected ${selectedThingLabel(selected.entity).toLowerCase()}.`
            : "Describe the whole game. AI makes it playable, then you click anything to change it."}
        </p>
      </div>
      <label class="snes-ai-stage-ask__prompt">
        <span>${aiGameStagePromptLabel()}</span>
        <textarea
          rows="3"
          .value=${prompt}
          placeholder=${aiGameStagePromptPlaceholder()}
          @input=${(event: Event) => updateAiGameStagePrompt(inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-ai-stage-provider" aria-label="Choose who helps">
        ${(["auto-team", "openclaw", "codex"] as const).map(
          (provider) => html`
            <button
              type="button"
              class=${aiGameStageProvider === provider ? "active" : ""}
              aria-pressed=${aiGameStageProvider === provider ? "true" : "false"}
              @click=${() => setAiGameStageProvider(host, provider)}
            >
              ${aiGameStageProviderLabel(provider)}
            </button>
          `,
        )}
      </div>
      <div class="snes-ai-stage-ask__actions">
        <button type="button" class="primary" @click=${() => runAiGameStageCommand(host)}>
          ${selected ? "Change This Thing" : "Build My Game"}
        </button>
        <button type="button" @click=${() => void askAiGameStageLiveAgent(host)}>
          Ask Live OpenClaw
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host, true, true)}>
          Test Now
        </button>
        <button
          type="button"
          ?disabled=${undoStack.length === 0}
          @click=${() => undoProjectChange(host)}
        >
          Undo
        </button>
      </div>
      <div class="snes-ai-stage-chips" aria-label="Starter ideas">
        ${beginnerPromptChips.map(
          (chip) => html`
            <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
              ${chip.label}
            </button>
          `,
        )}
      </div>
      <small>
        Using ${aiGameStageProviderLabel()}.
        ${aiGameStageProvider === "auto-team"
          ? `Auto Team will use ${resolvedProvider === "openclaw" ? "OpenClaw" : "Codex"} for this scope.`
          : resolvedProvider === "openclaw"
            ? "OpenClaw handles this creative change; Codex stays off unless a review/export gate needs it."
            : "Codex will be used for this review/export gate."}
        ${isGatewayLiveReady(host)
          ? " Live agent preview is connected."
          : " Live agent preview needs a connected Dashboard Gateway session; Build My Game works now."}
      </small>
      ${liveAgentProofState.status !== "idle"
        ? html`
            <div
              class=${`snes-ai-stage-live-proof snes-ai-stage-live-proof--${liveAgentProofState.status}`}
              role=${liveAgentProofState.status === "failed" ? "alert" : "status"}
              aria-live="polite"
            >
              <strong>${liveAgentProofState.title}</strong>
              <span>${liveAgentProofState.detail}</span>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderAiQuickPieces(host: HostUpdate) {
  const pieces: Array<{ kind: SnesScenePalettePiece; label: string; detail: string }> = [
    { kind: "hero", label: "Hero", detail: "player start" },
    { kind: "enemy", label: "Enemy", detail: "moving challenge" },
    { kind: "item", label: "Item", detail: "reward or key" },
    { kind: "door", label: "Door", detail: "level exit" },
    { kind: "goal", label: "Goal", detail: "finish point" },
    { kind: "guide", label: "Guide", detail: "helpful hint" },
  ];
  return html`
    <section class="snes-ai-piece-dock" aria-label="Drag things into the game">
      <div>
        <strong>Drag Into Game</strong>
        <span>Drop a thing onto the playable scene, or click to add it.</span>
      </div>
      <div class="snes-ai-piece-dock__list">
        ${pieces.map(
          (piece) => html`
            <button
              type="button"
              class=${`snes-canvas-piece-shelf__piece snes-canvas-piece-shelf__piece--${piece.kind}`}
              draggable="true"
              @pointerdown=${() => {
                draggedPalettePiece = piece.kind;
                draggedGuidedThingKind = null;
                draggedEntityId = null;
                draggedPart = null;
              }}
              @dragstart=${(event: DragEvent) => {
                draggedPalettePiece = piece.kind;
                draggedGuidedThingKind = null;
                draggedEntityId = null;
                draggedPart = null;
                event.dataTransfer?.setData("text/plain", piece.kind);
              }}
              @click=${() => addScenePalettePiece(host, piece.kind)}
            >
              <span class="snes-piece-glyph" aria-hidden="true"></span>
              <strong>${piece.label}</strong>
              <small>${piece.detail}</small>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderSelectedThingPanel(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) {
    return html`
      <aside class="snes-ai-selected-panel empty" aria-label="Selected thing">
        <span class="snes-eyebrow">Click Anything</span>
        <h3>Select a game thing to change it</h3>
        <p>Click the hero, an enemy, an item, a door, or a guide in the playable scene.</p>
        <div class="snes-ai-selected-panel__actions">
          <button
            type="button"
            @click=${() => focusFirstSceneThing(host, selectedScene() ?? project.scenes[0])}
          >
            Pick Hero
          </button>
          <button type="button" @click=${() => addScenePalettePiece(host, "enemy")}>
            Add Enemy
          </button>
          <button type="button" @click=${() => addScenePalettePiece(host, "item")}>Add Item</button>
          <button
            type="button"
            class="primary"
            @click=${() => startPreviewPlaytest(host, true, true)}
          >
            Test Now
          </button>
        </div>
      </aside>
    `;
  }
  const { entity } = selected;
  const behavior = entity.kind === "enemy" ? defaultBehaviorForEntity(entity) : null;
  return html`
    <aside class="snes-ai-selected-panel" aria-label="Selected thing editor">
      <span class="snes-eyebrow">Selected Thing</span>
      <h3>${selectedThingLabel(entity)}: ${entity.name}</h3>
      <p>Change it by typing above, dragging it in the game, or using these simple controls.</p>
      <label>
        Name
        <input
          .value=${entity.name}
          @input=${(event: Event) => updateSelectedEntityField(host, "name", inputValue(event))}
        />
      </label>
      <div class="snes-ai-selected-panel__grid">
        <label>
          Left/right
          <input
            type="number"
            .value=${String(entity.x)}
            @change=${(event: Event) => updateSelectedEntityField(host, "x", inputNumber(event))}
          />
        </label>
        <label>
          Up/down
          <input
            type="number"
            .value=${String(entity.y)}
            @change=${(event: Event) => updateSelectedEntityField(host, "y", inputNumber(event))}
          />
        </label>
      </div>
      <label>
        Ask OpenClaw to change this
        <textarea
          rows="3"
          .value=${surfacePromptDraft(selectedThingSurface(entity))}
          placeholder=${aiGameStagePromptPlaceholder()}
          @input=${(event: Event) =>
            updateAiPrompt(selectedThingSurface(entity), inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-ai-selected-panel__look">
        <strong>Look</strong>
        <span>${entity.visualRecipe ?? classicVisualRecipeForEntity(entity.kind)}</span>
      </div>
      ${entity.kind === "player"
        ? html`
            <div class="snes-ai-selected-panel__grid">
              <label>
                Run speed
                <input
                  type="range"
                  min="1"
                  max="8"
                  .value=${String(project.physics.moveSpeed)}
                  @input=${(event: Event) =>
                    updateHeroPhysics(host, "moveSpeed", inputNumber(event))}
                />
              </label>
              <label>
                Jump height
                <input
                  type="range"
                  min="-24"
                  max="-4"
                  .value=${String(project.physics.jumpVelocity)}
                  @input=${(event: Event) =>
                    updateHeroPhysics(host, "jumpVelocity", inputNumber(event))}
                />
              </label>
            </div>
          `
        : nothing}
      ${behavior
        ? html`
            <div class="snes-ai-selected-panel__grid">
              <label>
                Behavior
                <select
                  .value=${behavior.kind}
                  @change=${(event: Event) =>
                    updateSelectedEnemyBehavior(host, "kind", inputValue(event))}
                >
                  ${(["stationary", "patrol", "chase", "guard"] as const).map(
                    (kind) =>
                      html`<option value=${kind} ?selected=${behavior.kind === kind}>
                        ${kind}
                      </option>`,
                  )}
                </select>
              </label>
              <label>
                Speed
                <input
                  type="range"
                  min="1"
                  max="8"
                  .value=${String(behavior.speed)}
                  @input=${(event: Event) =>
                    updateSelectedEnemyBehavior(host, "speed", inputNumber(event))}
                />
              </label>
            </div>
          `
        : nothing}
      <div class="snes-ai-selected-panel__actions">
        <button type="button" class="primary" @click=${() => applyPromptToSelectedThing(host)}>
          Change With OpenClaw
        </button>
        <button type="button" @click=${() => changeSelectedThingLookWithAi(host)}>
          Change Look With OpenClaw
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host, true, true)}>
          Test This Change
        </button>
        <button type="button" @click=${() => duplicateSelectedThing(host)}>Duplicate</button>
        <button
          type="button"
          ?disabled=${undoStack.length === 0}
          @click=${() => undoProjectChange(host)}
        >
          Undo
        </button>
        <button type="button" class="danger" @click=${() => deleteSelectedThing(host)}>
          Delete
        </button>
      </div>
      ${renderInlineAiReviewPanel(host, focusedEditableObjectCard(), "side")}
    </aside>
  `;
}

function renderAiStageHistory() {
  const recent = recentActivityLines();
  return html`
    <section class="snes-ai-change-history" aria-label="What changed">
      <div>
        <strong>What Changed</strong>
        <span>Every AI or hand edit is undoable.</span>
      </div>
      ${lastAiActionFeedback
        ? html`
            <article>
              <span>${lastAiActionFeedback.target}</span>
              <strong>${lastAiActionFeedback.title}</strong>
              <small>${lastAiActionFeedback.detail}</small>
            </article>
          `
        : html`
            <article>
              <span>Ready</span>
              <strong>No AI change yet</strong>
              <small>Describe the game, then press Build My Game.</small>
            </article>
          `}
      ${recent.slice(0, 3).map((line) => html`<code>${line}</code>`)}
    </section>
  `;
}

function renderAiExportCard(host: HostUpdate) {
  const readiness = buildSnesReadiness(project);
  return html`
    <section class="snes-ai-export-card" aria-label="Make SNES game file">
      <div>
        <span class="snes-eyebrow">Export</span>
        <h3>Make ${renderHelpTerm("snes-game-file", "SNES game file")}</h3>
        <p>
          ${readiness.status === "ready"
            ? "Ready to create a preview file."
            : "Needs a quick fix before hardware-ready export."}
        </p>
      </div>
      <div class="snes-ai-export-card__actions">
        <button type="button" class="primary" @click=${() => downloadPreviewRom(host)}>
          Make SNES Game File
        </button>
        <button type="button" @click=${() => repairPlayablePreview(host)}>Fix First</button>
      </div>
      <details>
        <summary>Expert details</summary>
        <p>
          Hardware proof keeps ${renderHelpTerm("flash-cart", "flash cart")},
          ${renderHelpTerm("save-memory", "save memory")}, SuperFX, 128 GB FAT32, checksum, and
          budget checks available when you need them.
        </p>
      </details>
    </section>
  `;
}

function renderExpertStudio(host: HostUpdate) {
  return html`
    <details
      class="snes-ai-expert-studio"
      ?open=${showExpertStudio}
      @toggle=${(event: Event) => {
        showExpertStudio = (event.currentTarget as HTMLDetailsElement).open;
        host.requestUpdate?.();
      }}
    >
      <summary>
        <span>Expert Studio</span>
        <strong>Open advanced SNES tools, logs, budgets, and export proof</strong>
      </summary>
      ${showExpertStudio
        ? html`
            ${renderLearningDrawer()} ${renderModeRail(host)}
            ${renderUniversalCreateBar(host, selectedMode !== "make")} ${renderRecoveryPanel(host)}
            ${renderCurrentStudioMode(host)}
            <details class="snes-pro-drawer">
              <summary>Advanced AI stage</summary>
              ${renderAiStagePrompt(host)} ${renderAiReviewDrawer(host)}
            </details>
            <section class="snes-advanced-workbench" aria-label="Professional SNES workbench">
              ${renderAdvancedWorkbench(host)}
            </section>
          `
        : nothing}
    </details>
  `;
}

function renderGuidedProviderButtons(host: HostUpdate) {
  const run = project.aiProductionRun;
  const finalReview = run?.finalApproval;
  return html`
    <div class="snes-guided-provider snes-ai-production-lanes" aria-label="AI production team">
      <button
        type="button"
        class=${aiGameStageProvider === "auto-team" ? "active" : ""}
        @click=${() => setAiGameStageProvider(host, "auto-team")}
      >
        Cost-aware Auto Team
      </button>
      <button
        type="button"
        class=${aiGameStageProvider === "openclaw" ? "active" : ""}
        @click=${() => setAiGameStageProvider(host, "openclaw")}
      >
        OpenClaw Workers
      </button>
      <button
        type="button"
        class=${aiGameStageProvider === "codex" ? "active" : ""}
        @click=${() => setAiGameStageProvider(host, "codex")}
      >
        Codex Review Gate
      </button>
      <small>
        OpenClaw fills editable text boxes and game parts by default. Codex is reserved for
        blueprint, review, export, and build-fix gates.
        ${run
          ? ` Current status: ${run.status.replace(/-/g, " ")}${finalReview ? `, ${finalReview.score}/100` : ""}.`
          : ""}
      </small>
    </div>
  `;
}

function renderAgentTeamConnector(host: HostUpdate) {
  maybeAutoCheckSnesAgentTeam(host);
  const team =
    agentTeamRun ??
    createSnesAgentTeamPlan(
      project,
      surfacePromptDraft("full-game") || project.gameBrief?.prompt || project.name,
      { sessionKey: agentGatewaySessionKey },
    );
  const report = agentTeamReadinessReport;
  const proofPassed = liveAiProductionProofState.status === "passed";
  const proofUnavailable =
    liveAiProductionProofState.status === "failed" ||
    liveAiProductionProofState.status === "needs-setup";
  const statusLabel = proofPassed
    ? "Live OpenClaw ready"
    : proofUnavailable || report?.status === "unavailable" || team.status === "blocked"
      ? "Live OpenClaw unavailable"
      : report?.status === "checking" || team.status === "checking"
        ? "Checking live OpenClaw"
        : report?.status === "ready" || team.status === "ready"
          ? "Live proof pending"
          : "Checking soon";
  const statusDetail = proofUnavailable
    ? liveAiProductionProofState.detail
    : (report?.detail ??
      (proofPassed
        ? "Codex reviewers and OpenClaw worker lanes responded through Gateway."
        : team.status === "ready"
          ? "Required agents and runtime are configured. Run Live Production Check when you want model-backed proof."
          : team.status === "blocked"
            ? "Some live agent lanes are unavailable. Build Local Draft still works, and Check Again reruns this automatic status check."
            : team.status === "checking"
              ? "SNES Studio is checking live Codex/OpenClaw lanes now. You can keep building locally."
              : "SNES Studio checks this automatically when Dashboard Gateway is ready."));
  const actionLabel =
    liveAgentProofState.status === "running" ? "Checking Live Team" : "Check Again";
  const roleCards =
    report?.roles ??
    team.members.map((member) => {
      const readiness = team.readiness.find((entry) => entry.role === member.role);
      return {
        role: member.role,
        title: member.title,
        requestedAgent: member.requestedAgent,
        sessionKey: member.sessionKey,
        agentId: member.agentId,
        state:
          readiness?.status === "ready"
            ? ("ready" as const)
            : readiness?.status === "checking"
              ? ("checking" as const)
              : readiness?.status === "blocked"
                ? ("unavailable" as const)
                : ("not-checked" as const),
        configured: !member.agentId || readiness?.status !== "blocked",
        reachable: readiness?.status === "ready",
        responding: readiness?.status === "ready",
        validJsonReturned: readiness?.status === "ready",
        detail: readiness?.blocker ?? readiness?.detail ?? member.purpose,
        blocker: undefined,
      };
    });
  const stateLabel = (state: (typeof roleCards)[number]["state"]) => {
    switch (state) {
      case "ready":
        return "Ready";
      case "proof-pending":
        return "Proof pending";
      case "proof-running":
        return "Proof running";
      case "proof-passed":
        return "Live proof passed";
      case "proof-failed":
        return "Live proof failed";
      case "runtime-ready":
        return "Runtime ready";
      case "configured":
        return "Configured";
      case "checking":
        return "Checking";
      case "needs-setup":
        return "Needs setup";
      case "timed-out":
        return "Timed out";
      case "invalid-response":
        return "Invalid response";
      case "not-checked":
        return "Not checked";
      default:
        return "Unavailable";
    }
  };
  return html`
    <section class="snes-agent-team-connector" aria-label="SNES Studio AI team connector">
      <div class="snes-section-header">
        <span class="snes-eyebrow">Live AI Team Status</span>
        <h3>${statusLabel}</h3>
        <p>
          Codex plans and approves. OpenClaw role agents fill story, levels, gameplay, art, audio,
          and hardware checks. ${statusDetail}
        </p>
      </div>
      <div class="snes-ai-production-route__checks">
        ${roleCards.map(
          (role) => html`
            <article>
              <strong>${role.title}</strong>
              <small
                >${stateLabel(role.state)} ·
                ${role.requestedAgent === "codex" ? "Codex reviewer" : "OpenClaw worker"}
                ${role.agentId ? ` · ${role.agentId}` : ""}</small
              >
              <small>${role.blocker?.recommendedFix ?? role.detail}</small>
            </article>
          `,
        )}
      </div>
      <small class="snes-ai-production-route__state">
        ${statusLabel}. Session base: ${team.sessionBaseKey}.
      </small>
      <div class="snes-ai-production-route__actions">
        <button
          type="button"
          class="primary"
          ?disabled=${liveAgentProofState.status === "running"}
          @click=${() => {
            agentTeamAutoCheckStarted = true;
            void connectSnesAgentTeam(host);
          }}
        >
          ${actionLabel}
        </button>
      </div>
    </section>
  `;
}

function renderLiveAiProductionRoute(host: HostUpdate) {
  const readiness = probeSnesLiveAiReadiness(host);
  const connected = readiness.status === "ready";
  const state = liveAiProductionProofState;
  const routeLabel =
    state.status === "passed"
      ? "Gateway route verified"
      : state.status === "failed" || state.status === "needs-setup"
        ? "Live route needs setup"
        : connected
          ? "Dashboard Gateway ready"
          : "Local fallback active";
  return html`
    <div class=${`snes-ai-production-route snes-ai-production-route--${state.status}`}>
      <div>
        <span>Live AI team</span>
        <strong>${routeLabel}</strong>
        <p>
          ${connected
            ? "Live team status checks automatically. Run the production check only when you want a full Codex/OpenClaw staged build."
            : "You can build and play now with the local fallback. Live Codex/OpenClaw proof needs the connected Dashboard Gateway, not FXPAK hardware."}
        </p>
      </div>
      <div class="snes-ai-production-route__checks">
        <article>
          <strong>Codex Architect</strong><small>blueprint and quality rubric</small>
        </article>
        <article>
          <strong>OpenClaw workers</strong><small>fill every editable game part</small>
        </article>
        <article><strong>Codex QA</strong><small>review, corrections, approval</small></article>
      </div>
      <div class="snes-ai-production-route__checks">
        <article>
          <strong>Gateway</strong
          ><small>${readiness.gatewayConnected ? "connected" : "needs connection"}</small>
        </article>
        <article>
          <strong>Dashboard auth</strong
          ><small>${readiness.authenticated ? "ready" : "needs login"}</small>
        </article>
        <article><strong>Automated E2E</strong><small>optional smoke opt-in</small></article>
      </div>
      <small class="snes-ai-production-route__state">${readiness.title}. ${readiness.detail}</small>
      <small class="snes-ai-production-route__state">${state.title}. ${state.detail}</small>
      ${renderAgentTeamConnector(host)}
      ${pendingAgentProposal
        ? html`
            <div class="snes-ai-production-route__review">
              <strong>Review Before Apply</strong>
              <p>${pendingAgentProposal.summary}</p>
              <div class="snes-ai-production-route__actions">
                <button type="button" class="primary" @click=${() => approveAgentPatch(host)}>
                  Apply Change
                </button>
                <button type="button" @click=${() => discardAgentPatch(host)}>Discard</button>
              </div>
            </div>
          `
        : nothing}
      <div class="snes-ai-production-route__actions">
        <button
          type="button"
          class="primary"
          ?disabled=${state.status === "running"}
          @click=${() => void runLiveAiProductionProof(host)}
        >
          ${state.status === "running" ? "Checking Live Team" : "Run Live Production Check"}
        </button>
        <button type="button" @click=${() => void createGuidedPlatformerDraft(host)}>
          Build Local Draft
        </button>
      </div>
    </div>
  `;
}

function renderAiProductionRunCard(host: HostUpdate) {
  const run = project.aiProductionRun;
  if (!run) {
    return html`
      <section class="snes-ai-production-card" aria-label="Codex-supervised OpenClaw game team">
        <span class="snes-eyebrow">AI Production Team</span>
        <h3>Codex plans and reviews. OpenClaw fills the game.</h3>
        <div class="snes-ai-production-card__steps">
          <article>
            <strong>1 Codex Architect</strong><small>Blueprint, rubric, risks.</small>
          </article>
          <article>
            <strong>2 OpenClaw Game Team</strong><small>Story, levels, cast, rules.</small>
          </article>
          <article>
            <strong>3 Codex QA Gate</strong><small>Scores and approves before export.</small>
          </article>
        </div>
        ${renderLiveAiProductionRoute(host)}
      </section>
    `;
  }
  return html`
    <section class="snes-ai-production-card" aria-label="Codex-supervised OpenClaw production run">
      <span class="snes-eyebrow">AI Production Team</span>
      <h3>${run.status.replace(/-/g, " ")}</h3>
      <p>${run.blueprint.gameConcept}</p>
      <div class="snes-ai-production-card__steps">
        <article>
          <strong>Codex blueprint ready</strong>
          <small
            >${run.blueprint.qualityRubric.length} quality checks · ${run.taskList.length} OpenClaw
            tasks</small
          >
        </article>
        <article>
          <strong>OpenClaw Game Team filled</strong>
          <small
            >${run.agentResults.filter((result) => result.status === "filled").length}/${run
              .agentResults.length}
            sections filled</small
          >
        </article>
        <article>
          <strong>Codex approved for playtest</strong>
          <small
            >${run.finalApproval
              ? `${run.finalApproval.score}/100 · ${run.finalApproval.approvalStatus.replace(/-/g, " ")}`
              : "waiting for review"}</small
          >
        </article>
      </div>
      ${run.finalApproval && run.finalApproval.requiredCorrections.length > 0
        ? html`
            <ul>
              ${run.finalApproval.requiredCorrections.map(
                (correction) => html`<li>${correction}</li>`,
              )}
            </ul>
          `
        : html`<small
            >All editable game sections have an audit trail and can be changed with OpenClaw.</small
          >`}
      ${renderLiveAiProductionRoute(host)}
    </section>
  `;
}

function renderGuidedHeader(host: HostUpdate) {
  return html`
    <header class="snes-guided-hero snes-arcade-header" aria-label="AI Arcade Builder">
      <div>
        <span class="snes-eyebrow">AI Arcade Builder</span>
        <h2>Play it, point at it, ask OpenClaw to change it.</h2>
        <p>
          Start with one side-scrolling platformer. Codex plans and reviews; OpenClaw fills the
          game, then the emulator-like canvas becomes the editor.
        </p>
      </div>
      <div class="snes-guided-hero__actions">
        <button
          type="button"
          class="primary"
          @click=${() => void createGuidedPlatformerDraft(host)}
        >
          Build With OpenClaw
        </button>
        <button type="button" @click=${() => fillGuidedMissingPieces(host)}>Fill Gaps</button>
        <button type="button" @click=${() => setGuidedStep(host, "playtest")}>Play & Change</button>
      </div>
    </header>
  `;
}

function renderGuidedStepRail(host: HostUpdate) {
  return html`
    <nav class="snes-guided-steps" aria-label="Guided build steps">
      ${guidedStepItems().map(
        (step, index) => html`
          <button
            type="button"
            class=${`snes-guided-step snes-guided-step--${step.status}`}
            aria-current=${step.status === "current" ? "step" : "false"}
            @click=${() => setGuidedStep(host, step.id)}
          >
            <span>${index + 1}</span>
            <strong>${step.label}</strong>
            <small>${step.detail}</small>
          </button>
        `,
      )}
    </nav>
  `;
}

function renderGuidedControlBar() {
  const blueprint = project.gameplayBlueprint;
  const scene = selectedScene();
  const hero = scene?.entities.find((entity) => entity.kind === "player")?.name ?? "Hero needed";
  const readiness = buildSnesReadiness(project);
  const playStatus = previewSimulationState?.status ?? "ready";
  return html`
    <section class="snes-guided-control-bar" aria-label="Game Control Bar">
      <span>Game Status</span>
      <strong>${project.name}</strong>
      <em
        >${blueprint?.genre === "side-scrolling-platformer"
          ? "side-scrolling platformer"
          : "game"}</em
      >
      <em>hero ${hero}</em>
      <em>${blueprint?.difficulty ?? "easy"}</em>
      <em>${blueprint?.artMood ?? "bright 16-bit"}</em>
      <em>${currentStylePack().name}</em>
      <em>${aiGameStageProviderLabel()}</em>
      <em>playtest ${playStatus}</em>
      <em>export ${readiness.status}</em>
    </section>
  `;
}

function renderGuidedHealthStrip() {
  const readiness = buildSnesReadiness(project);
  const state = previewSimulationState;
  const checklist = project.completionChecklist;
  return html`
    <section class="snes-guided-health" aria-label="Game health">
      <article>
        <span>Story</span>
        <strong>${checklist?.storyComplete ? "ready" : "needs story"}</strong>
      </article>
      <article>
        <span>Levels</span>
        <strong>${project.levelChapters?.length ?? 0} chapters</strong>
      </article>
      <article>
        <span>Playtest</span>
        <strong>${state ? state.status : checklist?.playable ? "ready" : "needs pieces"}</strong>
      </article>
      <article>
        <span>Game file</span>
        <strong>${readiness.status}</strong>
      </article>
    </section>
  `;
}

function renderGuidedReceipt(host: HostUpdate) {
  const receipt = guidedReceipt;
  if (!receipt && !lastAiActionFeedback) {
    return html`
      <section class="snes-guided-receipt" aria-label="Latest AI result">
        <span>Ready</span>
        <strong>OpenClaw is waiting for your first game idea.</strong>
        <p>Type one story prompt and press Build With OpenClaw.</p>
      </section>
    `;
  }
  return html`
    <section class="snes-guided-receipt" aria-label="Latest AI result">
      <span>What changed</span>
      <strong>${receipt?.title ?? lastAiActionFeedback?.title}</strong>
      <p>${receipt?.detail ?? lastAiActionFeedback?.detail}</p>
      <small>${receipt?.next ?? "Test the change, keep it, or undo it."}</small>
      <div class="snes-guided-receipt__actions">
        <button
          type="button"
          class="primary"
          @click=${() => startPreviewPlaytest(host, true, true)}
        >
          Playtest Now
        </button>
        <button
          type="button"
          ?disabled=${undoStack.length === 0}
          @click=${() => undoProjectChange(host)}
        >
          Undo
        </button>
      </div>
    </section>
  `;
}

function renderStoryGap(gap: SnesAiGap) {
  return html`
    <article class=${`snes-story-gap snes-story-gap--${gap.severity}`}>
      <span>${gap.severity === "blocker" ? "Needs fix" : gap.severity}</span>
      <strong>${gap.title}</strong>
      <p>${gap.detail}</p>
      <small>${gap.suggestedFix}</small>
    </article>
  `;
}

function renderStoryGapFiller(host: HostUpdate) {
  const report = project.aiGapReport ?? createSnesAiGapReport(project);
  const gaps = report.gaps.filter((entry) => !entry.resolved).slice(0, 5);
  return html`
    <section class="snes-story-gap-filler" aria-label="AI Gap Filler">
      <div class="snes-story-gap-filler__header">
        <div>
          <span class="snes-eyebrow">AI Gap Filler</span>
          <strong
            >${report.status === "complete" ? "Full draft looks ready" : report.summary}</strong
          >
        </div>
        <button type="button" class="primary" @click=${() => fillGuidedMissingPieces(host)}>
          Fill Missing Pieces
        </button>
      </div>
      ${gaps.length > 0
        ? html`<div class="snes-story-gap-filler__grid">${gaps.map(renderStoryGap)}</div>`
        : html`<p>
            Story, levels, cast, playtest basics, save memory, and export plan are present.
          </p>`}
    </section>
  `;
}

function renderGuidedIdeaStep(host: HostUpdate) {
  return html`
    <section class="snes-guided-card snes-guided-idea" aria-label="Create a game from one prompt">
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Idea</span>
        <h3>What game do you want to make?</h3>
        <p>
          Change the original idea at any time. Codex writes the blueprint, OpenClaw fills the
          playable draft, and Codex reviews quality before export.
        </p>
      </div>
      <label>
        Game idea
        <textarea
          rows="5"
          .value=${surfacePromptDraft("full-game")}
          placeholder="Example: Make a story-driven robot platformer with three levels, gems, a rival drone, hidden key, and mountain ending."
          @input=${(event: Event) => updateAiPrompt("full-game", inputValue(event))}
        ></textarea>
      </label>
      ${renderGuidedProviderButtons(host)}
      <div class="snes-guided-actions">
        <button
          type="button"
          class="primary"
          @click=${() => void createGuidedPlatformerDraft(host)}
        >
          Build With OpenClaw
        </button>
        <button type="button" @click=${() => void askAiGameStageLiveAgent(host)}>
          Ask Live OpenClaw
        </button>
        <button type="button" @click=${() => startBlankProject(host)}>Blank Game</button>
      </div>
      ${renderGraphicsStyleCard(host)}
      <div class="snes-guided-chips" aria-label="Starter ideas">
        ${beginnerPromptChips.map(
          (chip) => html`
            <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
              ${chip.label}
            </button>
          `,
        )}
      </div>
      ${liveAgentProofState.status !== "idle"
        ? html`
            <div
              class=${`snes-ai-stage-live-proof snes-ai-stage-live-proof--${liveAgentProofState.status}`}
            >
              <strong>${liveAgentProofState.title}</strong>
              <span>${liveAgentProofState.detail}</span>
            </div>
          `
        : nothing}
      ${renderAiProductionRunCard(host)} ${renderStoryGapFiller(host)}
    </section>
  `;
}

function renderGuidedGamePlanStep(host: HostUpdate) {
  const story = project.gameStoryBible;
  const rules = project.platformerRules;
  return html`
    <section
      class="snes-guided-card snes-guided-plan snes-story-map"
      aria-label="Editable game plan"
    >
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Game Plan</span>
        <h3>The whole game AI made from your prompt</h3>
        <p>
          This is the Book Publisher-style plan for the game: story, hero goal, enemy, ending,
          levels, rewards, music mood, and the plain rules that make it playable.
        </p>
      </div>
      <div class="snes-story-map__grid">
        <article>
          <span>Premise</span>
          <strong>${story?.premise ?? project.gameplayBlueprint?.premise ?? project.name}</strong>
          <small>${project.gameplayBlueprint?.artMood ?? "colorful 16-bit adventure"}</small>
        </article>
        <article>
          <span>World</span>
          <strong>${story?.world ?? "A readable side-scrolling world."}</strong>
          <small>${story?.tone ?? "hopeful and easy to understand"}</small>
        </article>
        <article>
          <span>Hero goal</span>
          <strong>${story?.hero ?? "Hero"}</strong>
          <small>${story?.heroGoal ?? "Reach the ending goal."}</small>
        </article>
        <article>
          <span>Villain and ending</span>
          <strong>${story?.villain ?? "Rival Guardian"}</strong>
          <small>${story?.ending ?? "The hero reaches the final goal."}</small>
        </article>
        <article>
          <span>Movement rule</span>
          <strong>${rules?.movement ?? "Run and jump."}</strong>
          <small
            >${project.physics.moveSpeed} run speed · ${Math.abs(project.physics.jumpVelocity)} jump
            height</small
          >
        </article>
        <article>
          <span>Rewards and risk</span>
          <strong>${rules?.itemEffects ?? "Collect rewards."}</strong>
          <small>${rules?.damage ?? "Danger lowers health."}</small>
        </article>
      </div>
      ${renderGraphicsStyleCard(host)} ${renderStoryGapFiller(host)}
      <div class="snes-guided-actions">
        <button type="button" class="primary" @click=${() => setGuidedStep(host, "build-level")}>
          Build Levels
        </button>
        <button type="button" @click=${() => setGuidedStep(host, "make-things")}>
          Make Things
        </button>
        <button
          type="button"
          @click=${() => toggleGamePartLock(host, "story", "story-map", "Story Map")}
        >
          ${isGamePartLocked("story", "story-map") ? "Unlock Story Map" : "Lock Story Map"}
        </button>
      </div>
    </section>
  `;
}

function renderGuidedThingsShelf(host: HostUpdate) {
  const shelf: Array<{ kind: SnesGuidedThingKind; detail: string }> = [
    { kind: "hero", detail: "main character" },
    { kind: "enemy", detail: "challenge" },
    { kind: "item", detail: "reward" },
    { kind: "powerup", detail: "ability" },
    { kind: "platform", detail: "safe ground" },
    { kind: "hazard", detail: "danger" },
    { kind: "door", detail: "move level" },
    { kind: "goal", detail: "finish" },
    { kind: "coin-trail", detail: "reward path" },
  ];
  return html`
    <section class="snes-guided-shelf" aria-label="Things Shelf">
      <div>
        <span class="snes-eyebrow">Things Shelf</span>
        <strong>Drag or click to add things</strong>
      </div>
      <div class="snes-guided-shelf__grid">
        ${shelf.map(
          (entry) => html`
            <button
              type="button"
              draggable="true"
              class=${`snes-guided-shelf__thing snes-guided-shelf__thing--${entry.kind}`}
              @pointerdown=${() => {
                draggedGuidedThingKind = entry.kind;
                draggedPalettePiece = null;
                draggedEntityId = null;
                draggedPart = null;
              }}
              @dragstart=${(event: DragEvent) => {
                draggedGuidedThingKind = entry.kind;
                draggedPalettePiece = null;
                draggedEntityId = null;
                draggedPart = null;
                event.dataTransfer?.setData("text/plain", entry.kind);
              }}
              @click=${() => {
                const name = addGuidedThingToLevel(host, entry.kind);
                if (name) pushConsole(host, `Added ${name} from the Things Shelf.`);
              }}
            >
              <strong>${guidedThingLabel(entry.kind)}</strong>
              <small>${entry.detail}</small>
            </button>
          `,
        )}
      </div>
      <div class="snes-guided-shelf__library">
        ${(project.thingLibrary ?? []).slice(0, 8).map(
          (entry) => html`
            <article>
              <span>${entry.kind}</span>
              <strong>${entry.name}</strong>
              <small>${entry.behavior}</small>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderGuidedThingsShelfDrawer(host: HostUpdate) {
  return html`
    <details class="snes-play-drawer snes-guided-things-drawer">
      <summary>Add game things</summary>
      ${renderGuidedThingsShelf(host)}
    </details>
  `;
}

function selectLevelChapter(host: HostUpdate, chapter: SnesLevelChapter, openPlaytest = false) {
  const sceneIndex = project.scenes.findIndex((scene) => scene.id === chapter.sceneId);
  selectedSceneIndex = Math.max(0, sceneIndex);
  selectedPanel = "scene";
  selectedGuidedStep = openPlaytest ? "playtest" : "build-level";
  selectedMode = openPlaytest ? "play" : "edit";
  if (openPlaytest) {
    startPreviewPlaytest(host, false, true);
  }
  host.requestUpdate?.();
}

function rebuildLevelChapter(host: HostUpdate, chapter: SnesLevelChapter) {
  selectLevelChapter(host, chapter);
  updateAiPrompt(
    "level",
    `Build ${chapter.title}: ${chapter.storyPurpose} Setting: ${chapter.setting}. Challenge: ${chapter.challenge}. Reward: ${chapter.reward}. Goal: ${chapter.goal}`,
  );
  paintLevelFromPrompt(host);
  previewSimulationState = initializeRuntimeState();
  guidedReceipt = {
    title: `${chapter.title} rebuilt`,
    detail: "AI updated the playable level from the chapter plan.",
    next: "Press Build & Play, then drag or prompt anything that feels wrong.",
  };
  host.requestUpdate?.();
}

function renderLevelChapterCard(host: HostUpdate, chapter: SnesLevelChapter) {
  const locked = isGamePartLocked("level", chapter.id);
  return html`
    <article class="snes-level-chapter-card">
      <span>Level ${chapter.order + 1}</span>
      <strong>${chapter.title}</strong>
      <p>${chapter.storyPurpose}</p>
      <dl>
        <div>
          <dt>Place</dt>
          <dd>${chapter.setting}</dd>
        </div>
        <div>
          <dt>Challenge</dt>
          <dd>${chapter.challenge}</dd>
        </div>
        <div>
          <dt>Reward</dt>
          <dd>${chapter.reward}</dd>
        </div>
        <div>
          <dt>Goal</dt>
          <dd>${chapter.goal}</dd>
        </div>
      </dl>
      <small>Needs: ${chapter.requiredThings.join(", ")}</small>
      <div class="snes-guided-actions">
        <button type="button" class="primary" @click=${() => rebuildLevelChapter(host, chapter)}>
          Build This Level
        </button>
        <button type="button" @click=${() => selectLevelChapter(host, chapter, true)}>Test</button>
        <button
          type="button"
          @click=${() => toggleGamePartLock(host, "level", chapter.id, chapter.title)}
        >
          ${locked ? "Unlock" : "Lock"}
        </button>
        <button
          type="button"
          ?disabled=${undoStack.length === 0}
          @click=${() => undoProjectChange(host)}
        >
          Undo
        </button>
      </div>
    </article>
  `;
}

function renderGuidedBuildLevelStep(host: HostUpdate) {
  const chapters = project.levelChapters ?? [];
  return html`
    <section class="snes-guided-card snes-guided-build" aria-label="Levels as chapters">
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Build Levels</span>
        <h3>Walk through the game like chapters</h3>
        <p>
          Each level has a story purpose, setting, challenge, reward, and goal. Build a level with
          AI, then drag or prompt-tune it in Build & Play.
        </p>
      </div>
      <div class="snes-level-chapters">
        ${chapters.length > 0
          ? chapters.map((chapter) => renderLevelChapterCard(host, chapter))
          : html`<p>No chapters yet. Press Fill Missing Pieces or Build My Game.</p>`}
      </div>
      <label>
        Change the selected level with AI
        <textarea
          rows="3"
          .value=${surfacePromptDraft("level")}
          placeholder="Example: Make this level reveal the hidden key through three safe jumps, one rival drone, and a gem trail."
          @input=${(event: Event) => updateAiPrompt("level", inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-guided-actions">
        <button
          type="button"
          class="primary"
          @click=${() => {
            paintLevelFromPrompt(host);
            startPreviewPlaytest(host, true, true);
            guidedReceipt = {
              title: "Level rebuilt",
              detail: "AI painted a playable level layout from your prompt.",
              next: "Open Build & Play, then drag anything that feels wrong.",
            };
          }}
        >
          Change Level With AI
        </button>
        <button type="button" @click=${() => setGuidedStep(host, "make-things")}>
          Make Things
        </button>
        <button type="button" @click=${() => setGuidedStep(host, "playtest")}>Play & Change</button>
      </div>
      ${renderGuidedThingsShelf(host)}
    </section>
  `;
}

function renderGuidedMakeThingsStep(host: HostUpdate) {
  return html`
    <section class="snes-guided-card snes-guided-things" aria-label="Make custom things">
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Make Things</span>
        <h3>Create every story object with a prompt</h3>
        <p>
          Make the hero, villain, enemies, NPCs, items, powerups, doors, hazards, music ideas, or
          new level chapters. AI adds them to the shelf and the playtest.
        </p>
      </div>
      <label class="snes-guided-thing-prompt">
        Cast or thing prompt
        <textarea
          rows="4"
          .value=${guidedThingPromptDraft}
          placeholder="Example: Create a rival drone enemy called Volt Warden that guards the hidden key."
          @input=${(event: Event) => {
            guidedThingPromptDraft = inputValue(event);
          }}
        ></textarea>
      </label>
      ${renderGuidedProviderButtons(host)}
      <div class="snes-guided-actions">
        <button type="button" class="primary" @click=${() => createGuidedThingFromPrompt(host)}>
          Create Thing
        </button>
        <button type="button" @click=${() => setGuidedStep(host, "build-level")}>
          Build Levels
        </button>
      </div>
      <div class="snes-guided-chips">
        ${[
          "Create a rival drone enemy called Volt Warden.",
          "Create a shiny key item that opens the goal door.",
          "Create a helpful guide NPC who explains the mountain gate.",
          "Create upbeat mountain adventure music.",
        ].map(
          (prompt) => html`
            <button
              type="button"
              @click=${() => {
                guidedThingPromptDraft = prompt;
                host.requestUpdate?.();
              }}
            >
              ${prompt.replace(/^Create /u, "")}
            </button>
          `,
        )}
      </div>
      ${renderGuidedThingsShelf(host)}
    </section>
  `;
}

function renderArcadeAskBar(host: HostUpdate) {
  const selected = selectedSceneThing();
  const surface = selected ? selectedThingSurface(selected.entity) : "full-game";
  const selectedAreaSummary = selectedScreenArea ? selectedAreaTileRect(selectedScreenArea) : null;
  const promptValue = selectedScreenArea
    ? arcadeAreaPromptDraft
    : selected
      ? surfacePromptDraft(surface)
      : surfacePromptDraft("full-game");
  const promptPlaceholder = selectedScreenArea
    ? "Example: add coins here, make this a lava pit, add a secret door, remove this enemy..."
    : selected
      ? `Example: make ${selected.entity.name} slower, friendlier, stronger, or easier to see...`
      : "Example: make the game more exciting, add a new enemy, or make this level easier...";
  const areaSuggestions = selectedScreenArea
    ? selectedAreaPromptSuggestions(selectedScreenArea)
    : [];
  return html`
    <section
      class=${`snes-arcade-ask-bar${selectedScreenArea ? " snes-arcade-ask-bar--area" : ""}${selected ? " snes-arcade-ask-bar--thing" : ""}`}
      aria-label="Ask AI about the game screen"
    >
      <div class="snes-arcade-ask-bar__context">
        <span>Ask AI</span>
        <strong>
          ${selectedScreenArea
            ? `Change ${selectedScreenArea.label}`
            : selected
              ? `Change ${selected.entity.name}`
              : "Change the game"}
        </strong>
        <small>
          ${selectedScreenArea
            ? `Selected ${selectedAreaSummary?.width ?? 1} by ${selectedAreaSummary?.height ?? 1} level squares. Type what should happen there, or use a fast change.`
            : selected
              ? "The next prompt changes only the clicked thing."
              : "No selection means AI improves the current game or level."}
        </small>
      </div>
      <textarea
        rows="2"
        .value=${promptValue}
        placeholder=${promptPlaceholder}
        @input=${(event: Event) => {
          if (selectedScreenArea) {
            arcadeAreaPromptDraft = inputValue(event);
            pendingAreaPreview = null;
            return;
          }
          updateAiPrompt(surface, inputValue(event));
        }}
      ></textarea>
      ${selectedScreenArea
        ? html`
            <div class="snes-area-prompt-suggestions" aria-label="Try selected area prompts">
              <span>Try asking</span>
              ${areaSuggestions.map(
                (prompt) => html`
                  <button
                    type="button"
                    @click=${() => {
                      arcadeAreaPromptDraft = prompt;
                      pendingAreaPreview = null;
                      host.requestUpdate?.();
                    }}
                  >
                    ${prompt}
                  </button>
                `,
              )}
            </div>
            <div class="snes-area-quick-actions" aria-label="Quick selected area changes">
              <span>Fast changes</span>
              ${[
                { label: "Add Coins", prompt: "Add a coin trail here." },
                { label: "Add Key", prompt: "Add a hidden key here." },
                { label: "Add Enemy", prompt: "Add a slow patrol enemy here." },
                { label: "Make Easier", prompt: "Make this jump easier with safe ground." },
                { label: "Make Ground", prompt: "Make this a safe platform." },
                { label: "Make Danger", prompt: "Make this a danger pit with spikes." },
                { label: "Make Gap", prompt: "Make this an empty gap." },
                {
                  label: "Remove Things",
                  prompt: "Remove enemies, items, doors, and goals inside this area.",
                },
              ].map(
                (action) => html`
                  <button
                    type="button"
                    @click=${() => applySelectedAreaQuickAction(host, action.prompt)}
                  >
                    ${action.label}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
      ${renderSelectedAreaPreviewCard(host)}
      <div class="snes-arcade-ask-bar__actions">
        ${renderGuidedProviderButtons(host)}
        ${selectedScreenArea
          ? html`
              <button type="button" @click=${() => previewPromptForSelectedArea(host)}>
                Preview Area Change
              </button>
            `
          : nothing}
        <button
          type="button"
          class="primary"
          @click=${() =>
            selectedScreenArea
              ? applyPromptToSelectedScreenArea(host)
              : runAiGameStageCommand(host)}
        >
          ${selectedScreenArea ? "Change Selected Area" : "Make Change"}
        </button>
        <button type="button" @click=${() => startPreviewPlaytest(host, true, true)}>
          Test Now
        </button>
        <button
          type="button"
          ?disabled=${!selectedScreenArea}
          @click=${() => {
            selectedScreenArea = null;
            pendingAreaPreview = null;
            delete project.selectedScreenArea;
            saveProject();
            host.requestUpdate?.();
          }}
        >
          Clear Selection
        </button>
      </div>
    </section>
  `;
}

function renderGuidedPlaytestStep(host: HostUpdate) {
  return html`
    <section
      class="snes-guided-card snes-guided-playtest"
      aria-label="Playable game test"
      tabindex="0"
      @keydown=${(event: KeyboardEvent) => handlePlayModeKeydown(host, event)}
      @keyup=${(event: KeyboardEvent) => handlePlayModeKeyup(host, event)}
    >
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Play & Change</span>
        <h3>Use the emulator as the editor</h3>
        <p>
          Play with keys or buttons. Click a thing to edit it, or drag an empty rectangle on the
          emulator and ask AI to add, remove, or change whatever is inside it.
        </p>
      </div>
      <div class="snes-guided-actions">
        <button
          type="button"
          class="primary"
          @click=${() => startPreviewPlaytest(host, true, true)}
        >
          Start Playtest
        </button>
        <button type="button" @click=${() => resetPreviewPlaytest(host)}>Restart</button>
        <button type="button" @click=${() => setGuidedStep(host, "make-things")}>
          Make Things
        </button>
      </div>
      ${renderArcadeAskBar(host)} ${renderGameTestPanel(host)}
      ${renderGuidedThingsShelfDrawer(host)}
    </section>
  `;
}

function renderGuidedSelectedPanel(host: HostUpdate) {
  const selected = selectedSceneThing();
  if (!selected) {
    return html`
      <aside class="snes-guided-selected-empty" aria-label="Selected thing">
        <span class="snes-eyebrow">Click To Edit</span>
        <strong>Click the hero, enemy, item, door, or goal in the playtest.</strong>
        <p>Then you can prompt only that thing, drag it, duplicate it, or tune simple controls.</p>
      </aside>
    `;
  }
  return renderSelectedThingPanel(host);
}

function renderGuidedExportStep(host: HostUpdate) {
  return html`
    <section class="snes-guided-card snes-guided-export" aria-label="Export game">
      <div class="snes-guided-card__copy">
        <span class="snes-eyebrow">Create Game File</span>
        <h3>Let AI check the full game, then make the SNES game file</h3>
        <p>
          Beginner export stays simple. Expert hardware proof for the flash cart, save memory,
          SuperFX, budgets, and checksum remains in Advanced Studio.
        </p>
      </div>
      ${renderStoryGapFiller(host)} ${renderAiExportCard(host)}
    </section>
  `;
}

function renderGuidedWorkspace(host: HostUpdate) {
  const activeStep =
    selectedGuidedStep === "idea"
      ? renderGuidedIdeaStep(host)
      : selectedGuidedStep === "game-plan"
        ? renderGuidedGamePlanStep(host)
        : selectedGuidedStep === "build-level"
          ? renderGuidedBuildLevelStep(host)
          : selectedGuidedStep === "make-things"
            ? renderGuidedMakeThingsStep(host)
            : selectedGuidedStep === "playtest"
              ? renderGuidedPlaytestStep(host)
              : renderGuidedExportStep(host);
  return html`
    <section class="snes-guided-workspace" aria-label="SNES Studio guided workspace">
      <div class="snes-guided-workspace__main">${activeStep}</div>
      <div class="snes-guided-workspace__side">
        ${renderGuidedReceipt(host)} ${renderAiProductionRunCard(host)}
        ${renderStoryGapFiller(host)} ${renderAiReviewDrawer(host)}
        ${renderGuidedSelectedPanel(host)}
      </div>
    </section>
  `;
}

function renderArcadeStart(host: HostUpdate) {
  return html`
    <section class="snes-arcade-start" aria-label="AI Arcade Builder start">
      <div class="snes-arcade-start__copy">
        <span class="snes-eyebrow">AI Arcade Builder</span>
        <h2>What game do you want to make?</h2>
        <p>
          Type one idea. Codex creates the blueprint, OpenClaw fills the game, Codex checks it, and
          you get a playable side-scrolling game you can change by clicking the emulator.
        </p>
      </div>
      <label class="snes-arcade-start__prompt">
        <span>Game idea</span>
        <textarea
          rows="6"
          .value=${surfacePromptDraft("full-game")}
          placeholder="Example: Make a robot mountain adventure with three levels, gems, a rival drone, a hidden key, and a big door at the end."
          @input=${(event: Event) => updateAiPrompt("full-game", inputValue(event))}
        ></textarea>
      </label>
      <div class="snes-arcade-start__bottom">
        <div>
          <span class="snes-arcade-start__label">Who helps?</span>
          ${renderGuidedProviderButtons(host)}
        </div>
        <button
          type="button"
          class="primary"
          @click=${() => void createGuidedPlatformerDraft(host)}
        >
          Build With OpenClaw
        </button>
      </div>
      ${renderAiProductionRunCard(host)} ${renderGraphicsStyleCard(host)}
      <div class="snes-arcade-start__chips" aria-label="Starter game ideas">
        ${[
          {
            label: "Robot mountain adventure",
            prompt:
              'Make "Sky Robot Quest", a robot mountain platformer with three levels, gems, a rival drone, a hidden key, and a big door ending.',
          },
          {
            label: "Spooky forest coin quest",
            prompt:
              "Make a friendly spooky forest platformer with glowing coins, mushroom platforms, slow enemies, and a moonlit goal.",
          },
          {
            label: "Underwater rescue",
            prompt:
              "Make an underwater rescue platformer with bubbles, treasure shells, gentle hazards, and a submarine door goal.",
          },
        ].map(
          (chip) => html`
            <button type="button" @click=${() => applyPromptChip(host, chip.prompt)}>
              <strong>${chip.label}</strong>
              <small>${chip.prompt}</small>
            </button>
          `,
        )}
      </div>
      <div class="snes-arcade-start__promise" aria-label="What happens next">
        <article>
          <span>1</span>
          <strong>AI makes the game plan</strong>
          <small>Story, levels, cast, rules, music idea, save plan.</small>
        </article>
        <article>
          <span>2</span>
          <strong>You play it</strong>
          <small>The emulator-like canvas moves immediately.</small>
        </article>
        <article>
          <span>3</span>
          <strong>You point and prompt</strong>
          <small>Drag-select the screen and ask AI to add, remove, or change things.</small>
        </article>
      </div>
    </section>
  `;
}

function renderGuidedGameBuilder(host: HostUpdate) {
  if (!hasArcadeGameDraft()) {
    return html`
      <main class="snes-arcade-builder snes-arcade-builder--start" aria-label="AI Arcade Builder">
        ${renderArcadeStart(host)} ${renderExpertStudio(host)}
      </main>
    `;
  }
  return html`
    <main class="snes-guided-game-builder snes-arcade-builder" aria-label="AI Arcade Builder">
      ${renderGuidedHeader(host)} ${renderGuidedStepRail(host)} ${renderGuidedControlBar()}
      ${renderGuidedHealthStrip()} ${renderGuidedWorkspace(host)} ${renderExpertStudio(host)}
    </main>
  `;
}

export function renderAiGameStage(host: HostUpdate) {
  const selected = selectedSceneThing();
  return html`
    <main class="snes-ai-game-stage" aria-label="AI-first SNES game builder">
      ${renderAiStagePrompt(host)} ${renderAiReviewDrawer(host)}
      <section class="snes-ai-game-stage__body" aria-label="Playable game stage">
        <div class="snes-ai-game-stage__play">
          <div class="snes-ai-game-stage__play-header">
            <div>
              <span class="snes-eyebrow">Playable Game</span>
              <h3>${project.name}</h3>
              <p>
                ${selected
                  ? `${selected.entity.name} is selected. Drag it, edit it, prompt it, then test.`
                  : "Play first. Click anything in the game to change it."}
              </p>
            </div>
            <div class="snes-ai-game-stage__play-actions">
              <button
                type="button"
                class="primary"
                @click=${() => startPreviewPlaytest(host, true, true)}
              >
                Test Now
              </button>
              <button type="button" @click=${() => resetPreviewPlaytest(host)}>Restart</button>
            </div>
          </div>
          ${renderGameTestPanel(host)} ${renderAiQuickPieces(host)}
        </div>
        <div class="snes-ai-game-stage__side">
          ${renderSelectedThingPanel(host)} ${renderAiStageHistory()} ${renderAiExportCard(host)}
        </div>
      </section>
      ${renderExpertStudio(host)}
    </main>
  `;
}

export function renderSnesStudio(host: HostUpdate = {}) {
  ensureAgentResultListener(host);
  ensureKeyboardShortcuts(host);
  return html`
    <div
      class=${`snes-studio snes-studio--guided-platformer snes-studio--story-builder snes-studio--mode-${selectedMode}`}
    >
      ${renderGuidedGameBuilder(host)}
    </div>
  `;
}
