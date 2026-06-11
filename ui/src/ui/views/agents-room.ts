import { html, nothing } from "lit";
import type { KalshiDashboardSnapshot } from "../controllers/kalshi-dashboard.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { parseAgentSessionKey } from "../session-key.ts";
import type {
  AgentsInstalledModelStatus,
  AgentsRuntimeModelStatus,
  AgentsRuntimeStatusResult,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  GatewayAgentRow,
  GatewaySessionRow,
  OpsSummaryResult,
  SessionsListResult,
} from "../types.ts";
import { normalizeAgentLabel } from "./agents-utils.ts";

export type AgentRoomSessionsState = {
  loading: boolean;
  error: string | null;
  result: SessionsListResult | null;
};

export type AgentRoomRuntimeStatusState = {
  loading: boolean;
  error: string | null;
  result: AgentsRuntimeStatusResult | null;
};

type RoomState =
  | "supervising"
  | "working"
  | "idle"
  | "sleeping"
  | "waiting"
  | "thinking"
  | "running-tool"
  | "reading"
  | "writing"
  | "blocked"
  | "error"
  | "completed"
  | "offline"
  | "unknown";

export type AgentRoomProps = {
  agents: GatewayAgentRow[];
  defaultId: string | null;
  selectedAgentId: string | null;
  sessions: AgentRoomSessionsState;
  runtimeStatus: AgentRoomRuntimeStatusState;
  opsSummary?: {
    loading: boolean;
    error: string | null;
    result: OpsSummaryResult | null;
  };
  cron?: {
    status: CronStatus | null;
    jobs: CronJob[];
    loading: boolean;
    error: string | null;
  };
  channels?: {
    snapshot: ChannelsStatusSnapshot | null;
    loading: boolean;
    error: string | null;
    lastSuccess: number | null;
  };
  kalshiDashboard?: KalshiDashboardSnapshot | null;
  kalshiDashboardLoading?: boolean;
  kalshiDashboardError?: string | null;
  connected: boolean;
  onSelectAgent: (agentId: string) => void;
  onRefresh: () => void;
  onOpenAgent: () => void;
  onAssignAgentRoom?: (agentId: string, roomId: string) => void;
  onInspectAttention?: (target: AttentionTarget) => void;
};

type AgentRoomMemoryFixtureProps = Pick<
  AgentRoomProps,
  | "agents"
  | "defaultId"
  | "selectedAgentId"
  | "sessions"
  | "runtimeStatus"
  | "kalshiDashboard"
  | "connected"
>;

export type DashboardHealthState =
  | "Healthy"
  | "Watching"
  | "Needs Review"
  | "Degraded"
  | "Critical";

export type DashboardIssueSeverity = "critical" | "high" | "medium" | "low";

export type AttentionConfidence = "Live" | "Recent" | "Stale" | "Inferred";

export type AttentionTarget =
  | { kind: "agent"; agentId: string; label: string }
  | { kind: "agentsPanel"; panel: "room" | "overview" | "channels" | "cron"; label: string }
  | { kind: "appTab"; tab: "overview" | "kalshi" | "channels" | "cron"; label: string }
  | { kind: "cronRun"; jobId: string; label: string }
  | { kind: "channelStart"; channel: string; accountId?: string | null; label: string };

export type AttentionAction = {
  id: string;
  severity: DashboardIssueSeverity;
  title: string;
  whyItMatters: string;
  recommendedAction: string;
  target: AttentionTarget;
  detectedAt: number | null;
  confidence: AttentionConfidence;
};

export type AttentionVerdict = {
  label:
    | "All clear"
    | "Watching"
    | "Review recommended"
    | "Some systems need attention"
    | "Critical issue";
  tone: "healthy" | "watching" | "review" | "degraded" | "critical";
  summary: string;
};

export type DashboardIssue = {
  id: string;
  severity: DashboardIssueSeverity;
  title: string;
  affected: string;
  detectedAt: number | null;
  likelyCause: string;
  nextInspection: string;
  plainSummary: string;
  whyItMatters: string;
  recommendedAction: string;
  target: AttentionTarget;
  confidence: AttentionConfidence;
  priority: number;
};

export type MemoryVerdict = {
  tone: "good" | "warn" | "danger" | "unknown";
  text: string;
};

type LearningVelocityTone = "active" | "watching" | "stale" | "waiting";

type LearningVelocitySummary = {
  tone: LearningVelocityTone;
  status: string;
  headline: string;
  updatedAt: number | null;
  metrics: Array<{ label: string; value: string; detail: string }>;
  changes: string[];
  nextAction: string;
  safety: string;
};

type DashboardSignalTone = "live" | "recent" | "checking" | "stale" | "error" | "offline";

type DashboardSignal = {
  label: string;
  value: string;
  detail: string;
  tone: DashboardSignalTone;
};

export type AgentSignalConfidence = "Live" | "Recent" | "Stale" | "Inferred";

export type DashboardHealthSummary = {
  state: DashboardHealthState;
  tone: "healthy" | "watching" | "review" | "degraded" | "critical";
  attentionVerdict: AttentionVerdict;
  attentionActions: AttentionAction[];
  issues: DashboardIssue[];
  topIssues: DashboardIssue[];
  changedRecently: string[];
  nextAutomation: string;
  nextKalshiActivity: string;
  memoryVerdict: MemoryVerdict;
  gatewayVerifiedAt?: number | null;
  gatewaySummaryLoading?: boolean;
  gatewaySummaryError?: string | null;
};

export type RoomAgent = {
  agent: GatewayAgentRow;
  label: string;
  personName: string | null;
  titleLabel: string;
  metadata: AgentMasterPlanMetadata;
  director: boolean;
  onWatch: boolean;
  projectRoom: ProjectRoom;
  model: string | null;
  modelFallbacks: string[];
  lastRunModel: string | null;
  loadedModel: AgentsRuntimeModelStatus | null;
  installedModel: AgentsInstalledModelStatus | null;
  modelRamText: string;
  modelRamWhenLiveText: string;
  modelRamBadge: string;
  state: RoomState;
  statusLabel: string;
  cue: string;
  active: boolean;
  latestSession: GatewaySessionRow | null;
  recentSessions: GatewaySessionRow[];
  updatedAt: number | null;
  externalActivity: ExternalAgentActivity | null;
  signalConfidence: AgentSignalConfidence;
  thinkingPolicy: ControlDirectorThinkingPolicy | null;
};

export type ExternalAgentActivity = {
  state: RoomState;
  statusLabel: string;
  cue: string;
  task: string;
  detail: string;
  source: string;
  updatedAt: number | null;
};

export type ControlDirectorThinkingPolicy = {
  label: string;
  detail: string;
  current: string;
};

type AgentActivationPolicy =
  | "always-on"
  | "conditional-always-on"
  | "scheduled"
  | "on-demand"
  | "scheduled-or-on-demand"
  | "disabled";

export type AgentMasterPlanMetadata = {
  displayName?: string;
  roomId: keyof typeof PROJECT_ROOMS;
  role: string;
  purpose: string;
  activation: AgentActivationPolicy;
  activationLabel: string;
  summonCriteria: string;
  owns: string[];
  doesNotOwn?: string[];
  venueTags?: string[];
};

export type ProjectRoom = {
  id: string;
  label: string;
  subtitle: string;
  tone: "core" | "market" | "youtube" | "build" | "ops" | "music" | "general";
};

const RECENT_COMPLETION_MS = 5 * 60_000;
const RECENT_ACTIVITY_MS = 15 * 60_000;
const RECENT_ATTENTION_MS = 10 * 60_000;
const STALE_SIGNAL_MS = 60 * 60_000;
const KALSHI_STALE_MS = 30 * 60_000;
const RECENT_TASK_LIMIT = 5;
const RECENT_ACTION_COMPACT_LIMIT = 3;
const ATTENTION_ACTION_LIMIT = 3;
const MODEL_RAM_SHARED_HINT =
  "Model RAM is shared by all agents using the same loaded model, so per-agent RAM is shown as a live model footprint, not added per worker.";
const CONTROL_DIRECTOR_MODEL_OK_RE =
  /(?:^|[/:-])openclaw-control-qwen36-27b(?::|$)|(?:^|[/:-])qwen3\.6:27b-q8_0(?:$|[@\s])|(?:^|[/:-])openclaw-control-qwen25-32b(?::|$)|(?:^|[/:-])qwen25-32b(?::|$)/i;
const CONTROL_DIRECTOR_PRIMARY_MODEL_RE =
  /(?:^|[/:-])openclaw-control-qwen36-27b(?::|$)|(?:^|[/:-])qwen3\.6:27b-q8_0(?:$|[@\s])/i;

export function isControlDirectorModelOk(model: string): boolean {
  return CONTROL_DIRECTOR_MODEL_OK_RE.test(model);
}

export function isControlDirectorPrimaryModel(model: string): boolean {
  return CONTROL_DIRECTOR_PRIMARY_MODEL_RE.test(model);
}

export function resolveControlDirectorThinkingPolicy(
  agent: GatewayAgentRow,
  latestSession?: GatewaySessionRow | null,
): ControlDirectorThinkingPolicy | null {
  if (agent.id !== "main" && agent.id !== "control-director") {
    return null;
  }
  const defaultLevel = latestSession?.thinkingDefault?.trim() || "off";
  const sessionLevel = latestSession?.thinkingLevel?.trim();
  const current =
    sessionLevel && sessionLevel !== defaultLevel
      ? `Session override: ${sessionLevel}`
      : `Default: ${defaultLevel}`;
  return {
    label: "Thinking as needed",
    detail:
      "Default off for routine turns; auto-escalates to medium for implementation/evaluation and high for failed build, rollback, model, runtime, service, or production-risk work.",
    current,
  };
}

function attentionConfidenceFromTimestamp(
  timestamp: number | null | undefined,
  now: number,
  live = false,
): AttentionConfidence {
  if (live) {
    return "Live";
  }
  if (!timestamp) {
    return "Inferred";
  }
  if (now - timestamp > STALE_SIGNAL_MS) {
    return "Stale";
  }
  if (now - timestamp > RECENT_ACTIVITY_MS) {
    return "Recent";
  }
  return "Live";
}

function isSafetyOrRiskAutomation(job: CronJob): boolean {
  const text = `${job.name} ${job.description ?? ""} ${job.agentId ?? ""}`.toLowerCase();
  return /risk|exposure|readiness|evidence|live|kalshi|prediction|market|position/.test(text);
}

function issueTargetButtonLabel(target: AttentionTarget): string {
  return target.label;
}

function parseOpsCronRunTarget(
  issueId: string,
): Extract<AttentionTarget, { kind: "cronRun" }> | null {
  const jobId = issueId.startsWith("cron-") ? issueId.slice("cron-".length).trim() : "";
  if (!jobId) {
    return null;
  }
  return { kind: "cronRun", jobId, label: "Rerun safely" };
}

function parseOpsChannelStartTarget(issueId: string): AttentionTarget | null {
  const rest = issueId.trim().replace(/^channel-/i, "");
  if (!rest || rest === issueId.trim()) {
    return null;
  }
  const [channel, ...accountParts] = rest.split("-");
  return {
    kind: "channelStart",
    channel,
    accountId: accountParts.join("-") || null,
    label: "Retry channel",
  };
}

function actionSafetyHint(target: AttentionTarget): string {
  if (target.kind === "cronRun") {
    return "Confirmation required. Runs the existing scheduled job once.";
  }
  if (target.kind === "channelStart") {
    return "Confirmation required. Starts the existing channel connection.";
  }
  return "Inspection only. No automation is changed.";
}

function dashboardIssue(params: DashboardIssue): DashboardIssue {
  return params;
}

const PROJECT_ROOMS: Record<string, ProjectRoom> = {
  core: {
    id: "core",
    label: "Shared Command",
    subtitle: "Directors, judgment, telemetry, credentials, and coordination.",
    tone: "core",
  },
  markets: {
    id: "markets",
    label: "Prediction Markets",
    subtitle: "Kalshi and Polymarket shared research, watch, risk, exposure, and execution roles.",
    tone: "market",
  },
  youtube: {
    id: "youtube",
    label: "YouTube Content Engine",
    subtitle: "Trend research, scripts, publishing, repurposing, comments, offers, and analytics.",
    tone: "youtube",
  },
  build: {
    id: "build",
    label: "Product and Build Lab",
    subtitle: "Products, funnels, curriculum, engineering specs, QA, release, and support.",
    tone: "build",
  },
  game: {
    id: "game",
    label: "Game Studio",
    subtitle:
      "SNES Studio agents for game direction, levels, gameplay, art, audio, and hardware QA.",
    tone: "build",
  },
  ops: {
    id: "ops",
    label: "Executive and Personal Ops",
    subtitle: "Scheduling, email, calls, research briefs, hiring, journaling, and direction.",
    tone: "ops",
  },
  music: {
    id: "music",
    label: "Music Studio",
    subtitle: "Music ideation, arrangements, and release planning.",
    tone: "music",
  },
  general: {
    id: "general",
    label: "General Workspace",
    subtitle: "Agents that do not map cleanly to a named project room yet.",
    tone: "general",
  },
};

const PROJECT_ROOM_ORDER = [
  "core",
  "markets",
  "youtube",
  "build",
  "game",
  "ops",
  "music",
  "general",
];

const ASSIGNABLE_PROJECT_ROOM_IDS = PROJECT_ROOM_ORDER.filter((id) => id !== "general");

const PREDICTION_MARKET_VENUE_TAGS = ["Kalshi", "Polymarket"];

const AGENT_PERSON_NAMES: Record<string, string> = {
  main: "Todd Stanski",
  "strategic-director": "Einstein",
};

const AGENT_ROOM_CANONICAL_ALIASES: Record<string, string> = {
  "snes-game-director": "openclaw-game-director",
  "snes-level-designer": "openclaw-level-designer",
  "snes-gameplay-designer": "openclaw-gameplay-designer",
  "snes-art-audio": "openclaw-art-and-audio",
  "snes-hardware-qa": "openclaw-hardware-qa",
};

export const SHARED_SERVICE_AGENT_IDS = [
  "program-manager",
  "automation-playbook-architect",
  "memory-knowledge-curator",
  "telemetry-evaluation-analyst",
  "browser-session-credential-steward",
  "market-research-analyst",
  "codex",
] as const;

export const AGENT_MASTER_PLAN: Record<string, AgentMasterPlanMetadata> = {
  main: {
    displayName: "Control Director",
    roomId: "core",
    role: "Always-on control director",
    purpose:
      "Route requests, coordinate specialist agents, enforce instructions, and keep OpenClaw responsive.",
    activation: "always-on",
    activationLabel: "Always-on",
    summonCriteria:
      "Always visible; summon directly for status, routing, escalation, and coordination.",
    owns: [
      "Request routing",
      "agent coordination",
      "instruction adherence",
      "operator-facing status",
    ],
  },
  "strategic-director": {
    roomId: "core",
    role: "Strategic planning director",
    purpose: "Set priorities, evaluate tradeoffs, and turn broad goals into executable direction.",
    activation: "on-demand",
    activationLabel: "On-demand",
    summonCriteria: "Summon for strategy, prioritization, positioning, or major plan changes.",
    owns: ["strategic plans", "priority tradeoffs", "goal alignment"],
  },
  judge: {
    roomId: "core",
    role: "Quality and decision judge",
    purpose: "Critique outputs, score evidence, and identify gaps before decisions are accepted.",
    activation: "on-demand",
    activationLabel: "On-demand",
    summonCriteria: "Summon when a plan, response, or claim needs independent evaluation.",
    owns: ["quality review", "rubric scoring", "gap detection"],
  },
  "program-manager": {
    roomId: "core",
    role: "Cross-project program manager",
    purpose: "Track plans, follow-through, blockers, and accountability across OpenClaw projects.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria: "Summon for status rollups, sequencing, blockers, and next-action planning.",
    owns: ["project tracking", "blocker surfacing", "follow-through"],
  },
  "automation-playbook-architect": {
    roomId: "core",
    role: "Automation playbook architect",
    purpose: "Design repeatable workflows and durable operating procedures for agent work.",
    activation: "on-demand",
    activationLabel: "On-demand",
    summonCriteria: "Summon when a repeated workflow should become an automation or playbook.",
    owns: ["workflow design", "automation specs", "playbook structure"],
  },
  "memory-knowledge-curator": {
    roomId: "core",
    role: "Memory and knowledge curator",
    purpose:
      "Keep durable memory, wiki claims, and project knowledge accurate, provenance-backed, and low-noise.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon for memory promotion, wiki hygiene, contradiction review, or durable knowledge curation.",
    owns: ["memory promotion review", "knowledge provenance", "contradiction checks"],
    doesNotOwn: ["raw strategy approval", "credential handling", "market conclusions"],
  },
  "telemetry-evaluation-analyst": {
    roomId: "core",
    role: "Telemetry and evaluation analyst",
    purpose:
      "Measure reliability, latency, accuracy, and task outcomes so improvements are evidence-based.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon for performance reviews, evaluation design, and reliability investigations.",
    owns: ["telemetry review", "evaluation metrics", "regression signals"],
  },
  "browser-session-credential-steward": {
    roomId: "core",
    role: "Always-on browser and credential steward",
    purpose: "Guard browser session hygiene, credential boundaries, and safe handoffs.",
    activation: "always-on",
    activationLabel: "Always-on",
    summonCriteria:
      "Always visible; summon for browser/session hygiene, auth readiness, or credential-safe workflows.",
    owns: ["browser session hygiene", "credential boundary reminders", "auth readiness checks"],
  },
  "market-research-analyst": {
    roomId: "core",
    role: "Market research analyst",
    purpose: "Research markets, audiences, competitors, and demand signals for business decisions.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon for market maps, competitive research, and evidence-backed opportunity analysis.",
    owns: ["market research", "competitive analysis", "audience evidence"],
  },
  codex: {
    displayName: "Codex Coding Specialist",
    roomId: "core",
    role: "On-demand OpenClaw coding specialist",
    purpose:
      "Make repo-scoped OpenClaw code changes only when explicitly summoned by Todd or the operator.",
    activation: "on-demand",
    activationLabel: "On-demand only",
    summonCriteria:
      "Summon from Discord or chat only with an explicit Codex trigger such as /codex, use Codex, ask Codex, have Codex, or delegate to Codex.",
    owns: ["repo-scoped code edits", "test validation", "implementation reports"],
    doesNotOwn: [
      "always-on routing",
      "silent background edits",
      "commits or pushes without approval",
    ],
  },
  "polymarket-market-watch-agent": {
    displayName: "Market Watch Agent",
    roomId: "markets",
    role: "Prediction-market watch agent",
    purpose:
      "Continuously watch venue signals and alert on notable market changes without trading.",
    activation: "conditional-always-on",
    activationLabel: "On watch when markets are active",
    summonCriteria:
      "Summon for Kalshi or Polymarket market updates, watchlists, alerts, and signal summaries.",
    owns: ["market monitoring", "watchlist updates", "signal alerts"],
    doesNotOwn: ["order placement", "wallet actions", "live execution"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "polymarket-research-agent": {
    displayName: "Prediction Market Research Agent",
    roomId: "markets",
    role: "Prediction-market research agent",
    purpose: "Research market context, evidence, and probabilities across supported venues.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon before entries, postmortems, thesis checks, or statistical-significance reviews.",
    owns: ["market research", "evidence summaries", "probability rationale"],
    doesNotOwn: ["execution", "risk approval"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "polymarket-risk-controller": {
    displayName: "Risk Controller",
    roomId: "markets",
    role: "Prediction-market risk gate",
    purpose: "Enforce bankroll, exposure, approval, and paper/live trading risk rules.",
    activation: "conditional-always-on",
    activationLabel: "On watch during paper/live windows",
    summonCriteria:
      "Summon before any paper or live trade, risk-limit change, or approval decision.",
    owns: ["risk gates", "exposure limits", "approval checks"],
    doesNotOwn: ["market thesis", "order execution without approval"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "polymarket-strategy-improvement-analyst": {
    displayName: "Strategy Improvement Analyst",
    roomId: "markets",
    role: "Strategy improvement analyst",
    purpose: "Review results and recommend better rules from meaningful paper/live trading events.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / after meaningful events",
    summonCriteria:
      "Summon after trading outcomes, near misses, drawdowns, or enough paper-trade samples.",
    owns: ["postmortems", "strategy improvement proposals", "paper-mode learning notes"],
    doesNotOwn: ["direct production mutation", "live execution"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "polymarket-mispricing-arbitrage-analyst": {
    displayName: "Mispricing and Arbitrage Analyst",
    roomId: "markets",
    role: "Read-only mispricing and arbitrage analyst",
    purpose:
      "Filter venue-explicit price discrepancies, spread inefficiencies, and hedge structures without claiming edge or executing trades.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon for Kalshi or Polymarket scans only when venue, market identifier, rules, bid/ask/depth, fees, liquidity, and settlement evidence are available.",
    owns: [
      "mispricing scans",
      "spread inefficiency checks",
      "hedge-structure review packets",
      "missing-evidence checklists",
    ],
    doesNotOwn: [
      "wallet actions",
      "order placement",
      "risk approval",
      "profit or edge claims without complete evidence",
    ],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "prediction-market-position-exposure-monitor": {
    displayName: "Position Exposure Monitor",
    roomId: "markets",
    role: "Position and exposure monitor",
    purpose:
      "Track current positions, exposure, settlement status, and venue-level portfolio visibility.",
    activation: "conditional-always-on",
    activationLabel: "On watch during live windows; scheduled otherwise",
    summonCriteria:
      "Summon for portfolio status, exposure summaries, open positions, and settlement checks.",
    owns: ["position visibility", "exposure summaries", "portfolio status"],
    doesNotOwn: ["new entries", "strategy approval"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "prediction-market-resolution-settlement-auditor": {
    displayName: "Resolution and Settlement Auditor",
    roomId: "markets",
    role: "Resolution and settlement auditor",
    purpose: "Audit market resolution, settlement, and post-event correctness across venues.",
    activation: "scheduled-or-on-demand",
    activationLabel: "Scheduled / on-demand",
    summonCriteria:
      "Summon near resolution windows, after settlement, or when settlement correctness is unclear.",
    owns: ["resolution checks", "settlement audit", "dispute evidence"],
    doesNotOwn: ["entry selection", "order execution"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
  "prediction-market-execution-agent": {
    displayName: "Execution Agent",
    roomId: "markets",
    role: "Disabled-by-default execution agent",
    purpose:
      "Execute approved prediction-market actions only after explicit approval and risk gates.",
    activation: "disabled",
    activationLabel: "Disabled by default",
    summonCriteria:
      "Do not summon for autonomous trading; use only after explicit approval and risk-controller clearance.",
    owns: ["approved execution steps"],
    doesNotOwn: ["autonomous trading", "risk bypass", "approval bypass"],
    venueTags: PREDICTION_MARKET_VENUE_TAGS,
  },
};

const AGENT_ROOM_OVERRIDES: Record<string, AgentMasterPlanMetadata["roomId"]> = {
  "topic-trend-researcher": "youtube",
  "script-writer": "youtube",
  "publisher-scheduler": "youtube",
  "youtube-performance-analyst": "youtube",
  "shorts-repurposer": "youtube",
  "comment-response-drafter": "youtube",
  "offer-extraction-agent": "youtube",
  "video-production-orchestrator": "youtube",
  "transcript-knowledge-distiller": "youtube",
  "newsletter-editor": "youtube",
  "curriculum-architect": "build",
  "lesson-builder": "build",
  "funnel-builder": "build",
  "book-drafting-agent": "build",
  "asset-repurposer": "build",
  "problem-miner": "build",
  "product-strategist": "build",
  "engineering-spec-writer": "build",
  "builder-agent": "build",
  "qa-test-agent": "build",
  "release-ops-agent": "build",
  "support-incident-response-agent": "build",
  "executive-assistant-agent": "ops",
  "scheduling-booking-coordinator": "ops",
  "email-triage-drafting-agent": "ops",
  "call-prep-follow-up-agent": "ops",
  "research-brief-agent": "ops",
  "hiring-screen-agent": "ops",
  "journal-check-in-coach": "ops",
  "pattern-detection-agent": "ops",
  "direction-niche-advisor": "ops",
  "music-ideation-agent": "music",
  "arrangement-release-planner": "music",
  "openbrain-local-smoke": "build",
  "openclaw-game-director": "game",
  "openclaw-level-designer": "game",
  "openclaw-gameplay-designer": "game",
  "openclaw-art-and-audio": "game",
  "openclaw-hardware-qa": "game",
  "snes-game-director": "game",
  "snes-level-designer": "game",
  "snes-gameplay-designer": "game",
  "snes-art-audio": "game",
  "snes-hardware-qa": "game",
};

function resolveAgentModel(agent: GatewayAgentRow): string | null {
  const model = (agent as { model?: unknown }).model;
  if (typeof model === "string") {
    return model.trim() || null;
  }
  return agent.model?.primary?.trim() || null;
}

function resolveAgentModelFallbacks(agent: GatewayAgentRow): string[] {
  return (agent.model?.fallbacks ?? []).map((fallback) => fallback.trim()).filter(Boolean);
}

function normalizeModelRef(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  const withoutProvider = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  return withoutProvider.replace(/:latest$/i, "").toLowerCase();
}

function modelRefsMatch(modelRef: string | null, loadedModel: AgentsRuntimeModelStatus): boolean {
  const agentRef = normalizeModelRef(modelRef);
  const loadedRef = normalizeModelRef(loadedModel.model);
  const loadedName = normalizeModelRef(loadedModel.name);
  return Boolean(agentRef && (agentRef === loadedRef || agentRef === loadedName));
}

type AgentRoomDerivationIndex = {
  recentSessionsByAgentId: Map<string, GatewaySessionRow[]>;
  loadedModelsByRef: Map<string, AgentsRuntimeModelStatus>;
  installedModelsByRef: Map<string, AgentsInstalledModelStatus>;
};

function normalizeAgentIndexId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function sessionActivityMillis(row: GatewaySessionRow): number {
  return row.updatedAt ?? row.endedAt ?? row.startedAt ?? 0;
}

function pushRecentSession(
  sessionsByAgentId: Map<string, GatewaySessionRow[]>,
  agentId: string | null | undefined,
  row: GatewaySessionRow,
  limit: number,
) {
  const normalizedAgentId = normalizeAgentIndexId(agentId);
  if (!normalizedAgentId) {
    return;
  }
  const sessions = sessionsByAgentId.get(normalizedAgentId) ?? [];
  const rowActivity = sessionActivityMillis(row);
  const insertAt = sessions.findIndex((existing) => sessionActivityMillis(existing) < rowActivity);
  sessions.splice(insertAt === -1 ? sessions.length : insertAt, 0, row);
  if (sessions.length > limit) {
    sessions.length = limit;
  }
  sessionsByAgentId.set(normalizedAgentId, sessions);
}

function buildRecentSessionsByAgentId(
  rows: GatewaySessionRow[],
  defaultId: string | null,
  limit = RECENT_TASK_LIMIT,
): Map<string, GatewaySessionRow[]> {
  const sessionsByAgentId = new Map<string, GatewaySessionRow[]>();
  const defaultAgentId = defaultId || "main";
  for (const row of rows) {
    const ownerIds = new Set<string>();
    const resolvedAgentId = resolveSessionAgentId(row, defaultId);
    const parsedParent = parseAgentSessionKey(row.spawnedBy);
    ownerIds.add(resolvedAgentId);
    if (parsedParent?.agentId) {
      ownerIds.add(parsedParent.agentId);
    }
    if (row.key === defaultAgentId || row.key === "main") {
      ownerIds.add(defaultAgentId);
    }
    for (const agentId of ownerIds) {
      pushRecentSession(sessionsByAgentId, agentId, row, limit);
    }
  }
  return sessionsByAgentId;
}

function addModelRefsToIndex<TModel extends AgentsRuntimeModelStatus | AgentsInstalledModelStatus>(
  index: Map<string, TModel>,
  model: TModel,
) {
  for (const ref of [model.model, model.name]) {
    const normalized = normalizeModelRef(ref);
    if (normalized && !index.has(normalized)) {
      index.set(normalized, model);
    }
  }
}

function buildAgentRoomDerivationIndex(
  rows: GatewaySessionRow[],
  defaultId: string | null,
  runtimeStatus: AgentsRuntimeStatusResult | null,
): AgentRoomDerivationIndex {
  const loadedModelsByRef = new Map<string, AgentsRuntimeModelStatus>();
  const installedModelsByRef = new Map<string, AgentsInstalledModelStatus>();
  if (runtimeStatus?.localModels.available) {
    for (const model of runtimeStatus.localModels.models) {
      addModelRefsToIndex(loadedModelsByRef, model);
    }
  }
  for (const model of runtimeStatus?.localModels.installedModels ?? []) {
    addModelRefsToIndex(installedModelsByRef, model);
  }
  return {
    recentSessionsByAgentId: buildRecentSessionsByAgentId(rows, defaultId),
    loadedModelsByRef,
    installedModelsByRef,
  };
}

function resolveLoadedModelForAgent(
  modelRefs: Array<string | null | undefined>,
  index: AgentRoomDerivationIndex,
): AgentsRuntimeModelStatus | null {
  for (const modelRef of modelRefs) {
    const normalized = normalizeModelRef(modelRef);
    const loadedModel = normalized ? index.loadedModelsByRef.get(normalized) : null;
    if (loadedModel && modelRefsMatch(modelRef ?? null, loadedModel)) {
      return loadedModel;
    }
  }
  return null;
}

function resolveInstalledModelForAgent(
  modelRefs: Array<string | null | undefined>,
  index: AgentRoomDerivationIndex,
): AgentsInstalledModelStatus | null {
  for (const modelRef of modelRefs) {
    const normalized = normalizeModelRef(modelRef);
    const installedModel = normalized ? index.installedModelsByRef.get(normalized) : null;
    if (installedModel) {
      return installedModel;
    }
  }
  return null;
}

function describeAgentModelRam(
  loadedModel: AgentsRuntimeModelStatus | null,
  runtimeStatus: AgentsRuntimeStatusResult | null,
): { text: string; badge: string } {
  if (loadedModel) {
    return {
      text: [
        formatBytes(loadedModel.sizeBytes),
        loadedModel.contextLength ? `${loadedModel.contextLength.toLocaleString()} ctx` : null,
      ]
        .filter(Boolean)
        .join(" - "),
      badge: `RAM ${formatBytes(loadedModel.sizeBytes)}`,
    };
  }
  if (!runtimeStatus?.localModels.available) {
    return { text: "Unavailable - Ollama telemetry offline", badge: "RAM n/a" };
  }
  if (runtimeStatus.localModels.count === 0) {
    return { text: "0 B - no local model loaded now", badge: "RAM idle" };
  }
  return { text: "Not loaded now - another model is resident", badge: "RAM not loaded" };
}

function describeDisplayedModelRam(entry: {
  agent: GatewayAgentRow;
  externalActivity: ExternalAgentActivity | null;
  latestSession: GatewaySessionRow | null;
  loadedModel: AgentsRuntimeModelStatus | null;
  modelRamText: string;
  modelRamBadge: string;
  onWatch: boolean;
  state: RoomState;
}): { text: string; badge: string; title: string } {
  const watchOnlyWithoutResidentModel =
    entry.onWatch &&
    !entry.loadedModel &&
    (entry.agent.id === "browser-session-credential-steward" ||
      entry.latestSession?.status !== "running");
  if (entry.externalActivity && !entry.loadedModel) {
    return {
      text: "0 B - automation bridge active, no local LLM loaded",
      badge: "Bridge active",
      title:
        "This role is awake from a fresh Kalshi automation snapshot. No local model is currently loaded for this agent.",
    };
  }
  if (watchOnlyWithoutResidentModel) {
    return {
      text: "0 B - on watch, no local LLM loaded",
      badge: "On watch",
      title:
        "This always-on role is visually on watch, but it is not currently running a local LLM.",
    };
  }
  return {
    text: entry.modelRamText,
    badge: entry.modelRamBadge,
    title: MODEL_RAM_SHARED_HINT,
  };
}

function describeDisplayedModelRamWhenLive(entry: RoomAgent): string {
  const watchOnlyWithoutResidentModel =
    entry.onWatch &&
    !entry.loadedModel &&
    (entry.agent.id === "browser-session-credential-steward" ||
      entry.latestSession?.status !== "running");
  if (entry.loadedModel) {
    return `${formatBytes(entry.loadedModel.sizeBytes)} live now`;
  }
  if (entry.installedModel) {
    const details = [entry.installedModel.parameterSize, entry.installedModel.quantization]
      .filter(Boolean)
      .join(", ");
    return `${formatBytes(entry.installedModel.sizeBytes)} installed model${details ? ` (${details})` : ""}`;
  }
  if (entry.externalActivity) {
    return "N/A for automation bridge - no local LLM loaded";
  }
  if (watchOnlyWithoutResidentModel) {
    return "On-watch role - model loads only when summoned; no resident RAM now";
  }
  return entry.modelRamWhenLiveText;
}

function describeAgentModelRamWhenLive(
  loadedModel: AgentsRuntimeModelStatus | null,
  installedModel: AgentsInstalledModelStatus | null,
  runtimeStatus: AgentsRuntimeStatusResult | null,
): string {
  if (loadedModel) {
    return `${formatBytes(loadedModel.sizeBytes)} live now`;
  }
  if (installedModel) {
    const details = [installedModel.parameterSize, installedModel.quantization]
      .filter(Boolean)
      .join(", ");
    return `${formatBytes(installedModel.sizeBytes)} installed model${details ? ` (${details})` : ""}`;
  }
  if (runtimeStatus?.localModels.installedAvailable === false) {
    return "Unavailable - installed model catalog offline";
  }
  return "Unknown - model not found in local Ollama catalog";
}

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatProcessCategory(category: "openclaw" | "ollama" | "other"): string {
  if (category === "openclaw") {
    return "OpenClaw";
  }
  if (category === "ollama") {
    return "Ollama";
  }
  return "Other";
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return Math.round(value).toLocaleString();
}

function describeMemoryPressure(
  availableBytes: number,
  totalBytes: number,
): { label: string; className: string } {
  if (totalBytes <= 0) {
    return { label: "Unknown pressure", className: "unknown" };
  }
  const availableRatio = availableBytes / totalBytes;
  if (availableRatio >= 0.35) {
    return { label: "Low pressure", className: "good" };
  }
  if (availableRatio >= 0.18) {
    return { label: "Moderate pressure", className: "warn" };
  }
  return { label: "High pressure", className: "danger" };
}

function deriveMemoryVerdict(runtimeStatus: AgentRoomRuntimeStatusState): MemoryVerdict {
  const result = runtimeStatus.result;
  if (!result) {
    return {
      tone: runtimeStatus.error ? "danger" : "unknown",
      text: runtimeStatus.error
        ? "Memory telemetry is unavailable, so model headroom cannot be verified."
        : "Checking live RAM availability and model pressure.",
    };
  }
  const total = result.system.totalBytes;
  const macosMemory = result.system.macosMemory;
  const available = macosMemory?.available
    ? macosMemory.availabilityEstimateBytes
    : result.system.freeBytes;
  const pressure = describeMemoryPressure(available, total);
  const cacheNote = macosMemory?.available
    ? `${formatBytes(macosMemory.reclaimableBytes)} is reclaimable cache.`
    : "macOS reclaimable-cache telemetry is unavailable.";
  const loadedModelRam = result.localModels.totalLoadedBytes;
  if (pressure.className === "danger") {
    return {
      tone: "danger",
      text: `Memory pressure is high: about ${formatBytes(available)} is realistically available for more work. ${cacheNote}`,
    };
  }
  if (pressure.className === "warn") {
    return {
      tone: "warn",
      text: `You likely have ${formatBytes(available)} available for models, but watch growth carefully. Loaded models use ${formatBytes(loadedModelRam)}. ${cacheNote}`,
    };
  }
  return {
    tone: "good",
    text: `You likely have ${formatBytes(available)} available for models. Loaded models use ${formatBytes(loadedModelRam)}. ${cacheNote}`,
  };
}

function isAwakeRoomState(state: RoomState): boolean {
  return !["idle", "sleeping", "offline", "unknown"].includes(state);
}

function isControlDirector(agent: GatewayAgentRow, _defaultId: string | null): boolean {
  return agent.id === "main";
}

function canonicalRoomAgentKey(agent: GatewayAgentRow): string {
  const id = agent.id.trim();
  const alias = AGENT_ROOM_CANONICAL_ALIASES[id];
  if (alias) {
    return alias;
  }
  if (id === "strategic-director") {
    return "strategic-director";
  }
  if (normalizeAgentLabel(agent).trim().toLowerCase() === "strategic director") {
    return "strategic-director";
  }
  return id;
}

function dedupeRoomAgents(agents: GatewayAgentRow[]): GatewayAgentRow[] {
  const seen = new Set<string>();
  const unique: GatewayAgentRow[] = [];
  for (const agent of agents) {
    const key = canonicalRoomAgentKey(agent);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(agent);
  }
  return unique;
}

function humanizeAgentId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveFallbackMetadata(
  agent: GatewayAgentRow,
  director: boolean,
): AgentMasterPlanMetadata {
  if (director) {
    return AGENT_MASTER_PLAN.main;
  }
  const roomId =
    agent.id.startsWith("polymarket-") || agent.id.startsWith("prediction-market-")
      ? "markets"
      : (AGENT_ROOM_OVERRIDES[agent.id] ?? "general");
  const label = normalizeAgentLabel(agent);
  return {
    roomId,
    role: `${label === agent.id ? humanizeAgentId(agent.id) : label} specialist`,
    purpose: `Handle tasks that match the ${label === agent.id ? humanizeAgentId(agent.id) : label} role.`,
    activation: "on-demand",
    activationLabel: "On-demand",
    summonCriteria:
      "Summon when a task clearly matches this specialist's role and required inputs are available.",
    owns: ["role-specific specialist work"],
  };
}

function applyAgentConfiguredRoom(
  agent: GatewayAgentRow,
  metadata: AgentMasterPlanMetadata,
): AgentMasterPlanMetadata {
  const configuredRoomId = agent.roomId?.trim();
  if (
    !configuredRoomId ||
    configuredRoomId === metadata.roomId ||
    !Object.hasOwn(PROJECT_ROOMS, configuredRoomId)
  ) {
    return metadata;
  }
  return { ...metadata, roomId: configuredRoomId as keyof typeof PROJECT_ROOMS };
}

function resolveAgentMetadata(agent: GatewayAgentRow, director: boolean): AgentMasterPlanMetadata {
  const metadata =
    AGENT_MASTER_PLAN[director ? "main" : agent.id] ?? resolveFallbackMetadata(agent, director);
  return applyAgentConfiguredRoom(agent, metadata);
}

function isOnWatchAgent(metadata: AgentMasterPlanMetadata): boolean {
  return metadata.activation === "always-on" || metadata.activation === "conditional-always-on";
}

function resolveOnWatchRole(metadata: AgentMasterPlanMetadata): string {
  if (metadata.activation === "always-on") {
    return "Always on";
  }
  if (metadata.activation === "conditional-always-on") {
    const role = metadata.role.toLowerCase();
    if (role.includes("risk")) {
      return "Risk gate";
    }
    if (role.includes("exposure")) {
      return "Exposure watch";
    }
    if (role.includes("watch")) {
      return "Market watch";
    }
    return "On watch";
  }
  return metadata.activationLabel;
}

function resolveRoomAgentPersonName(agent: GatewayAgentRow): string | null {
  return AGENT_PERSON_NAMES[agent.id] ?? agent.identity?.name?.trim() ?? null;
}

function resolveRoomAgentTitle(
  agent: GatewayAgentRow,
  director: boolean,
  metadata: AgentMasterPlanMetadata,
): string {
  if (metadata.displayName) {
    return metadata.displayName;
  }
  if (director) {
    return "Control Director";
  }
  return agent.name?.trim() || humanizeAgentId(agent.id);
}

function resolveProjectRoom(metadata: AgentMasterPlanMetadata): ProjectRoom {
  return PROJECT_ROOMS[metadata.roomId] ?? PROJECT_ROOMS.general;
}

function resolveSessionAgentId(row: GatewaySessionRow, defaultId: string | null): string {
  const parsed = parseAgentSessionKey(row.key);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  return defaultId || "main";
}

function recentSessionsForAgent(
  agentId: string,
  index: AgentRoomDerivationIndex,
): GatewaySessionRow[] {
  return index.recentSessionsByAgentId.get(normalizeAgentIndexId(agentId) ?? "") ?? [];
}

function deriveRoomState(row: GatewaySessionRow | null, now: number): RoomState {
  if (!row) {
    return "sleeping";
  }
  const activityAt = row.updatedAt ?? row.endedAt ?? row.startedAt ?? null;
  const recent = Boolean(activityAt && now - activityAt <= RECENT_ACTIVITY_MS);
  const recentAttention = Boolean(activityAt && now - activityAt <= RECENT_ATTENTION_MS);
  if (row.status === "failed") {
    return recentAttention ? "error" : "sleeping";
  }
  if (row.status === "timeout" || row.status === "killed") {
    return recentAttention ? "blocked" : "sleeping";
  }
  if (row.status === "running") {
    if (row.childSessions?.length) {
      return "running-tool";
    }
    if (row.thinkingLevel && row.thinkingLevel !== "off") {
      return "thinking";
    }
    return "working";
  }
  if (row.status === "done") {
    return activityAt && now - activityAt <= RECENT_COMPLETION_MS ? "completed" : "sleeping";
  }
  if (recent) {
    return "waiting";
  }
  return "sleeping";
}

function deriveSignalConfidence(params: {
  state: RoomState;
  updatedAt: number | null;
  externalActivity: ExternalAgentActivity | null;
  onWatch: boolean;
  now: number;
}): AgentSignalConfidence {
  if (
    params.state === "working" ||
    params.state === "thinking" ||
    params.state === "running-tool" ||
    params.state === "waiting" ||
    params.state === "blocked" ||
    params.state === "error"
  ) {
    return "Live";
  }
  if (params.updatedAt && params.now - params.updatedAt <= RECENT_ACTIVITY_MS) {
    return "Recent";
  }
  if (params.updatedAt && params.now - params.updatedAt > STALE_SIGNAL_MS) {
    return "Stale";
  }
  if (params.externalActivity || params.onWatch) {
    return "Inferred";
  }
  return params.updatedAt ? "Stale" : "Inferred";
}

function describeRoomState(state: RoomState): { label: string; cue: string } {
  switch (state) {
    case "supervising":
      return { label: "Always on", cue: "watching operations" };
    case "working":
      return { label: "Working", cue: "typing at workstation" };
    case "idle":
      return { label: "Idle", cue: "resting" };
    case "sleeping":
      return { label: "Resting", cue: "in bed" };
    case "waiting":
      return { label: "Waiting", cue: "question bubble" };
    case "thinking":
      return { label: "Thinking", cue: "thought bubble" };
    case "running-tool":
      return { label: "Running tool", cue: "terminal glow" };
    case "reading":
      return { label: "Reading", cue: "document on desk" };
    case "writing":
      return { label: "Writing", cue: "output page" };
    case "blocked":
      return { label: "Needs help", cue: "amber warning" };
    case "error":
      return { label: "Live error", cue: "red alert" };
    case "completed":
      return { label: "Completed", cue: "green check" };
    case "offline":
      return { label: "Offline", cue: "dim silhouette" };
    case "unknown":
      return { label: "Unknown", cue: "unknown state" };
  }
  return { label: "Unknown", cue: "unknown state" };
}

function parseUtcMillis(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(...values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => typeof value === "number");
  return valid.length ? Math.max(...valid) : null;
}

function formatCompactUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function latestKalshiAutomationAt(
  snapshot: KalshiDashboardSnapshot | null | undefined,
): number | null {
  const scheduler = snapshot?.accelerator?.scheduler;
  return newestTimestamp(
    parseUtcMillis(snapshot?.generated_at_utc),
    parseUtcMillis(scheduler?.latest_scheduled_completed_at_utc),
    parseUtcMillis(scheduler?.latest_weather_timestamp_utc),
    parseUtcMillis(snapshot?.self_improvement?.metrics?.latest_scored_outcome_utc ?? null),
    parseUtcMillis(snapshot?.self_improvement?.metrics?.latest_scored_decision_utc ?? null),
  );
}

function isKalshiAutomationFresh(
  snapshot: KalshiDashboardSnapshot | null | undefined,
  now: number,
): boolean {
  const latest = latestKalshiAutomationAt(snapshot);
  if (latest === null) {
    return false;
  }
  return now - latest <= 15 * 60_000;
}

function hasKalshiLiveReadinessOperationalFailure(
  snapshot: KalshiDashboardSnapshot | null | undefined,
): boolean {
  const checks = snapshot?.live_readiness?.checks;
  if (!checks) {
    return false;
  }
  return [
    checks.paper_log_ok,
    checks.outcome_log_ok,
    checks.risk_controller_ok,
    checks.no_live_trading_ok,
    checks.forward_paper_queue_ok,
    checks.evidence_report_ok,
  ].some((value) => value === false);
}

function resolveKalshiAutomationActivity(
  agentId: string,
  snapshot: KalshiDashboardSnapshot | null | undefined,
  now: number,
): ExternalAgentActivity | null {
  if (!snapshot) {
    return null;
  }
  const latest = latestKalshiAutomationAt(snapshot);
  const fresh = isKalshiAutomationFresh(snapshot, now);
  const scheduler = snapshot.accelerator?.scheduler;
  const metrics = snapshot.self_improvement?.metrics;
  const summary = snapshot.strategy_scorecard?.summary;
  const liveReadiness = snapshot.live_readiness;
  const liveBlocked =
    liveReadiness?.live_order_allowed === false || snapshot.live_order_allowed === false;
  const blocker = liveReadiness?.blockers?.[0] ?? null;
  const operationalFailure = hasKalshiLiveReadinessOperationalFailure(snapshot);
  const base = {
    source: "Kalshi dashboard snapshot",
    updatedAt: latest,
  };

  switch (agentId) {
    case "polymarket-market-watch-agent":
      return {
        ...base,
        state: fresh ? "working" : "waiting",
        statusLabel: fresh ? "Kalshi active" : "Kalshi stale",
        cue: fresh ? "watching paper markets" : "waiting for fresh market read",
        task: `Kalshi paper loops: ${scheduler?.scheduled_run_count ?? 0} scheduled runs, ${scheduler?.weather_run_count ?? 0} weather runs.`,
        detail: fresh
          ? "OpenClaw is receiving fresh Kalshi paper-learning status from the local scheduler bridge."
          : "OpenClaw has a Kalshi snapshot, but it is older than the freshness window.",
      };
    case "polymarket-risk-controller":
      return {
        ...base,
        state: blocker && operationalFailure ? "blocked" : liveBlocked ? "waiting" : "working",
        statusLabel:
          blocker && operationalFailure
            ? "Risk blocked"
            : liveBlocked
              ? "Live gate blocked"
              : "Risk clear",
        cue: blocker && operationalFailure ? "risk gate alert" : "guarding paper/live gates",
        task: blocker ?? "Live trading remains blocked unless the promotion gate passes.",
        detail: liveBlocked
          ? "The risk controller is enforcing the paper-only/live-blocked boundary."
          : "No live-order block was reported in the latest Kalshi snapshot.",
      };
    case "prediction-market-position-exposure-monitor":
      return {
        ...base,
        state: fresh ? "working" : "waiting",
        statusLabel: "Exposure watch",
        cue: "monitoring paper exposure",
        task: `Unresolved paper exposure: ${formatCompactUsd(metrics?.unresolved_paper_exposure_usd)}.`,
        detail:
          "This reads simulated Kalshi exposure from paper logs; it is not live account exposure.",
      };
    case "polymarket-strategy-improvement-analyst":
      return {
        ...base,
        state: fresh ? "working" : "waiting",
        statusLabel: "Learning review",
        cue: "reviewing paper evidence",
        task: `${summary?.scored_accepted_decisions ?? metrics?.scored_decisions ?? 0} scored paper decisions; ${summary?.forward_paper_candidates ?? 0} forward-paper candidates.`,
        detail:
          "Self-improvement may update reversible paper-only strategy state, but it cannot enable live trading.",
      };
    case "prediction-market-resolution-settlement-auditor":
      return {
        ...base,
        state: fresh ? "working" : "waiting",
        statusLabel: "Outcome audit",
        cue: "checking settlement evidence",
        task: `${metrics?.scored_decisions ?? 0} scored decisions; missing outcome rate ${Math.round((metrics?.missing_outcome_rate ?? 0) * 1000) / 10}%.`,
        detail:
          "Outcome scoring is read-only and records paper outcomes only after settlement evidence exists.",
      };
    default:
      return null;
  }
}

function renderKalshiAutomationSummary(snapshot: KalshiDashboardSnapshot | null | undefined) {
  if (!snapshot) {
    return html`
      <div class="agent-room-project__automation agent-room-project__automation--waiting">
        Kalshi automation status will appear here after the dashboard snapshot loads.
      </div>
    `;
  }
  const scheduler = snapshot.accelerator?.scheduler;
  const latest = latestKalshiAutomationAt(snapshot);
  const freshness = latest ? formatRelativeTimestamp(latest) : "unknown";
  const liveStatus =
    snapshot.live_readiness?.readiness ??
    (snapshot.live_order_allowed === false ? "BLOCKED" : "unknown");
  return html`
    <div class="agent-room-project__automation">
      Kalshi bridge: ${snapshot.data_quality?.stale ? "stale" : "active"}. Latest update
      ${freshness}. Runs: ${scheduler?.scheduled_run_count ?? 0} scheduled /
      ${scheduler?.weather_run_count ?? 0} weather. Live readiness: ${liveStatus}.
    </div>
  `;
}

function firstUsefulText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function deriveLearningVelocitySummary(
  snapshot: KalshiDashboardSnapshot | null | undefined,
  now: number,
  snapshotStatus?: { loading?: boolean; error?: string | null },
): LearningVelocitySummary {
  if (!snapshot) {
    if (snapshotStatus?.error) {
      return {
        tone: "stale",
        status: "Kalshi snapshot unavailable",
        headline:
          "Learning telemetry could not load in time. Open the Kalshi dashboard or refresh when the Gateway is less busy.",
        updatedAt: null,
        metrics: [
          { label: "Evidence", value: "unavailable", detail: snapshotStatus.error },
          {
            label: "Next proof",
            value: "refresh",
            detail: "Retry the snapshot after Gateway load drops",
          },
          { label: "Safety", value: "Blocked", detail: "Live trading remains disabled" },
        ],
        changes: [
          "No learning update was confirmed because the snapshot request did not complete.",
        ],
        nextAction: "Inspect Kalshi or retry Refresh before relying on learning velocity.",
        safety: "Paper-only visibility. This panel never enables live trading.",
      };
    }
    return {
      tone: "waiting",
      status: snapshotStatus?.loading ? "Loading Kalshi snapshot" : "Kalshi snapshot pending",
      headline: "Learning telemetry will appear after the Kalshi dashboard loads.",
      updatedAt: null,
      metrics: [
        { label: "Evidence", value: "n/a", detail: "Snapshot has not loaded yet" },
        { label: "Next proof", value: "n/a", detail: "Waiting for paper-learning data" },
        { label: "Safety", value: "Blocked", detail: "Live trading remains disabled" },
      ],
      changes: ["No learning snapshot loaded yet."],
      nextAction: "Refresh after the Kalshi dashboard snapshot is available.",
      safety: "Paper-only visibility. This panel never enables live trading.",
    };
  }

  const latest = latestKalshiAutomationAt(snapshot);
  const fresh = latest !== null && now - latest <= 15 * 60_000;
  const metrics = snapshot.self_improvement?.metrics;
  const scorecard = snapshot.strategy_scorecard;
  const scorecardSummary = scorecard?.summary;
  const governor = snapshot.strategy_governor;
  const volume = snapshot.paper_volume_accelerator;
  const volumeMetrics = volume?.metrics;
  const rapidPlan = volume?.rapid_learning_plan;
  const opportunity = snapshot.opportunity_engine;
  const accuracy = scorecardSummary?.accuracy ?? metrics?.accuracy ?? null;
  const pnl =
    scorecardSummary?.realized_pnl_usd ?? metrics?.realized_paper_pnl_all_time_usd ?? null;
  const scored =
    scorecardSummary?.scored_accepted_decisions ??
    metrics?.scored_decisions ??
    volumeMetrics?.resolved_outcomes ??
    null;
  const scoredLast24 = metrics?.scored_decisions_last_24h ?? null;
  const pausedSegments = scorecardSummary?.paused_segments ?? null;
  const forwardCandidates =
    scorecardSummary?.forward_paper_candidates ??
    opportunity?.metrics?.clean_forward_paper_candidates ??
    null;
  const acceptedOrTested = governor?.accepted_or_tested_count ?? null;
  const latestChange =
    governor?.latest_change ??
    governor?.top_active_hypothesis ??
    governor?.top_blocked_losing_lane ??
    null;
  const bestSegment = snapshot.performance_summary?.best_segment;
  const worstSegment = snapshot.performance_summary?.worst_segment;
  const lesson = scorecard?.improvement_summary?.most_important_lesson;
  const rankedAction = snapshot.top_action ?? snapshot.accelerator?.ranked_actions?.[0] ?? null;
  const nextAction = firstUsefulText(
    volumeMetrics?.what_must_happen_next_to_learn_faster,
    rapidPlan?.primary_bottleneck ? `Remove bottleneck: ${rapidPlan.primary_bottleneck}.` : null,
    rankedAction?.implementation_hint,
    rankedAction?.evidence,
    scorecard?.improvement_summary?.what_needs_to_happen_next?.[0],
    opportunity?.diagnostics?.plain_english,
  );
  const changes = [
    latestChange?.plain_language_reason
      ? `${latestChange.governor_action ?? "Paper change"}: ${latestChange.plain_language_reason}`
      : null,
    lesson?.title
      ? `Lesson: ${lesson.title}${lesson.expected_effect ? `; expected effect: ${lesson.expected_effect}` : ""}`
      : null,
    bestSegment?.segment
      ? `Best segment: ${bestSegment.segment} (${formatPercent(bestSegment.win_rate)}, ${formatCompactUsd(bestSegment.simulated_pnl_usd)}).`
      : null,
    worstSegment?.segment
      ? `Watchlist: ${worstSegment.segment} (${formatPercent(worstSegment.win_rate)}, ${formatCompactUsd(worstSegment.simulated_pnl_usd)}).`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  const liveBlocked =
    snapshot.live_order_allowed === false && snapshot.live_readiness?.live_order_allowed !== true;
  const tone: LearningVelocityTone = snapshot.data_quality?.stale
    ? "stale"
    : fresh || (typeof scoredLast24 === "number" && scoredLast24 > 0)
      ? "active"
      : "watching";
  const status =
    tone === "stale"
      ? "Needs fresh snapshot"
      : tone === "active"
        ? "Learning now"
        : "Watching evidence";
  const headline =
    tone === "stale"
      ? "Kalshi learning data is older than expected; verify the status bridge before relying on it."
      : `Paper-learning has ${formatCount(scored)} scored decisions, ${formatCount(scoredLast24)} scored in the last 24h, and ${formatCount(forwardCandidates)} forward-paper candidate${forwardCandidates === 1 ? "" : "s"}.`;

  return {
    tone,
    status,
    headline,
    updatedAt: latest,
    metrics: [
      {
        label: "Evidence scored",
        value: formatCount(scored),
        detail: `${formatCount(acceptedOrTested)} accepted or tested by governor`,
      },
      {
        label: "24h scoring",
        value: formatCount(scoredLast24),
        detail: `${formatCount(volumeMetrics?.resolved_outcomes)} resolved outcomes total`,
      },
      {
        label: "Accuracy",
        value: formatPercent(accuracy),
        detail: `Avg P&L ${formatCompactUsd(metrics?.average_pnl_per_scored_trade_usd)}`,
      },
      {
        label: "Paper P&L",
        value: formatCompactUsd(pnl),
        detail: `${formatCompactUsd(metrics?.realized_paper_pnl_last_24h_usd)} in last 24h`,
      },
      {
        label: "Paused lanes",
        value: formatCount(pausedSegments),
        detail: "Underperforming paper segments held back",
      },
      {
        label: "Next proof",
        value: formatCount(forwardCandidates),
        detail: "Forward-paper candidates",
      },
    ],
    changes: changes.length ? changes.slice(0, 3) : ["No new learning change was highlighted."],
    nextAction:
      nextAction ??
      "Keep paper scoring, outcome grading, and strategy learner jobs running until stronger evidence appears.",
    safety: liveBlocked
      ? "Paper-only: live trading and live orders are blocked."
      : "Safety check needed: live-order flag was not explicitly blocked.",
  };
}

function renderLearningVelocityPanel(
  snapshot: KalshiDashboardSnapshot | null | undefined,
  status?: { loading?: boolean; error?: string | null },
) {
  const summary = deriveLearningVelocitySummary(snapshot, Date.now(), status);
  return html`
    <section
      class="agent-learning-velocity agent-learning-velocity--${summary.tone}"
      aria-label="Prediction Markets learning velocity"
    >
      <div class="agent-learning-velocity__lead">
        <span>Self-Improvement / Learning Queue - Learning Velocity</span>
        <strong>${summary.status}</strong>
        <p>${summary.headline}</p>
        <em
          >${summary.updatedAt
            ? `Last signal ${formatRelativeTimestamp(summary.updatedAt)}`
            : "No live signal yet"}</em
        >
      </div>
      <div class="agent-learning-velocity__metrics">
        ${summary.metrics.map(
          (metric) => html`
            <div>
              <span>${metric.label}</span>
              <strong>${metric.value}</strong>
              <em>${metric.detail}</em>
            </div>
          `,
        )}
      </div>
      <div class="agent-learning-velocity__notes">
        <div>
          <span>What changed</span>
          <ul>
            ${summary.changes.map((change) => html`<li>${change}</li>`)}
          </ul>
        </div>
        <div>
          <span>What stayed blocked / next best proof</span>
          <p>${summary.nextAction}</p>
          <strong>${summary.safety}</strong>
        </div>
      </div>
    </section>
  `;
}

function severityLabel(severity: DashboardIssueSeverity): string {
  switch (severity) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
  return "Low";
}

function dashboardSignalToneFromTimestamp(
  timestamp: number | null | undefined,
  now: number,
): DashboardSignalTone {
  if (!timestamp) {
    return "checking";
  }
  const ageMs = now - timestamp;
  if (ageMs <= 2 * 60_000) {
    return "live";
  }
  if (ageMs <= 15 * 60_000) {
    return "recent";
  }
  return "stale";
}

function timestampSignalDetail(
  prefix: string,
  timestamp: number | null | undefined,
  fallback: string,
): string {
  return timestamp ? `${prefix} ${formatRelativeTimestamp(timestamp)}` : fallback;
}

function renderNextWakeDetail(nextWakeAtMs: number | null | undefined): string {
  return nextWakeAtMs ? `Next run ${formatRelativeTimestamp(nextWakeAtMs)}` : "No next run queued";
}

function countChannelAccounts(snapshot: ChannelsStatusSnapshot | null): number {
  if (!snapshot) {
    return 0;
  }
  return Object.values(snapshot.channelAccounts).reduce((total, accounts) => {
    return total + accounts.length;
  }, 0);
}

function buildDashboardSignals(props: AgentRoomProps, now = Date.now()): DashboardSignal[] {
  const kalshiSignalAt = latestKalshiAutomationAt(props.kalshiDashboard);
  const kalshiSnapshotStale = props.kalshiDashboard?.dashboard_refresh?.stale === true;
  const kalshiInputStale = props.kalshiDashboard?.data_quality?.stale === true;
  const kalshiSignalTone = dashboardSignalToneFromTimestamp(kalshiSignalAt, now);
  const channelTimestamp = props.channels?.snapshot?.ts ?? props.channels?.lastSuccess ?? null;
  return [
    props.connected
      ? {
          label: "Gateway",
          value: "Connected",
          detail: "Live WebSocket is active",
          tone: "live",
        }
      : {
          label: "Gateway",
          value: "Offline",
          detail: "Dashboard cannot trust live status until the Gateway reconnects",
          tone: "offline",
        },
    props.opsSummary?.error
      ? {
          label: "Ops Summary",
          value: "Problem",
          detail: props.opsSummary.error,
          tone: "error",
        }
      : props.opsSummary?.result
        ? {
            label: "Ops Summary",
            value: "Verified",
            detail: timestampSignalDetail("Checked", props.opsSummary.result.ts, "Checked"),
            tone: dashboardSignalToneFromTimestamp(props.opsSummary.result.ts, now),
          }
        : {
            label: "Ops Summary",
            value: props.opsSummary?.loading ? "Checking" : "Pending",
            detail: "Waiting for the operations summary",
            tone: "checking",
          },
    props.sessions.error
      ? {
          label: "Agents",
          value: "Problem",
          detail: props.sessions.error,
          tone: "error",
        }
      : props.sessions.result
        ? {
            label: "Agents",
            value: `${props.sessions.result.count} sessions`,
            detail: timestampSignalDetail(
              "Session list",
              props.sessions.result.ts,
              "Session list loaded",
            ),
            tone: dashboardSignalToneFromTimestamp(props.sessions.result.ts, now),
          }
        : {
            label: "Agents",
            value: props.sessions.loading ? "Checking" : "Pending",
            detail: "Waiting for session history",
            tone: "checking",
          },
    props.runtimeStatus.error && !props.runtimeStatus.result
      ? {
          label: "Model RAM",
          value: "Problem",
          detail: props.runtimeStatus.error,
          tone: "error",
        }
      : props.runtimeStatus.result
        ? {
            label: "Model RAM",
            value: `${props.runtimeStatus.result.localModels.count} loaded`,
            detail: `${formatBytes(props.runtimeStatus.result.localModels.totalLoadedBytes)} model RAM`,
            tone: dashboardSignalToneFromTimestamp(props.runtimeStatus.result.ts, now),
          }
        : {
            label: "Model RAM",
            value: props.runtimeStatus.loading ? "Checking" : "Pending",
            detail: "Waiting for local model telemetry",
            tone: "checking",
          },
    props.cron?.error
      ? {
          label: "Automation",
          value: "Problem",
          detail: props.cron.error,
          tone: "error",
        }
      : props.cron?.status
        ? {
            label: "Automation",
            value: props.cron.status.enabled ? "Enabled" : "Paused",
            detail: `${props.cron.status.jobs} jobs - ${renderNextWakeDetail(
              props.cron.status.nextWakeAtMs,
            )}`,
            tone: props.cron.status.enabled ? "recent" : "stale",
          }
        : {
            label: "Automation",
            value: props.cron?.loading ? "Checking" : "Pending",
            detail: "Waiting for cron status",
            tone: "checking",
          },
    props.channels?.error && !props.channels.snapshot
      ? {
          label: "Channels",
          value: "Problem",
          detail: props.channels.error,
          tone: "error",
        }
      : props.channels?.snapshot || props.channels?.lastSuccess
        ? {
            label: "Channels",
            value: `${countChannelAccounts(props.channels.snapshot)} accounts`,
            detail: timestampSignalDetail("Checked", channelTimestamp, "Channel snapshot loaded"),
            tone: dashboardSignalToneFromTimestamp(channelTimestamp, now),
          }
        : {
            label: "Channels",
            value: props.channels?.loading ? "Checking" : "Pending",
            detail: "Waiting for channel status",
            tone: "checking",
          },
    props.kalshiDashboardError && !props.kalshiDashboard
      ? {
          label: "Prediction Markets",
          value: "Problem",
          detail: props.kalshiDashboardError,
          tone: "error",
        }
      : props.kalshiDashboard
        ? {
            label: "Prediction Markets",
            value: kalshiSnapshotStale
              ? "Snapshot stale"
              : kalshiInputStale
                ? "Input stale"
                : "Learning",
            detail: kalshiSnapshotStale
              ? timestampSignalDetail("Snapshot", kalshiSignalAt, "Snapshot is stale")
              : kalshiInputStale
                ? timestampSignalDetail(
                    "Fresh snapshot; upstream input marked stale",
                    kalshiSignalAt,
                    "Upstream input marked stale",
                  )
                : timestampSignalDetail("Signal", kalshiSignalAt, "Paper-learning snapshot loaded"),
            tone: kalshiSnapshotStale
              ? "stale"
              : kalshiInputStale && kalshiSignalTone === "live"
                ? "recent"
                : kalshiInputStale
                  ? kalshiSignalTone
                  : kalshiSignalTone,
          }
        : {
            label: "Prediction Markets",
            value: props.kalshiDashboardLoading ? "Checking" : "Pending",
            detail: "Waiting for paper-learning status",
            tone: "checking",
          },
  ];
}

function renderDashboardSignals(props: AgentRoomProps) {
  const signals = buildDashboardSignals(props);
  const customizationProtection = props.opsSummary?.result?.checks.customizationProtection;
  return html`
    <section class="agent-signal-strip" aria-label="Dashboard data sources">
      <div class="agent-signal-strip__header">
        <strong>Dashboard Data Sources</strong>
        <span>Live, recent, stale, or problem signals before you trust the room.</span>
      </div>
      <div class="agent-signal-strip__grid">
        ${signals.map(
          (signal) => html`
            <div class="agent-signal agent-signal--${signal.tone}">
              <span>${signal.label}</span>
              <strong>${signal.value}</strong>
              <em>${signal.detail}</em>
            </div>
          `,
        )}
      </div>
      ${customizationProtection
        ? renderCustomizationProtectionCard(customizationProtection)
        : nothing}
    </section>
  `;
}

function customizationProtectionLabel(
  status: NonNullable<OpsSummaryResult["checks"]["customizationProtection"]>["status"],
): string {
  switch (status) {
    case "protected":
      return "Protected";
    case "needs_review":
      return "Needs Review";
    case "missing":
      return "Missing";
    case "unknown":
      return "Not configured";
  }
  return "Not configured";
}

function renderCustomizationGeneratedAt(generatedAtUtc: string | null): string {
  if (!generatedAtUtc) {
    return "No generated timestamp";
  }
  const timestamp = Date.parse(generatedAtUtc);
  return Number.isFinite(timestamp)
    ? `Generated ${formatRelativeTimestamp(timestamp)}`
    : `Generated ${generatedAtUtc}`;
}

function renderCustomizationProtectionCard(
  protection: NonNullable<OpsSummaryResult["checks"]["customizationProtection"]>,
) {
  const patchState =
    protection.patchApplies === true
      ? "Patch applies"
      : protection.patchApplies === false
        ? "Patch blocked"
        : "Patch not checked";
  const driftState =
    protection.contentDriftCount === 0 && protection.missingFileCount === 0
      ? "No drift"
      : `${protection.contentDriftCount} changed / ${protection.missingFileCount} missing`;
  return html`
    <div
      class="agent-customization-protection agent-customization-protection--${protection.status}"
      aria-label="Customization Protection"
    >
      <div class="agent-customization-protection__lead">
        <span>Customization Protection</span>
        <strong>${customizationProtectionLabel(protection.status)}</strong>
        <em>${protection.detail}</em>
      </div>
      <dl>
        <div>
          <dt>Protected files</dt>
          <dd>${protection.fileCount}</dd>
        </div>
        <div>
          <dt>Bundle age</dt>
          <dd>${renderCustomizationGeneratedAt(protection.generatedAtUtc)}</dd>
        </div>
        <div>
          <dt>Patch</dt>
          <dd>${patchState}</dd>
        </div>
        <div>
          <dt>Drift</dt>
          <dd>${driftState}</dd>
        </div>
        <div>
          <dt>Update guard</dt>
          <dd>${protection.updateGuardActive ? "Active" : "Needs review"}</dd>
        </div>
      </dl>
    </div>
  `;
}

function renderAttentionCommandCenter(
  summary: DashboardHealthSummary,
  onInspectAttention?: (target: AttentionTarget) => void,
) {
  const verdict = summary.attentionVerdict;
  return html`
    <section
      class="agent-attention-center agent-attention-center--${verdict.tone}"
      aria-label="What Needs My Attention?"
    >
      <div class="agent-attention-center__lead">
        <span>What Needs My Attention?</span>
        <strong>${verdict.label}</strong>
        <em>${verdict.summary}</em>
      </div>
      <div class="agent-attention-center__body">
        ${summary.attentionActions.length
          ? html`
              <div class="agent-attention-actions" aria-label="Top Next Actions">
                <div class="agent-attention-actions__title">Top Next Actions</div>
                <ol>
                  ${summary.attentionActions.map(
                    (action) => html`
                      <li class="agent-attention-action agent-attention-action--${action.severity}">
                        <div class="agent-attention-action__top">
                          <strong>${action.title}</strong>
                          <span>${action.confidence}</span>
                        </div>
                        <p>${action.whyItMatters}</p>
                        <div class="agent-attention-action__next">${action.recommendedAction}</div>
                        <div class="agent-attention-action__footer">
                          <em
                            >${action.detectedAt
                              ? `Last verified ${formatRelativeTimestamp(action.detectedAt)}`
                              : "No timestamp"}</em
                          >
                          <span class="agent-attention-action__safety"
                            >${actionSafetyHint(action.target)}</span
                          >
                          <button
                            type="button"
                            class="btn btn--sm btn--subtle"
                            @click=${() => onInspectAttention?.(action.target)}
                          >
                            ${issueTargetButtonLabel(action.target)}
                          </button>
                        </div>
                      </li>
                    `,
                  )}
                </ol>
              </div>
            `
          : html`
              <div class="agent-attention-empty">
                <strong>No action needed</strong>
                <span>Expected dormant agents are not counted as failures.</span>
              </div>
            `}
        <div class="agent-attention-facts" aria-label="Healthy status facts">
          <span><strong>${summary.issues.length}</strong> open issues</span>
          <span>${summary.nextAutomation}</span>
          <span>${summary.nextKalshiActivity}</span>
          <span>${summary.memoryVerdict.text}</span>
          <span>
            ${summary.gatewayVerifiedAt
              ? `Gateway verified ${formatRelativeTimestamp(summary.gatewayVerifiedAt)}`
              : summary.gatewaySummaryLoading
                ? "Gateway summary checking"
                : summary.gatewaySummaryError
                  ? `Gateway summary: ${summary.gatewaySummaryError}`
                  : "Gateway summary pending"}
          </span>
        </div>
        <div class="agent-attention-changes" aria-label="What changed recently">
          <strong>What changed recently</strong>
          <span>Since this tab loaded/refreshed</span>
          <ul>
            ${summary.changedRecently.slice(0, 3).map((change) => html`<li>${change}</li>`)}
          </ul>
        </div>
      </div>
    </section>
  `;
}

function renderIssueQueue(
  summary: DashboardHealthSummary,
  onInspectAttention?: (target: AttentionTarget) => void,
) {
  return html`
    <section class="agent-issue-queue" aria-label="Issue Queue">
      <div class="agent-issue-queue__header">
        <div>
          <strong>Issue Queue</strong>
          <span>Top actionable items</span>
        </div>
        <b>${summary.topIssues.length}</b>
      </div>
      ${summary.topIssues.length
        ? html`
            <ol class="agent-issue-list">
              ${summary.topIssues.map(
                (issue) => html`
                  <li class="agent-issue-card agent-issue-card--${issue.severity}">
                    <div class="agent-issue-card__top">
                      <span>${severityLabel(issue.severity)}</span>
                      <em
                        >${issue.detectedAt
                          ? formatRelativeTimestamp(issue.detectedAt)
                          : "No timestamp"}</em
                      >
                    </div>
                    <span class="agent-issue-card__problem">${issue.title}</span>
                    <strong>${issue.plainSummary || issue.title}</strong>
                    <p>${issue.whyItMatters}</p>
                    <dl>
                      <div>
                        <dt>Affected</dt>
                        <dd>${issue.affected}</dd>
                      </div>
                      <div>
                        <dt>Likely cause</dt>
                        <dd>${issue.likelyCause}</dd>
                      </div>
                      <div>
                        <dt>Safest next step</dt>
                        <dd>${issue.recommendedAction}</dd>
                      </div>
                      <div>
                        <dt>Inspection target</dt>
                        <dd>${issue.nextInspection}</dd>
                      </div>
                      <div>
                        <dt>Confidence</dt>
                        <dd>${issue.confidence}</dd>
                      </div>
                    </dl>
                    <div class="agent-issue-card__actions">
                      <span>${actionSafetyHint(issue.target)}</span>
                      <button
                        type="button"
                        class="btn btn--xs btn--subtle"
                        @click=${() => onInspectAttention?.(issue.target)}
                      >
                        ${issueTargetButtonLabel(issue.target)}
                      </button>
                    </div>
                  </li>
                `,
              )}
            </ol>
          `
        : html`
            <div class="agent-issue-empty">
              No actionable issues detected. Expected dormant agents are not counted as failures.
            </div>
          `}
    </section>
  `;
}

function buildRoomAgents(props: AgentRoomProps): RoomAgent[] {
  const rows = props.sessions.result?.sessions ?? [];
  const now = Date.now();
  const agents = dedupeRoomAgents(props.agents);
  const index = buildAgentRoomDerivationIndex(rows, props.defaultId, props.runtimeStatus.result);
  return agents.map((agent) => {
    const recentSessions = recentSessionsForAgent(agent.id, index);
    const latestSession = recentSessions[0] ?? null;
    const model = resolveAgentModel(agent);
    const sessionModel = latestSession?.model
      ? latestSession.modelProvider && !latestSession.model.includes("/")
        ? `${latestSession.modelProvider}/${latestSession.model}`
        : latestSession.model
      : null;
    const director = isControlDirector(agent, props.defaultId);
    const metadata = resolveAgentMetadata(agent, director);
    const onWatch = isOnWatchAgent(metadata);
    const projectRoom = resolveProjectRoom(metadata);
    const liveState = deriveRoomState(latestSession, now);
    const externalActivity =
      liveState === "sleeping" || liveState === "idle" || !latestSession
        ? resolveKalshiAutomationActivity(agent.id, props.kalshiDashboard, now)
        : null;
    const state =
      props.connected && externalActivity
        ? externalActivity.state
        : props.connected && onWatch && (liveState === "sleeping" || liveState === "idle")
          ? "supervising"
          : props.connected
            ? liveState
            : "offline";
    const description = describeRoomState(state);
    const loadedModel = resolveLoadedModelForAgent([model, sessionModel], index);
    const installedModel = resolveInstalledModelForAgent([model, sessionModel], index);
    const modelRam = describeAgentModelRam(loadedModel, props.runtimeStatus.result);
    const modelRamWhenLiveText = describeAgentModelRamWhenLive(
      loadedModel,
      installedModel,
      props.runtimeStatus.result,
    );
    const titleLabel = resolveRoomAgentTitle(agent, director, metadata);
    const rawPersonName = resolveRoomAgentPersonName(agent);
    const personName =
      rawPersonName && rawPersonName.toLowerCase() !== titleLabel.toLowerCase()
        ? rawPersonName
        : null;
    const updatedAt =
      latestSession?.updatedAt ??
      latestSession?.endedAt ??
      latestSession?.startedAt ??
      externalActivity?.updatedAt ??
      null;
    return {
      agent,
      label: personName ?? titleLabel,
      personName,
      titleLabel,
      metadata,
      director,
      onWatch,
      projectRoom,
      model,
      modelFallbacks: resolveAgentModelFallbacks(agent),
      lastRunModel: sessionModel,
      loadedModel,
      installedModel,
      modelRamText: modelRam.text,
      modelRamWhenLiveText,
      modelRamBadge: modelRam.badge,
      state,
      statusLabel: externalActivity?.statusLabel ?? description.label,
      cue: externalActivity?.cue ?? description.cue,
      active: agent.id === props.selectedAgentId,
      latestSession,
      recentSessions,
      updatedAt,
      externalActivity,
      signalConfidence: deriveSignalConfidence({
        state,
        updatedAt,
        externalActivity,
        onWatch,
        now,
      }),
      thinkingPolicy: resolveControlDirectorThinkingPolicy(agent, latestSession),
    };
  });
}

function countStates(roomAgents: RoomAgent[]) {
  return roomAgents.reduce(
    (acc, entry) => {
      if (entry.state === "supervising") {
        acc.supervising += 1;
      } else if (
        entry.state === "working" ||
        entry.state === "thinking" ||
        entry.state === "running-tool" ||
        entry.state === "reading" ||
        entry.state === "writing" ||
        entry.state === "waiting"
      ) {
        acc.active += 1;
      } else if (entry.state === "error" || entry.state === "blocked") {
        acc.attention += 1;
      } else {
        acc.resting += 1;
      }
      return acc;
    },
    { active: 0, resting: 0, attention: 0, supervising: 0 },
  );
}

function groupRoomAgents(
  roomAgents: RoomAgent[],
): Array<{ room: ProjectRoom; agents: RoomAgent[] }> {
  const grouped = new Map<string, RoomAgent[]>();
  for (const entry of roomAgents) {
    const existing = grouped.get(entry.projectRoom.id) ?? [];
    existing.push(entry);
    grouped.set(entry.projectRoom.id, existing);
  }
  return PROJECT_ROOM_ORDER.map((id) => {
    const room = PROJECT_ROOMS[id] ?? PROJECT_ROOMS.general;
    return { room, agents: grouped.get(id) ?? [] };
  }).filter((group) => group.agents.length > 0);
}

export function findUnmappedRoomAgents(roomAgents: RoomAgent[]): RoomAgent[] {
  return roomAgents.filter((entry) => entry.projectRoom.id === "general");
}

function renderUnmappedAgentsGuard(
  unmappedAgents: RoomAgent[],
  onAssignAgentRoom?: (agentId: string, roomId: string) => void,
) {
  if (unmappedAgents.length === 0) {
    return html`
      <div class="callout success">
        Agent map complete: every current agent is assigned to a named workspace room.
      </div>
    `;
  }
  return html`
    <div class="callout warning">
      <strong
        >${unmappedAgents.length} unmapped
        ${unmappedAgents.length === 1 ? "agent" : "agents"}</strong
      >
      still ${unmappedAgents.length === 1 ? "needs" : "need"} a workspace room:
      ${unmappedAgents.map((entry) => entry.label).join(", ")}.
      <div class="agent-room-unmapped-actions">
        ${unmappedAgents.map(
          (entry) => html`
            <label>
              <span>${entry.label}</span>
              <select
                aria-label=${`Assign ${entry.label} to a workspace room`}
                @change=${(event: Event) =>
                  onAssignAgentRoom?.(
                    entry.agent.id,
                    (event.currentTarget as HTMLSelectElement).value,
                  )}
              >
                <option value="">Assign to room…</option>
                ${ASSIGNABLE_PROJECT_ROOM_IDS.map(
                  (roomId) => html`
                    <option value=${roomId}>${PROJECT_ROOMS[roomId]?.label ?? roomId}</option>
                  `,
                )}
              </select>
            </label>
          `,
        )}
      </div>
      <small
        >This saves the room assignment to the canonical agent config and refreshes the live
        workspace.</small
      >
    </div>
  `;
}

function expectsLoadedLocalModelCoverage(entry: RoomAgent): boolean {
  if (!isAwakeRoomState(entry.state)) {
    return false;
  }
  if (entry.loadedModel) {
    return true;
  }
  if (entry.externalActivity) {
    return false;
  }
  if (entry.latestSession?.status === "running") {
    return true;
  }
  return false;
}

function issueNeedsUserAction(issue: DashboardIssue): boolean {
  return issue.severity !== "low";
}

function issueSeverityRank(severity: DashboardIssueSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
  return 3;
}

function sortIssues(issues: DashboardIssue[]): DashboardIssue[] {
  return issues.toSorted((a, b) => {
    const priority = a.priority - b.priority;
    if (priority !== 0) {
      return priority;
    }
    const severity = issueSeverityRank(a.severity) - issueSeverityRank(b.severity);
    if (severity !== 0) {
      return severity;
    }
    return (b.detectedAt ?? 0) - (a.detectedAt ?? 0);
  });
}

function healthStateRank(state: DashboardHealthState): number {
  switch (state) {
    case "Critical":
      return 0;
    case "Degraded":
      return 1;
    case "Needs Review":
      return 2;
    case "Watching":
      return 3;
    case "Healthy":
      return 4;
  }
  return 4;
}

function dashboardStateFromGateway(state: OpsSummaryResult["state"]): DashboardHealthState {
  switch (state) {
    case "critical":
      return "Critical";
    case "degraded":
      return "Degraded";
    case "needs_review":
      return "Needs Review";
    case "watching":
      return "Watching";
    case "healthy":
      return "Healthy";
  }
  return "Healthy";
}

function dashboardToneFromState(state: DashboardHealthState): DashboardHealthSummary["tone"] {
  switch (state) {
    case "Critical":
      return "critical";
    case "Degraded":
      return "degraded";
    case "Needs Review":
      return "review";
    case "Watching":
      return "watching";
    case "Healthy":
      return "healthy";
  }
  return "healthy";
}

function attentionVerdictFromState(
  state: DashboardHealthState,
  actions: AttentionAction[],
): AttentionVerdict {
  const first = actions[0] ?? null;
  const summarizeAction = (action: AttentionAction) =>
    `${action.title.replace(/[.!?]\s*$/, "")}. ${action.recommendedAction}`;
  switch (state) {
    case "Critical":
      return {
        label: "Critical issue",
        tone: "critical",
        summary: first
          ? summarizeAction(first)
          : "OpenClaw has a critical issue that needs immediate review.",
      };
    case "Degraded":
      return {
        label: "Some systems need attention",
        tone: "degraded",
        summary: first
          ? summarizeAction(first)
          : "Some OpenClaw signals are degraded and should be reviewed.",
      };
    case "Needs Review":
      return {
        label: "Review recommended",
        tone: "review",
        summary: first
          ? summarizeAction(first)
          : "OpenClaw found something worth checking before you rely on automation.",
      };
    case "Watching":
      return {
        label: "Watching",
        tone: "watching",
        summary:
          "OpenClaw is running and watching active responsibilities. No action is needed right now.",
      };
    case "Healthy":
      return {
        label: "All clear",
        tone: "healthy",
        summary: "OpenClaw is running normally. No action is needed right now.",
      };
  }
  return {
    label: "All clear",
    tone: "healthy",
    summary: "OpenClaw is running normally. No action is needed right now.",
  };
}

function attentionActionsFromIssues(issues: DashboardIssue[]): AttentionAction[] {
  return issues
    .filter(issueNeedsUserAction)
    .slice(0, ATTENTION_ACTION_LIMIT)
    .map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      title: issue.plainSummary || issue.title,
      whyItMatters: issue.whyItMatters,
      recommendedAction: issue.recommendedAction,
      target: issue.target,
      detectedAt: issue.detectedAt,
      confidence: issue.confidence,
    }));
}

function mergeOpsSummaryIssues(
  localIssues: DashboardIssue[],
  opsSummary?: OpsSummaryResult | null,
  currentCron?: AgentRoomProps["cron"],
): DashboardIssue[] {
  if (!opsSummary) {
    return localIssues;
  }
  const currentCronFailures =
    !currentCron || currentCron.loading || currentCron.error || !currentCron.status
      ? null
      : new Set(
          currentCron.jobs
            .filter(
              (job) =>
                job.enabled &&
                (job.state?.lastStatus === "error" ||
                  job.state?.lastRunStatus === "error" ||
                  (job.state?.consecutiveErrors ?? 0) > 0),
            )
            .map((job) => job.id),
        );
  const issues = new Map<string, DashboardIssue>();
  for (const issue of localIssues) {
    issues.set(issue.id, issue);
  }
  for (const issue of opsSummary.issues ?? []) {
    if (issue.source === "cron" && currentCronFailures !== null) {
      const target = parseOpsCronRunTarget(issue.id);
      if (!target || !currentCronFailures.has(target.jobId)) {
        continue;
      }
    }
    if (issue.source === "cron" && currentCronFailures === null) {
      continue;
    }
    const target: AttentionTarget =
      issue.source === "cron"
        ? (parseOpsCronRunTarget(issue.id) ?? {
            kind: "appTab",
            tab: "cron",
            label: "Open Cron Jobs",
          })
        : issue.source === "channel"
          ? (parseOpsChannelStartTarget(issue.id) ?? {
              kind: "appTab",
              tab: "channels",
              label: "Open Channels",
            })
          : issue.source === "customization"
            ? {
                kind: "agentsPanel",
                panel: "room",
                label: "Review protection",
              }
            : issue.source === "gateway"
              ? { kind: "appTab", tab: "overview", label: "Open Overview" }
              : { kind: "agentsPanel", panel: "room", label: "Review RAM monitor" };
    const priority =
      issue.source === "gateway"
        ? 10
        : issue.source === "channel"
          ? 15
          : issue.source === "customization"
            ? 18
            : issue.source === "cron"
              ? 25
              : 50;
    issues.set(
      `gateway-${issue.id}`,
      dashboardIssue({
        id: `gateway-${issue.id}`,
        severity: issue.severity,
        title: issue.title,
        affected: issue.affected,
        detectedAt: issue.detectedAt,
        likelyCause: issue.likelyCause,
        nextInspection: issue.nextInspection,
        plainSummary: issue.plainSummary ?? issue.title,
        whyItMatters: issue.whyItMatters ?? issue.affected,
        recommendedAction:
          target.kind === "cronRun"
            ? "Confirm a one-time rerun, then inspect the latest Cron Jobs result."
            : target.kind === "channelStart"
              ? (issue.recommendedAction ??
                "Confirm a channel retry, then verify the channel reconnects.")
              : (issue.recommendedAction ?? issue.nextInspection),
        target,
        confidence:
          issue.source === "runtime" ||
          issue.source === "memory" ||
          issue.source === "customization"
            ? "Live"
            : "Recent",
        priority,
      }),
    );
  }
  return sortIssues([...issues.values()]);
}

function describeNextAutomation(cron: AgentRoomProps["cron"]): string {
  const nextRunAt = cron?.jobs
    .map((job) => job.state?.nextRunAtMs ?? null)
    .filter((value): value is number => typeof value === "number")
    .toSorted((a, b) => a - b)[0];
  if (nextRunAt) {
    return `Next scheduled automation ${formatRelativeTimestamp(nextRunAt)}.`;
  }
  if (cron?.loading) {
    return "Checking scheduled automation.";
  }
  return "No scheduled automation time is visible yet.";
}

function describeNextKalshiActivity(snapshot: KalshiDashboardSnapshot | null | undefined): string {
  const latest = latestKalshiAutomationAt(snapshot);
  if (!snapshot) {
    return "Kalshi watch status has not loaded yet.";
  }
  if (latest) {
    return `Latest Kalshi/watch signal ${formatRelativeTimestamp(latest)}.`;
  }
  return "Kalshi watch is configured, but no timestamped signal is visible.";
}

function createDashboardIssues(params: {
  roomAgents: RoomAgent[];
  runtimeStatus: AgentRoomRuntimeStatusState;
  cron?: AgentRoomProps["cron"];
  channels?: AgentRoomProps["channels"];
  kalshiDashboard?: KalshiDashboardSnapshot | null;
  opsSummary?: OpsSummaryResult | null;
  connected: boolean;
  now: number;
}): DashboardIssue[] {
  const issues: DashboardIssue[] = [];
  if (!params.connected) {
    issues.push(
      dashboardIssue({
        id: "gateway-disconnected",
        severity: "critical",
        title: "Gateway connection lost",
        affected: "Control UI",
        detectedAt: params.now,
        likelyCause: "The browser is not connected to the Gateway event stream.",
        nextInspection:
          "Check Gateway status and refresh the dashboard after connectivity returns.",
        plainSummary: "OpenClaw is not connected to the Gateway.",
        whyItMatters:
          "The dashboard cannot verify live agent or automation status until the Gateway is reachable.",
        recommendedAction: "Open Overview and check the Gateway connection.",
        target: { kind: "appTab", tab: "overview", label: "Open Overview" },
        confidence: "Live",
        priority: 10,
      }),
    );
  }
  if (params.runtimeStatus.error) {
    issues.push(
      dashboardIssue({
        id: "runtime-telemetry-error",
        severity: params.runtimeStatus.result ? "medium" : "high",
        title: "Runtime telemetry needs review",
        affected: "RAM and model telemetry",
        detectedAt: params.runtimeStatus.result?.ts ?? params.now,
        likelyCause: params.runtimeStatus.error,
        nextInspection: "Open the RAM breakdown and verify agents.runtime.status.",
        plainSummary: "OpenClaw cannot fully verify model and memory status.",
        whyItMatters: "RAM and loaded-model readings may be incomplete until telemetry recovers.",
        recommendedAction: "Review the RAM monitor and refresh after the Gateway settles.",
        target: { kind: "agentsPanel", panel: "room", label: "Review RAM monitor" },
        confidence: params.runtimeStatus.result ? "Recent" : "Live",
        priority: 50,
      }),
    );
  }
  if (params.channels?.error) {
    issues.push(
      dashboardIssue({
        id: "channel-status-error",
        severity: "medium",
        title: "Channel status needs review",
        affected: "Messaging channels",
        detectedAt: params.channels.lastSuccess ?? params.now,
        likelyCause: params.channels.error,
        nextInspection: "Open Channels and verify Discord or other active channel status.",
        plainSummary: "A messaging channel needs review.",
        whyItMatters: "OpenClaw may miss or fail to send messages on that channel.",
        recommendedAction: "Open Channels and verify the active messaging connection.",
        target: { kind: "appTab", tab: "channels", label: "Open Channels" },
        confidence: attentionConfidenceFromTimestamp(params.channels.lastSuccess, params.now),
        priority: 15,
      }),
    );
  }
  for (const job of params.cron?.jobs ?? []) {
    if (!job.enabled) {
      continue;
    }
    if (
      job.state?.lastStatus === "error" ||
      job.state?.lastRunStatus === "error" ||
      (job.state?.consecutiveErrors ?? 0) > 0
    ) {
      const safetyOrRisk = isSafetyOrRiskAutomation(job);
      issues.push(
        dashboardIssue({
          id: `cron-${job.id}`,
          severity: (job.state?.consecutiveErrors ?? 0) > 1 ? "high" : "medium",
          title: "Scheduled job failed",
          affected: job.name,
          detectedAt: job.state?.lastRunAtMs ?? job.updatedAtMs,
          likelyCause:
            job.state?.lastError ?? job.state?.lastErrorReason ?? "The latest cron run failed.",
          nextInspection:
            "Open Cron Jobs, inspect the latest run, then rerun only if the job is safe.",
          plainSummary: `The scheduled job "${job.name}" failed.`,
          whyItMatters: safetyOrRisk
            ? "This may affect safety, risk, or market-watch automation."
            : "This automation may be stale until the next successful run.",
          recommendedAction:
            "Confirm a one-time rerun, then inspect the latest Cron Jobs result before relying on it.",
          target: { kind: "cronRun", jobId: job.id, label: "Rerun safely" },
          confidence: attentionConfidenceFromTimestamp(
            job.state?.lastRunAtMs ?? job.updatedAtMs,
            params.now,
            true,
          ),
          priority: safetyOrRisk ? 20 : 25,
        }),
      );
    }
  }
  for (const entry of params.roomAgents) {
    if (entry.state === "error" || entry.state === "blocked") {
      issues.push(
        dashboardIssue({
          id: `agent-${entry.agent.id}-${entry.state}`,
          severity: entry.state === "error" ? "high" : "medium",
          title: entry.state === "error" ? "Agent error" : "Agent blocked",
          affected: entry.label,
          detectedAt: entry.updatedAt,
          likelyCause: entry.latestSession?.lastMessagePreview ?? entry.cue,
          nextInspection: "Select the worker and inspect Recent Actions plus the latest session.",
          plainSummary: `${entry.label} is ${entry.state === "error" ? "erroring" : "blocked"}.`,
          whyItMatters: "This agent may not finish its current responsibility without attention.",
          recommendedAction: "Select the worker and inspect Recent Actions.",
          target: { kind: "agent", agentId: entry.agent.id, label: "Inspect worker" },
          confidence: attentionConfidenceFromTimestamp(entry.updatedAt, params.now, true),
          priority: 30,
        }),
      );
    }
  }
  const missingModelAgents = params.roomAgents.filter(
    (entry) => expectsLoadedLocalModelCoverage(entry) && !entry.loadedModel,
  );
  if (missingModelAgents.length > 0) {
    issues.push(
      dashboardIssue({
        id: "missing-model-coverage",
        severity: "medium",
        title: "Awake agent without loaded local model",
        affected: `${missingModelAgents.length} agent${missingModelAgents.length === 1 ? "" : "s"}`,
        detectedAt: params.now,
        likelyCause: missingModelAgents
          .map((entry) => entry.label)
          .slice(0, 3)
          .join(", "),
        nextInspection: "Open the selected worker model fields and the LLM active coverage tile.",
        plainSummary: `${missingModelAgents.length} awake agent${
          missingModelAgents.length === 1 ? "" : "s"
        } may not have a loaded local model.`,
        whyItMatters:
          "An actively model-running agent should have matching model memory telemetry.",
        recommendedAction: "Review the RAM monitor and selected-worker model fields.",
        target: { kind: "agentsPanel", panel: "room", label: "Review RAM monitor" },
        confidence: "Live",
        priority: 50,
      }),
    );
  }
  const latestKalshi = latestKalshiAutomationAt(params.kalshiDashboard);
  const kalshiInputStale = params.kalshiDashboard?.data_quality?.stale === true;
  const kalshiSnapshotTooOld = latestKalshi !== null && params.now - latestKalshi > KALSHI_STALE_MS;
  if (kalshiInputStale || kalshiSnapshotTooOld) {
    issues.push(
      dashboardIssue({
        id: "kalshi-stale",
        severity: "medium",
        title: kalshiInputStale
          ? "Prediction Markets input data is stale"
          : "Prediction Markets signal is stale",
        affected: "Prediction Markets",
        detectedAt: latestKalshi,
        likelyCause: kalshiInputStale
          ? "The latest dashboard snapshot loaded, but one or more upstream market inputs were marked stale."
          : "The Kalshi dashboard snapshot is older than the expected watch window.",
        nextInspection: kalshiInputStale
          ? "Open Kalshi and inspect the data freshness cards before trusting market-watch status."
          : "Open Kalshi and Cron Jobs, then verify the status bridge and watch jobs.",
        plainSummary: kalshiInputStale
          ? "Prediction Markets has a fresh dashboard snapshot with stale upstream inputs."
          : "Prediction Markets data is older than expected.",
        whyItMatters: "Market-watch and paper-trading status may be based on stale information.",
        recommendedAction: "Review Prediction Markets and the Kalshi status jobs.",
        target: { kind: "agentsPanel", panel: "room", label: "Review Prediction Markets" },
        confidence: attentionConfidenceFromTimestamp(latestKalshi, params.now),
        priority: 40,
      }),
    );
  }
  if (hasKalshiLiveReadinessOperationalFailure(params.kalshiDashboard)) {
    issues.push(
      dashboardIssue({
        id: "kalshi-live-readiness",
        severity: "high",
        title: "Prediction Markets readiness needs review",
        affected: "Prediction Markets",
        detectedAt: latestKalshi,
        likelyCause:
          params.kalshiDashboard?.live_readiness?.critical_failures?.[0] ??
          params.kalshiDashboard?.live_readiness?.blockers?.[0] ??
          "One or more live-readiness checks failed.",
        nextInspection: "Open Kalshi readiness and the Risk Controller worker details.",
        plainSummary: "Prediction Markets readiness checks need review.",
        whyItMatters: "Risk or evidence gates may be blocking safe market automation.",
        recommendedAction: "Open Kalshi readiness and inspect the Risk Controller.",
        target: { kind: "appTab", tab: "kalshi", label: "Open Kalshi" },
        confidence: attentionConfidenceFromTimestamp(latestKalshi, params.now),
        priority: 20,
      }),
    );
  }
  return mergeOpsSummaryIssues(sortIssues(issues), params.opsSummary, params.cron);
}

export function deriveDashboardHealth(params: {
  roomAgents: RoomAgent[];
  runtimeStatus: AgentRoomRuntimeStatusState;
  cron?: AgentRoomProps["cron"];
  channels?: AgentRoomProps["channels"];
  kalshiDashboard?: KalshiDashboardSnapshot | null;
  opsSummary?: AgentRoomProps["opsSummary"];
  connected: boolean;
  now?: number;
}): DashboardHealthSummary {
  const now = params.now ?? Date.now();
  const issues = createDashboardIssues({ ...params, opsSummary: params.opsSummary?.result, now });
  if (params.connected && !params.opsSummary?.result && !params.opsSummary?.error) {
    issues.push(
      dashboardIssue({
        id: "gateway-ops-summary-pending",
        severity: "medium",
        title: "Live Gateway status is still loading",
        affected: "Dashboard command center",
        detectedAt: now,
        likelyCause: params.opsSummary?.loading
          ? "OpenClaw is fetching the latest operations summary."
          : "The operations summary has not reached the dashboard yet.",
        nextInspection: "Refresh Live Agent Workspace if this does not clear.",
        plainSummary: "Checking live Gateway status",
        whyItMatters: "The dashboard should not show all clear until Gateway health is verified.",
        recommendedAction: "Wait for the live status check, then review any listed issue.",
        target: { kind: "appTab", tab: "overview", label: "Open Overview" },
        confidence: "Live",
        priority: 5,
      }),
    );
  }
  const sortedIssues = sortIssues(issues);
  const counts = countStates(params.roomAgents);
  const memoryVerdict = deriveMemoryVerdict(params.runtimeStatus);
  const critical = sortedIssues.some((issue) => issue.severity === "critical");
  const high = sortedIssues.some((issue) => issue.severity === "high");
  const needsUserAction = sortedIssues.some(issueNeedsUserAction);
  const telemetryUnavailable = Boolean(params.runtimeStatus.error && !params.runtimeStatus.result);
  const inferredState: DashboardHealthState = critical
    ? "Critical"
    : telemetryUnavailable || memoryVerdict.tone === "danger"
      ? "Degraded"
      : high || needsUserAction
        ? "Needs Review"
        : counts.active > 0 || counts.supervising > 0
          ? "Watching"
          : "Healthy";
  const gatewayState = params.opsSummary?.result
    ? dashboardStateFromGateway(params.opsSummary.result.state)
    : null;
  const hasKeptGatewayIssue = sortedIssues.some((issue) => issue.id.startsWith("gateway-"));
  const effectiveGatewayState =
    gatewayState &&
    (healthStateRank(gatewayState) >= healthStateRank("Watching") || hasKeptGatewayIssue)
      ? gatewayState
      : null;
  const state =
    effectiveGatewayState && healthStateRank(effectiveGatewayState) < healthStateRank(inferredState)
      ? effectiveGatewayState
      : inferredState;
  const tone = dashboardToneFromState(state);
  const attentionActions = attentionActionsFromIssues(sortedIssues);
  const attentionVerdict = attentionVerdictFromState(state, attentionActions);
  const changedRecently = params.roomAgents
    .filter((entry) => entry.updatedAt && now - entry.updatedAt <= RECENT_ACTIVITY_MS)
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 3)
    .map(
      (entry) => `${entry.label}: ${entry.statusLabel} ${formatRelativeTimestamp(entry.updatedAt)}`,
    );
  return {
    state,
    tone,
    attentionVerdict,
    attentionActions,
    issues: sortedIssues,
    topIssues: sortedIssues.slice(0, 3),
    changedRecently: changedRecently.length
      ? changedRecently
      : ["No recent agent changes detected."],
    nextAutomation: describeNextAutomation(params.cron),
    nextKalshiActivity: describeNextKalshiActivity(params.kalshiDashboard),
    memoryVerdict,
    gatewayVerifiedAt: params.opsSummary?.result?.ts ?? null,
    gatewaySummaryLoading: params.opsSummary?.loading ?? false,
    gatewaySummaryError: params.opsSummary?.error ?? null,
  };
}

function renderResourceMonitor(
  runtimeStatus: AgentRoomRuntimeStatusState,
  roomAgents: RoomAgent[],
) {
  const result = runtimeStatus.result;
  const telemetryUnavailable = Boolean(runtimeStatus.error && !result);
  const modelCoverageAgents = roomAgents.filter(expectsLoadedLocalModelCoverage);
  const loadedModelCoverageAgents = modelCoverageAgents.filter((entry) => entry.loadedModel);
  const unloadedModelCoverageAgents = modelCoverageAgents.length - loadedModelCoverageAgents.length;
  const loadedAgentDetail =
    modelCoverageAgents.length > 0
      ? `${loadedModelCoverageAgents.length} of ${modelCoverageAgents.length} model-active agents covered`
      : "No model-active agents";
  const largestModel = result?.localModels.models.toSorted((a, b) => b.sizeBytes - a.sizeBytes)[0];
  const modelRam = result?.localModels.totalLoadedBytes ?? 0;
  const ollamaProcessRam = result?.localModels.process?.rssBytes ?? 0;
  const ollamaProcessCount = result?.localModels.process?.processCount ?? 0;
  const hasOllamaProcess = Boolean(
    result?.localModels.process?.available && ollamaProcessCount > 0,
  );
  const macUsed = result?.system.usedBytes ?? 0;
  const macTotal = result?.system.totalBytes ?? 0;
  const macPercent = result ? formatPercent(result.system.usedRatio) : "n/a";
  const macosMemory = result?.system.macosMemory;
  const trueAvailable = macosMemory?.available
    ? macosMemory.availabilityEstimateBytes
    : (result?.system.freeBytes ?? 0);
  const trueAvailableRatio = macTotal > 0 ? trueAvailable / macTotal : null;
  const trueAvailablePercent =
    trueAvailableRatio === null ? "n/a" : formatPercent(trueAvailableRatio);
  const pressure = describeMemoryPressure(trueAvailable, macTotal);
  const immediateUnused = macosMemory?.available
    ? macosMemory.freeBytes + macosMemory.speculativeBytes
    : (result?.system.freeBytes ?? 0);
  const reclaimableCache = macosMemory?.available ? macosMemory.reclaimableBytes : null;
  const processMemory = result?.system.processes;
  const processRss = processMemory?.available ? processMemory.totalRssBytes : 0;
  const modelRamDetail = result
    ? result.localModels.count > 0
      ? `${result.localModels.count} loaded model${result.localModels.count === 1 ? "" : "s"} - ${loadedAgentDetail}`
      : hasOllamaProcess
        ? `Ollama idle - process ${formatBytes(ollamaProcessRam)}`
        : "No loaded local models"
    : "Loaded Ollama models";
  const largestModelDetail = largestModel
    ? formatBytes(largestModel.sizeBytes)
    : hasOllamaProcess
      ? `${ollamaProcessCount} Ollama process${ollamaProcessCount === 1 ? "" : "es"} resident`
      : "No active local model";
  const memoryVerdict = deriveMemoryVerdict(runtimeStatus);
  return html`
    <div class="agent-room-resource" aria-label="Mac and agent model memory">
      <div class="agent-room-resource__verdict agent-room-resource__verdict--${memoryVerdict.tone}">
        ${memoryVerdict.text}
      </div>
      <div
        class="agent-room-resource__item agent-room-resource__item--wide agent-room-resource__item--available agent-room-resource__item--${pressure.className}"
      >
        <span>RAM possible / available</span>
        <strong
          >${result
            ? `${formatBytes(trueAvailable)} (${trueAvailablePercent})`
            : "Checking..."}</strong
        >
        <em>
          ${result
            ? macosMemory?.available
              ? `${pressure.label} - ${formatBytes(immediateUnused)} unused now, ${formatBytes(reclaimableCache)} reclaimable cache`
              : `${pressure.label} - macOS reclaimable cache telemetry unavailable`
            : "Live telemetry"}
        </em>
      </div>
      <div class="agent-room-resource__item">
        <span>macOS reported used</span>
        <strong
          >${result ? `${formatBytes(macUsed)} / ${formatBytes(macTotal)}` : "Checking..."}</strong
        >
        <em>
          ${result
            ? processMemory?.available
              ? `${macPercent} used - includes cache, graphics, kernel, and apps`
              : `${macPercent} used`
            : "Live telemetry"}
        </em>
      </div>
      <div class="agent-room-resource__item">
        <span>Loaded model RAM</span>
        <strong>${result ? formatBytes(modelRam) : "Checking..."}</strong>
        <em>${modelRamDetail}</em>
      </div>
      <div class="agent-room-resource__item">
        <span>Process RAM seen</span>
        <strong>${result ? formatBytes(processRss) : "Checking..."}</strong>
        <em>
          ${processMemory?.available
            ? `OpenClaw ${formatBytes(processMemory.openclawRssBytes)}, Ollama ${formatBytes(processMemory.ollamaRssBytes)}, other ${formatBytes(processMemory.otherRssBytes)}`
            : "Process breakdown pending"}
        </em>
      </div>
      <div class="agent-room-resource__item">
        <span>Largest model</span>
        <strong>${largestModel ? largestModel.name : "None loaded"}</strong>
        <em>${largestModelDetail}</em>
      </div>
      <div class="agent-room-resource__item">
        <span>LLM active coverage</span>
        <strong
          >${result
            ? `${loadedModelCoverageAgents.length} / ${modelCoverageAgents.length}`
            : "Checking..."}</strong
        >
        <em>
          ${result
            ? unloadedModelCoverageAgents > 0
              ? `${unloadedModelCoverageAgents} model-active agent${unloadedModelCoverageAgents === 1 ? "" : "s"} missing local model`
              : "All model-active agents covered"
            : "Waiting for agent RAM map"}
        </em>
      </div>
      ${runtimeStatus.loading
        ? html`<div class="agent-room-resource__note">Refreshing memory telemetry...</div>`
        : nothing}
      ${runtimeStatus.error
        ? html`
            <div class="agent-room-resource__warning">
              ${telemetryUnavailable
                ? "Memory telemetry is temporarily unavailable. Refresh after the gateway restarts."
                : runtimeStatus.error}
            </div>
          `
        : nothing}
      ${processMemory?.available
        ? html`
            <details class="agent-room-resource__breakdown">
              <summary>
                RAM breakdown
                <span>
                  Process RSS ${formatBytes(processMemory.totalRssBytes)} - other
                  ${formatBytes(processMemory.otherRssBytes)}
                </span>
              </summary>
              <div class="agent-room-resource__breakdown-grid">
                <span><strong>OpenClaw</strong>${formatBytes(processMemory.openclawRssBytes)}</span>
                <span><strong>Ollama</strong>${formatBytes(processMemory.ollamaRssBytes)}</span>
                <span
                  ><strong>Other processes</strong>${formatBytes(processMemory.otherRssBytes)}</span
                >
              </div>
              <ol class="agent-room-resource__process-list">
                ${processMemory.top.map(
                  (entry) => html`
                    <li title=${entry.command}>
                      <span>${entry.name}</span>
                      <em>${formatProcessCategory(entry.category)}</em>
                      <strong>${formatBytes(entry.rssBytes)}</strong>
                    </li>
                  `,
                )}
              </ol>
              <p>
                macOS RAM also includes cache, compression, graphics, and kernel memory, so process
                RSS will not equal total Mac RAM exactly.
              </p>
            </details>
          `
        : processMemory?.error
          ? html`<div class="agent-room-resource__warning">
              RAM process breakdown unavailable: ${processMemory.error}
            </div>`
          : nothing}
      ${macosMemory?.available
        ? html`
            <details
              class="agent-room-resource__breakdown agent-room-resource__breakdown--availability"
              open
            >
              <summary>
                Why this much RAM is possible
                <span>
                  Available estimate ${formatBytes(trueAvailable)} - reported used
                  ${formatBytes(macUsed)}
                </span>
              </summary>
              <div class="agent-room-resource__breakdown-grid">
                <span><strong>Unused now</strong>${formatBytes(immediateUnused)}</span>
                <span><strong>Reclaimable cache</strong>${formatBytes(reclaimableCache)}</span>
                <span
                  ><strong>File-backed cache</strong>${formatBytes(
                    macosMemory.fileBackedBytes,
                  )}</span
                >
                <span
                  ><strong>App/private memory</strong>${formatBytes(
                    macosMemory.anonymousBytes,
                  )}</span
                >
                <span><strong>Wired system RAM</strong>${formatBytes(macosMemory.wiredBytes)}</span>
                <span
                  ><strong>Compressed RAM</strong>${formatBytes(macosMemory.compressedBytes)}</span
                >
              </div>
              <p>
                macOS intentionally uses spare RAM for file cache. That cache is reclaimable, so
                true available RAM can be much higher than the raw "used" number suggests.
              </p>
            </details>
          `
        : macosMemory?.error
          ? html`<div class="agent-room-resource__warning">
              macOS reclaimable memory unavailable: ${macosMemory.error}
            </div>`
          : nothing}
      <div class="agent-room-resource__hint">
        RAM possible / available is the best working estimate of RAM you can still use: immediately
        unused memory plus macOS reclaimable cache when available. ${MODEL_RAM_SHARED_HINT} On-watch
        and automation-bridge roles can be visibly awake without loading an LLM; LLM active coverage
        only counts roles that should currently have a local model resident.
      </div>
      ${result?.warnings?.map(
        (warning) => html`<div class="agent-room-resource__warning">${warning}</div>`,
      )}
    </div>
  `;
}

export function renderAgentRoomMemoryFixture(props: AgentRoomMemoryFixtureProps) {
  const roomAgents = buildRoomAgents({
    ...props,
    onSelectAgent: () => undefined,
    onRefresh: () => undefined,
    onOpenAgent: () => undefined,
  });
  return renderResourceMonitor(props.runtimeStatus, roomAgents);
}

function renderPrimaryActivity(entry: RoomAgent): string {
  if (entry.externalActivity) {
    return entry.externalActivity.task;
  }
  if (entry.state === "supervising") {
    if (entry.agent.id === "browser-session-credential-steward") {
      return "Guarding browser sessions";
    }
    if (entry.agent.id === "polymarket-market-watch-agent") {
      return "Watching market signals";
    }
    if (entry.agent.id === "polymarket-risk-controller") {
      return "Guarding paper/live risk gates";
    }
    if (entry.agent.id === "prediction-market-position-exposure-monitor") {
      return "Monitoring venue exposure";
    }
    return "Supervising all agents";
  }
  if (
    entry.state === "sleeping" ||
    entry.state === "idle" ||
    entry.state === "offline" ||
    entry.state === "unknown"
  ) {
    return "No active task";
  }
  const row = entry.latestSession;
  if (!row) {
    return "No active task";
  }
  return renderSessionTask(row);
}

function renderSessionTask(row: GatewaySessionRow): string {
  return (
    row.displayName ??
    row.derivedTitle ??
    row.label ??
    row.subject ??
    row.lastMessagePreview ??
    row.key
  );
}

function renderSessionPreview(row: GatewaySessionRow): string | null {
  const title = renderSessionTask(row);
  const preview = row.lastMessagePreview?.trim();
  if (!preview || preview === title) {
    return null;
  }
  return preview;
}

function formatSessionStatus(row: GatewaySessionRow): string {
  switch (row.status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "timeout":
      return "Timed out";
    case "killed":
      return "Stopped";
    default:
      return row.status ?? "Unknown";
  }
}

function formatDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < 1_000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function renderSessionActionMeta(session: GatewaySessionRow) {
  const parts = [
    session.model ? `Model ${session.model}` : null,
    typeof session.totalTokens === "number"
      ? `${session.totalTokens.toLocaleString()} tokens`
      : null,
    formatDuration(session.runtimeMs),
    session.thinkingLevel ? `Thinking ${session.thinkingLevel}` : null,
    session.childSessions?.length ? `${session.childSessions.length} child sessions` : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) {
    return nothing;
  }
  return html`<span class="agent-room-history__meta">${parts.join(" - ")}</span>`;
}

function renderVenueTags(metadata: AgentMasterPlanMetadata) {
  if (!metadata.venueTags?.length) {
    return nothing;
  }
  return html`
    <span class="agent-room-tags" aria-label="Supported venues">
      ${metadata.venueTags.map((tag) => html`<span>${tag}</span>`)}
    </span>
  `;
}

function renderWorker(entry: RoomAgent, index: number, onSelectAgent: (agentId: string) => void) {
  const isResting =
    entry.state === "sleeping" ||
    entry.state === "idle" ||
    entry.state === "offline" ||
    entry.state === "unknown";
  const displayedRam = describeDisplayedModelRam(entry);
  const title = `${entry.personName ? `${entry.personName} - ${entry.titleLabel}` : entry.titleLabel}: ${entry.statusLabel} (${entry.cue})`;
  return html`
    <button
      type="button"
      class="agent-room-worker agent-room-worker--${entry.state} ${entry.active
        ? "agent-room-worker--active"
        : ""} ${entry.director ? "agent-room-worker--director" : ""} ${entry.onWatch
        ? "agent-room-worker--always-on"
        : ""}"
      data-agent-id=${entry.agent.id}
      style="--room-worker-index: ${index};"
      title=${title}
      aria-label=${title}
      @click=${() => onSelectAgent(entry.agent.id)}
    >
      <span class="agent-room-worker__fixture" aria-hidden="true">
        ${isResting
          ? html`<span class="agent-room-bed"></span>`
          : html`<span class="agent-room-desk"></span>`}
      </span>
      <span class="agent-room-worker__sprite" aria-hidden="true">
        <span class="agent-room-worker__head"></span>
        <span class="agent-room-worker__body"></span>
      </span>
      <span class="agent-room-worker__bubble" aria-hidden="true"></span>
      <span class="agent-room-worker__signal" aria-hidden="true"></span>
      ${entry.onWatch
        ? html`<span class="agent-room-worker__role">${resolveOnWatchRole(entry.metadata)}</span>`
        : nothing}
      <span class="agent-room-worker__label">${entry.label}</span>
      ${entry.personName
        ? html`<span class="agent-room-worker__title">${entry.titleLabel}</span>`
        : nothing}
      <span class="agent-room-worker__status">${entry.statusLabel}</span>
      <span class="agent-room-worker__confidence">
        ${entry.signalConfidence} -
        ${entry.updatedAt ? formatRelativeTimestamp(entry.updatedAt) : "not verified"}
      </span>
      <span class="agent-room-worker__task"
        ><strong>Now:</strong> ${renderPrimaryActivity(entry)}</span
      >
      ${entry.thinkingPolicy
        ? html`
            <span class="agent-room-worker__task agent-room-worker__task--thinking">
              <strong>${entry.thinkingPolicy.label}:</strong> ${entry.thinkingPolicy.current}
            </span>
          `
        : nothing}
      ${isAwakeRoomState(entry.state)
        ? html`<span class="agent-room-worker__ram" title=${displayedRam.title}>
            ${displayedRam.badge}
          </span>`
        : nothing}
    </button>
  `;
}

function renderDetail(
  entry: RoomAgent | null,
  onAssignAgentRoom?: (agentId: string, roomId: string) => void,
) {
  if (!entry) {
    return html`
      <aside class="agent-room-detail">
        <div class="agent-room-detail__title">No agent selected</div>
        <div class="agent-room-detail__sub">Select a worker in the room to inspect its state.</div>
      </aside>
    `;
  }
  const row = entry.latestSession;
  const configuredModel = entry.model ?? "default";
  const lastRunModel = entry.lastRunModel;
  const primaryModelOk = !entry.director || isControlDirectorPrimaryModel(configuredModel);
  const displayedRam = describeDisplayedModelRam(entry);
  const displayedRamWhenLive = describeDisplayedModelRamWhenLive(entry);
  const compactRecentSessions = entry.recentSessions.slice(0, RECENT_ACTION_COMPACT_LIMIT);
  return html`
    <aside class="agent-room-detail">
      <div class="agent-room-detail__main">
        <div class="agent-room-detail__eyebrow">Selected worker</div>
        <div class="agent-room-detail__title">${entry.label}</div>
        ${entry.personName
          ? html`<div class="agent-room-detail__role-title">${entry.titleLabel}</div>`
          : nothing}
        <div class="agent-room-detail__sub">
          ${entry.statusLabel} - ${entry.cue} ${renderVenueTags(entry.metadata)}
        </div>
        <label class="agent-room-detail__room-picker">
          <span>Workspace room</span>
          <select
            aria-label=${`Change ${entry.label} workspace room`}
            @change=${(event: Event) => {
              const roomId = (event.currentTarget as HTMLSelectElement).value;
              if (roomId && roomId !== entry.projectRoom.id) {
                onAssignAgentRoom?.(entry.agent.id, roomId);
              }
            }}
          >
            ${ASSIGNABLE_PROJECT_ROOM_IDS.map(
              (roomId) => html`
                <option value=${roomId} ?selected=${entry.projectRoom.id === roomId}>
                  ${PROJECT_ROOMS[roomId]?.label ?? roomId}
                </option>
              `,
            )}
          </select>
          <small>Saved to canonical agent config; refreshes this workspace after save.</small>
        </label>
        <div class="agent-room-detail__task">
          <span>Now</span>
          ${renderPrimaryActivity(entry)}
        </div>
        <div class="agent-room-detail__task">
          <span>Expected behavior</span>
          ${entry.metadata.activationLabel}. ${entry.metadata.summonCriteria}
        </div>
        ${entry.externalActivity
          ? html`
              <div class="agent-room-detail__task agent-room-detail__task--external">
                <span>${entry.externalActivity.source}</span>
                ${entry.externalActivity.detail}
              </div>
            `
          : nothing}
        ${entry.thinkingPolicy
          ? html`
              <div class="agent-room-detail__task agent-room-detail__task--thinking">
                <span>${entry.thinkingPolicy.label}</span>
                ${entry.thinkingPolicy.current}. ${entry.thinkingPolicy.detail}
              </div>
            `
          : nothing}
        <dl class="agent-room-kv">
          <div>
            <dt>Role</dt>
            <dd>${entry.metadata.role}</dd>
          </div>
          <div>
            <dt>Purpose</dt>
            <dd>${entry.metadata.purpose}</dd>
          </div>
          <div>
            <dt>Activation</dt>
            <dd>${entry.metadata.activationLabel}</dd>
          </div>
          <div>
            <dt>Summon when</dt>
            <dd>${entry.metadata.summonCriteria}</dd>
          </div>
          <div>
            <dt>Owns</dt>
            <dd>${entry.metadata.owns.join(", ")}</dd>
          </div>
          ${entry.metadata.doesNotOwn?.length
            ? html`
                <div>
                  <dt>Does not own</dt>
                  <dd>${entry.metadata.doesNotOwn.join(", ")}</dd>
                </div>
              `
            : nothing}
          ${entry.director
            ? html`
                <div>
                  <dt>Primary model check</dt>
                  <dd>
                    ${primaryModelOk ? "Qwen3.6 primary configured" : "Expected Qwen3.6 primary"}
                  </dd>
                </div>
                <div>
                  <dt>Rollback model</dt>
                  <dd>${entry.modelFallbacks[0] ?? "Not configured"}</dd>
                </div>
                <div>
                  <dt>Thinking policy</dt>
                  <dd>
                    ${entry.thinkingPolicy?.label ?? "Default off"} -
                    ${entry.thinkingPolicy?.current ?? "Default: off"}
                  </dd>
                </div>
              `
            : nothing}
          <div>
            <dt>Project room</dt>
            <dd>${entry.projectRoom.label}</dd>
          </div>
          <div>
            <dt>Agent ID</dt>
            <dd>${entry.agent.id}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>${row?.key ?? "No recent session"}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              ${entry.updatedAt ? formatRelativeTimestamp(entry.updatedAt) : "No activity yet"}
            </dd>
          </div>
          ${entry.externalActivity
            ? html`
                <div>
                  <dt>Automation bridge</dt>
                  <dd>${entry.externalActivity.statusLabel}: ${entry.externalActivity.detail}</dd>
                </div>
              `
            : nothing}
          <div>
            <dt>${entry.director ? "Primary model" : "Model"}</dt>
            <dd>${configuredModel}</dd>
          </div>
          ${lastRunModel
            ? html`
                <div>
                  <dt>Last run model</dt>
                  <dd>${lastRunModel}</dd>
                </div>
              `
            : nothing}
          <div>
            <dt>Model RAM when live</dt>
            <dd>${displayedRamWhenLive}</dd>
          </div>
          <div>
            <dt>Live model RAM</dt>
            <dd>${displayedRam.text}</dd>
          </div>
          <div class="agent-room-kv__actions">
            <dt>
              Recent Actions
              <span class="agent-room-history__count">${entry.recentSessions.length}</span>
            </dt>
            <dd>
              ${entry.recentSessions.length
                ? html`
                    <ol class="agent-room-history__list">
                      ${compactRecentSessions.map((session) => {
                        const preview = renderSessionPreview(session);
                        const timestamp =
                          session.updatedAt ?? session.endedAt ?? session.startedAt ?? null;
                        return html`
                          <li>
                            <div class="agent-room-history__row-head">
                              <span class="agent-room-history__status"
                                >${formatSessionStatus(session)}</span
                              >
                              <span class="agent-room-history__time"
                                >${timestamp
                                  ? formatRelativeTimestamp(timestamp)
                                  : "No timestamp"}</span
                              >
                            </div>
                            <span class="agent-room-history__task"
                              >${renderSessionTask(session)}</span
                            >
                            ${renderSessionActionMeta(session)}
                            ${preview
                              ? html`<span class="agent-room-history__preview">${preview}</span>`
                              : nothing}
                            <details class="agent-room-history__details">
                              <summary>Inspect</summary>
                              <span class="agent-room-history__detail-grid">
                                <span><strong>Session</strong>${session.key}</span>
                                <span><strong>Kind</strong>${session.kind}</span>
                                <span
                                  ><strong>Started</strong>${session.startedAt
                                    ? formatRelativeTimestamp(session.startedAt)
                                    : "Unknown"}</span
                                >
                                <span
                                  ><strong>Ended</strong>${session.endedAt
                                    ? formatRelativeTimestamp(session.endedAt)
                                    : session.status === "running"
                                      ? "Still running"
                                      : "Unknown"}</span
                                >
                                <span
                                  ><strong>Input</strong>${typeof session.inputTokens === "number"
                                    ? session.inputTokens.toLocaleString()
                                    : "n/a"}</span
                                >
                                <span
                                  ><strong>Output</strong>${typeof session.outputTokens === "number"
                                    ? session.outputTokens.toLocaleString()
                                    : "n/a"}</span
                                >
                              </span>
                              <span class="agent-room-history__key">${session.key}</span>
                            </details>
                          </li>
                        `;
                      })}
                    </ol>
                    ${entry.recentSessions.length > compactRecentSessions.length
                      ? html`
                          <details class="agent-room-history__details">
                            <summary>
                              Show ${entry.recentSessions.length - compactRecentSessions.length}
                              older
                              action${entry.recentSessions.length - compactRecentSessions.length ===
                              1
                                ? ""
                                : "s"}
                            </summary>
                            <ol class="agent-room-history__list">
                              ${entry.recentSessions.slice(RECENT_ACTION_COMPACT_LIMIT).map(
                                (session) => html`
                                  <li>
                                    <span class="agent-room-history__task"
                                      >${renderSessionTask(session)}</span
                                    >
                                    ${renderSessionActionMeta(session)}
                                  </li>
                                `,
                              )}
                            </ol>
                          </details>
                        `
                      : nothing}
                  `
                : html`<div class="agent-room-history__empty">
                    No recorded sessions for this agent yet. Once it runs, its recent tasks will
                    appear here.
                  </div>`}
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  `;
}

function renderBeginnerHelp(onInspectAttention?: (target: AttentionTarget) => void) {
  const terms = [
    [
      "Gateway",
      "The local service that connects the dashboard, agents, automations, and channels.",
    ],
    ["cron", "A scheduled automation job that runs at a set time or interval."],
    [
      "model RAM",
      "Memory used by a loaded local LLM. Shared by agents using the same loaded model.",
    ],
    ["context", "The working memory an agent can use while answering or doing a task."],
    ["stale", "The dashboard has not seen a fresh signal recently enough to fully trust it."],
    [
      "inferred",
      "The dashboard is making a best-effort call from nearby signals, not a direct live event.",
    ],
    ["on-watch", "Visible and responsible, but not necessarily spending model RAM right now."],
    ["paper trading", "Simulated trading used for learning; it does not place live orders."],
    ["confidence", "How directly and recently the dashboard verified a status."],
  ] as const;
  const shortcuts: Array<{ label: string; target: AttentionTarget }> = [
    {
      label: "Discord problem",
      target: { kind: "appTab", tab: "channels", label: "Open Channels" },
    },
    { label: "Kalshi status", target: { kind: "appTab", tab: "kalshi", label: "Open Kalshi" } },
    {
      label: "RAM high",
      target: { kind: "agentsPanel", panel: "room", label: "Review RAM monitor" },
    },
    {
      label: "Who is working",
      target: { kind: "agentsPanel", panel: "room", label: "Show workers" },
    },
    { label: "Failed jobs", target: { kind: "appTab", tab: "cron", label: "Open Cron Jobs" } },
  ];
  return html`
    <details class="agent-room-help">
      <summary>Beginner help and quick find</summary>
      <div class="agent-room-help__body">
        <div>
          <strong>Quick find</strong>
          <div class="agent-room-help__shortcuts">
            ${shortcuts.map(
              (shortcut) => html`
                <button
                  type="button"
                  class="btn btn--xs btn--subtle"
                  @click=${() => onInspectAttention?.(shortcut.target)}
                >
                  ${shortcut.label}
                </button>
              `,
            )}
          </div>
        </div>
        <dl>
          ${terms.map(
            ([term, definition]) => html`
              <div tabindex="0" title=${definition}>
                <dt>${term}</dt>
                <dd>${definition}</dd>
              </div>
            `,
          )}
        </dl>
      </div>
    </details>
  `;
}

export function renderAgentRoom(props: AgentRoomProps) {
  const roomAgents = buildRoomAgents(props);
  const projectRooms = groupRoomAgents(roomAgents);
  const unmappedAgents = findUnmappedRoomAgents(roomAgents);
  const counts = countStates(roomAgents);
  const health = deriveDashboardHealth({
    roomAgents,
    runtimeStatus: props.runtimeStatus,
    cron: props.cron,
    channels: props.channels,
    kalshiDashboard: props.kalshiDashboard,
    opsSummary: props.opsSummary,
    connected: props.connected,
  });
  const selected =
    roomAgents.find((entry) => entry.agent.id === props.selectedAgentId) ?? roomAgents[0] ?? null;

  return html`
    <section class="agent-room-shell" aria-label="OpenClaw pixel room dashboard">
      <div class="agent-room-header">
        <div>
          <div class="card-title">Live Agent Workspace</div>
          <div class="card-sub">
            See who is actively working, who is resting, and who needs help in real time.
          </div>
        </div>
        <div class="agent-room-actions">
          <button type="button" class="btn btn--sm btn--ghost" @click=${props.onOpenAgent}>
            Open Details
          </button>
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${props.sessions.loading}
            @click=${props.onRefresh}
          >
            ${props.sessions.loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      ${props.sessions.error
        ? html`<div class="callout danger">${props.sessions.error}</div>`
        : nothing}
      ${renderAttentionCommandCenter(health, props.onInspectAttention)}
      ${renderDashboardSignals(props)}
      ${renderLearningVelocityPanel(props.kalshiDashboard, {
        loading: props.kalshiDashboardLoading,
        error: props.kalshiDashboardError,
      })}

      <div class="agent-room-summary" aria-label="Room status summary">
        <span class="agent-room-summary__supervising"
          ><strong>${counts.supervising}</strong> always on / watch</span
        >
        <span class="agent-room-summary__active"
          ><strong>${counts.active}</strong> working now</span
        >
        <span><strong>${counts.resting}</strong> resting</span>
        <span class=${counts.attention > 0 ? "agent-room-summary__attention" : ""}>
          <strong>${counts.attention}</strong> need help
        </span>
        <span><strong>${roomAgents.length}</strong> agents</span>
        <span class=${unmappedAgents.length > 0 ? "agent-room-summary__attention" : ""}>
          <strong>${unmappedAgents.length}</strong> unmapped
        </span>
      </div>

      ${renderUnmappedAgentsGuard(unmappedAgents, props.onAssignAgentRoom)}

      <div class="agent-room-layout">
        <div class="agent-room-stage" role="list" aria-label="Agent room">
          <div class="agent-room-wall" aria-hidden="true">
            <span>LIVE OPS</span>
            <span>${counts.supervising} ON WATCH</span>
            <span>${counts.active} WORKING</span>
            <span>${counts.attention} ALERTS</span>
          </div>
          <div class="agent-room-grid">
            ${roomAgents.length === 0
              ? html`<div class="agent-room-empty">No agents configured.</div>`
              : projectRooms.map(
                  (group, groupIndex) => html`
                    <section
                      class="agent-room-project agent-room-project--${group.room.tone}"
                      aria-label=${group.room.label}
                    >
                      <div class="agent-room-project__header">
                        <div class="agent-room-project__heading">
                          <div class="agent-room-project__marker">Room ${groupIndex + 1}</div>
                          <div class="agent-room-project__label">${group.room.label}</div>
                          <div class="agent-room-project__sub">${group.room.subtitle}</div>
                          ${group.room.id === "markets"
                            ? html`<div class="agent-room-project__tags">
                                  <span>Kalshi</span><span>Polymarket</span>
                                </div>
                                ${renderKalshiAutomationSummary(props.kalshiDashboard)}`
                            : nothing}
                        </div>
                        <div class="agent-room-project__count">
                          ${group.agents.length} ${group.agents.length === 1 ? "agent" : "agents"}
                        </div>
                      </div>
                      <div class="agent-room-project__workers">
                        ${group.agents.map(
                          (entry, index) => html`
                            <div role="listitem">
                              ${renderWorker(entry, groupIndex * 20 + index, props.onSelectAgent)}
                            </div>
                          `,
                        )}
                      </div>
                    </section>
                  `,
                )}
          </div>
        </div>
        <div class="agent-room-side">
          ${renderIssueQueue(health, props.onInspectAttention)}
          ${renderDetail(selected, props.onAssignAgentRoom)}
        </div>
      </div>

      <details class="agent-room-investigate">
        <summary>Investigate Mode</summary>
        <div>
          Expanded telemetry is available in the RAM breakdown, selected-worker Recent Actions, Cron
          Jobs, and Agent Workflow Maps. Skim Mode remains the default view above.
        </div>
      </details>

      ${renderBeginnerHelp(props.onInspectAttention)}

      <div class="agent-room-legend" aria-label="Room legend">
        ${[
          "supervising",
          "working",
          "thinking",
          "running-tool",
          "waiting",
          "completed",
          "blocked",
          "error",
          "sleeping",
        ].map((state) => {
          const description = describeRoomState(state as RoomState);
          return html`
            <span class="agent-room-legend__item agent-room-legend__item--${state}">
              <span aria-hidden="true"></span>${description.label}
            </span>
          `;
        })}
      </div>
    </section>
  `;
}
