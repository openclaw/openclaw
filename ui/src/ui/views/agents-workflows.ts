import { html, nothing } from "lit";
import type { KalshiDashboardSnapshot } from "../controllers/kalshi-dashboard.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { parseAgentSessionKey } from "../session-key.ts";
import type { CronJob, CronStatus, GatewayAgentRow, GatewaySessionRow } from "../types.ts";
import {
  AGENT_MASTER_PLAN,
  type AgentRoomRuntimeStatusState,
  type AgentRoomSessionsState,
} from "./agents-room.ts";
import { normalizeAgentLabel } from "./agents-utils.ts";
import type { AgentWorkflowMapsState, AgentWorkflowOrderState } from "./agents.types.ts";

type CodexPolicy = "never" | "explicit-only" | "optional" | "handoff";

export type WorkflowStep = {
  id: string;
  title: string;
  summary: string;
  trigger: string;
  agents: string[];
  programs: string[];
  codex: CodexPolicy;
  approval: string;
  outputs: string[];
  handoff: string;
};

export type WorkflowMap = {
  id: string;
  label: string;
  subtitle: string;
  goal: string;
  cadence: string;
  steps: WorkflowStep[];
};

export type AgentWorkflowsProps = {
  agents: GatewayAgentRow[];
  workflowMaps: AgentWorkflowMapsState;
  sessions?: AgentRoomSessionsState;
  runtimeStatus?: AgentRoomRuntimeStatusState;
  cron?: {
    status: CronStatus | null;
    jobs: CronJob[];
    loading: boolean;
    error: string | null;
  };
  kalshiDashboard?: KalshiDashboardSnapshot | null;
  onSelectRoom: (roomId: string) => void;
  onSelectStep: (stepId: string) => void;
  onOrderChange: (roomId: string, order: string[]) => void;
  onResetRoom: (roomId: string) => void;
};

type WorkflowStatusTone = "active" | "watch" | "resting" | "blocked" | "stale" | "review" | "none";

type WorkflowStatus = {
  label: string;
  tone: WorkflowStatusTone;
  detail: string;
  latestAt: number | null;
  nextExpectedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  nextInspection: string;
  latestSession: GatewaySessionRow | null;
  cronJobs: CronJob[];
};

const WORKFLOW_STALE_MS = 24 * 60 * 60_000;
const WORKFLOW_ACTIVE_MS = 15 * 60_000;

export const WORKFLOW_MAPS: WorkflowMap[] = [
  {
    id: "core",
    label: "Shared Command",
    subtitle: "Directors, memory, telemetry, credentials, and Codex routing.",
    goal: "Keep OpenClaw coordinated, instruction-faithful, and safe while preserving clear escalation paths.",
    cadence: "Always-on supervision plus scheduled/on-demand reviews.",
    steps: [
      {
        id: "core-intake",
        title: "Operator intake",
        summary:
          "Todd Stanski receives the request, checks intent, and decides whether to answer, route, or ask for missing context.",
        trigger: "Any OpenClaw chat, Discord prompt, dashboard action, or direct operator request.",
        agents: ["main"],
        programs: ["OpenClaw Chat", "Discord", "Control UI"],
        codex: "never",
        approval: "Ask before high-impact, external, financial, destructive, or ambiguous actions.",
        outputs: ["clear task framing", "selected agent or workflow", "operator-facing status"],
        handoff:
          "Route to the right specialist or continue directly in the Control Director session.",
      },
      {
        id: "core-route",
        title: "Route and coordinate",
        summary:
          "The Control Director summons specialists, keeps ownership clear, and watches for unfinished promised actions.",
        trigger:
          "A request needs specialist knowledge, background execution, or multi-agent sequencing.",
        agents: ["main", "program-manager", "judge", "telemetry-evaluation-analyst"],
        programs: ["Agent sessions", "Session history", "Live Agent Workspace"],
        codex: "never",
        approval:
          "Escalate to the operator when a specialist lacks inputs or asks to cross a safety boundary.",
        outputs: ["assigned owner", "status checkpoint", "blocked/complete classification"],
        handoff:
          "Return final answer through Todd Stanski unless another channel is explicitly requested.",
      },
      {
        id: "core-memory",
        title: "Curate durable knowledge",
        summary:
          "Memory and telemetry roles turn useful outcomes into low-noise knowledge and reliability signals.",
        trigger:
          "A completed task produces reusable knowledge, policy, metrics, or a reliability lesson.",
        agents: [
          "memory-knowledge-curator",
          "telemetry-evaluation-analyst",
          "automation-playbook-architect",
        ],
        programs: ["OpenClaw memory", "Control state", "Evaluation reports"],
        codex: "never",
        approval:
          "Do not promote inferred claims without provenance or operator-approved durable value.",
        outputs: ["curated memory candidate", "evaluation note", "repeatable playbook draft"],
        handoff:
          "Surface notable changes in the dashboard and summon the relevant owner if action is needed.",
      },
      {
        id: "core-codex",
        title: "Codex implementation gate",
        summary:
          "Codex is used only when explicitly summoned for OpenClaw code changes, tests, or repository implementation.",
        trigger:
          "Operator says to use Codex, asks Codex to implement, or explicitly delegates repo work.",
        agents: ["codex", "main", "qa-test-agent"],
        programs: ["Codex", "Git", "pnpm tests", "OpenClaw repo"],
        codex: "explicit-only",
        approval:
          "Never start silent background edits, commits, pushes, or destructive git operations without explicit approval.",
        outputs: ["scoped code change", "targeted validation", "implementation summary"],
        handoff:
          "Codex reports back to Todd Stanski and the operator with files changed and tests run.",
      },
    ],
  },
  {
    id: "markets",
    label: "Prediction Markets",
    subtitle: "Kalshi and Polymarket research, paper trading, risk, exposure, and learning.",
    goal: "Run a paper-first prediction-market loop that learns from evidence while keeping live execution gated.",
    cadence:
      "Watch roles stay visible; research, scoring, risk, and learning run scheduled or on demand.",
    steps: [
      {
        id: "markets-watch",
        title: "Watch venue signals",
        summary:
          "Market Watch tracks Kalshi and Polymarket signals, watchlists, scheduler health, and notable changes.",
        trigger:
          "Scheduled market checks, user asks for a market update, or a watch signal changes.",
        agents: ["polymarket-market-watch-agent"],
        programs: ["Kalshi API scripts", "Paper-trading scheduler", "Kalshi dashboard"],
        codex: "never",
        approval: "Read-only. Do not place, modify, cancel, or accept trades.",
        outputs: ["market status", "watchlist update", "freshness or stale-data warning"],
        handoff: "Send possible opportunities to research and risk before any paper/live action.",
      },
      {
        id: "markets-research",
        title: "Research and mispricing scan",
        summary:
          "Research and mispricing roles verify rules, prices, fees, liquidity, settlement logic, and missing evidence.",
        trigger:
          "A market looks interesting, a paper trade needs a thesis, or the operator requests analysis.",
        agents: ["polymarket-research-agent", "polymarket-mispricing-arbitrage-analyst"],
        programs: ["Kalshi research scripts", "Market pages", "Evidence logs"],
        codex: "never",
        approval:
          "No edge claim without complete venue, market, bid/ask/depth, fee, and settlement evidence.",
        outputs: ["research packet", "missing-evidence checklist", "paper hypothesis"],
        handoff: "Send paper candidates to risk and exposure for sizing and blockers.",
      },
      {
        id: "markets-risk",
        title: "Risk and exposure gate",
        summary:
          "Risk Controller and Exposure Monitor enforce bankroll, paper/live boundary, unresolved exposure, and approval gates.",
        trigger:
          "Before any paper action, after exposure changes, or when live readiness is questioned.",
        agents: ["polymarket-risk-controller", "prediction-market-position-exposure-monitor"],
        programs: ["Risk controller", "Paper log", "Live-readiness gate"],
        codex: "never",
        approval:
          "Live execution stays disabled unless explicit operator approval and all gates pass.",
        outputs: ["risk decision", "exposure summary", "blocker list"],
        handoff:
          "Approved paper-only actions may move to execution; blockers go back to research or the operator.",
      },
      {
        id: "markets-execute",
        title: "Paper execution only",
        summary:
          "Execution remains disabled by default and is used only for approved, risk-cleared, paper-safe actions.",
        trigger: "A paper action has full thesis, risk clearance, and operator-approved scope.",
        agents: ["prediction-market-execution-agent", "main"],
        programs: ["Paper-trading scripts", "Approval log"],
        codex: "never",
        approval:
          "Never autonomous live trading. Explicit approval is mandatory for any execution-like step.",
        outputs: ["paper decision log", "no-live-trading proof", "operator summary"],
        handoff: "Send outcomes to resolution and strategy improvement.",
      },
      {
        id: "markets-learn",
        title: "Score and improve",
        summary:
          "Resolution and strategy roles score outcomes, detect weak segments, and propose paper-only improvements.",
        trigger:
          "After settlement, drawdowns, enough samples, or scheduled self-improvement loops.",
        agents: [
          "prediction-market-resolution-settlement-auditor",
          "polymarket-strategy-improvement-analyst",
        ],
        programs: ["Outcome log", "Strategy scorecard", "Paper strategy learner"],
        codex: "optional",
        approval:
          "Codex may be summoned only to fix scripts/tests, not to change strategy autonomously.",
        outputs: ["scorecard", "postmortem", "pause/continue recommendation"],
        handoff: "Feed accepted lessons back to watchlists, risk rules, and operator dashboards.",
      },
    ],
  },
  {
    id: "youtube",
    label: "YouTube Content Engine",
    subtitle:
      "Trend research, video briefs, scripts, packaging, publishing readiness, and analytics.",
    goal: "Move from trend signal to publish-ready package without losing policy, brand, or evidence discipline.",
    cadence:
      "Daily trend checks, weekly planning, launch-package refreshes, and post-publish reviews.",
    steps: [
      {
        id: "youtube-trends",
        title: "Trend and source intake",
        summary:
          "Trend scouts gather signals and source material, then score them for fit, originality, and expert value.",
        trigger: "Daily trend loop, source inbox update, or operator asks for ideas.",
        agents: ["topic-trend-researcher", "market-research-analyst"],
        programs: ["YouTube V1 automation", "Source inbox", "Trend reports"],
        codex: "never",
        approval: "Reject weak, unsafe, or low-evidence ideas before they reach production.",
        outputs: ["trend report", "ready idea shortlist", "reject reasons"],
        handoff: "Send winning ideas to brief and script roles.",
      },
      {
        id: "youtube-brief",
        title: "Brief and script",
        summary:
          "The script stack turns a selected idea into a structured brief, hook, outline, final script, and shorts plan.",
        trigger: "A selected idea meets scoring and policy gates.",
        agents: ["script-writer", "transcript-knowledge-distiller", "shorts-repurposer"],
        programs: ["Brief templates", "Script files", "Shorts package"],
        codex: "never",
        approval: "Human editorial judgment remains required before public publishing.",
        outputs: ["video brief", "final script", "shorts package"],
        handoff: "Send production-ready text to production, packaging, and human handoff.",
      },
      {
        id: "youtube-package",
        title: "Package for launch",
        summary:
          "Packaging roles prepare launch assets, image prompts, voiceover packets, checklists, and handoff maps.",
        trigger: "Script reaches launch-package readiness or scheduled refresh runs.",
        agents: ["video-production-orchestrator", "asset-repurposer", "publisher-scheduler"],
        programs: ["Launch package", "Image prompt packet", "Voiceover packet"],
        codex: "optional",
        approval:
          "Codex may automate file generation or tests only when explicitly asked; no publishing.",
        outputs: ["launch package", "human-task handoff", "validation report"],
        handoff: "Human operator reviews assets and publishing checklist before upload.",
      },
      {
        id: "youtube-publish-learn",
        title: "Publish readiness and learning",
        summary:
          "Health, analytics, comments, offers, and performance roles close the loop after launch.",
        trigger: "Health check, scheduled analytics review, comments, or monetization/offers work.",
        agents: [
          "youtube-performance-analyst",
          "comment-response-drafter",
          "offer-extraction-agent",
          "newsletter-editor",
        ],
        programs: ["YouTube health report", "Analytics", "Comments", "Newsletter drafts"],
        codex: "never",
        approval: "Do not publish, reply publicly, or send offers without operator approval.",
        outputs: ["health report", "analytics readout", "response drafts", "offer notes"],
        handoff: "Feed lessons into the next weekly plan and content database.",
      },
    ],
  },
  {
    id: "build",
    label: "Product and Build Lab",
    subtitle: "Product specs, apps, funnels, lessons, QA, release, and support.",
    goal: "Turn ideas into validated product/build outputs with scoped implementation and explicit quality gates.",
    cadence:
      "On demand for builds; QA and release gates whenever code or product artifacts change.",
    steps: [
      {
        id: "build-discover",
        title: "Discover and frame",
        summary:
          "Research and strategy roles define the user, problem, success criteria, and constraints before building.",
        trigger: "A product, lesson, funnel, curriculum, or app idea needs structure.",
        agents: ["problem-miner", "product-strategist", "curriculum-architect", "funnel-builder"],
        programs: ["Project docs", "Research notes", "Spec templates"],
        codex: "never",
        approval: "Ask for operator direction when scope, audience, or risk is unclear.",
        outputs: ["problem statement", "requirements", "acceptance criteria"],
        handoff: "Send scoped work to engineering/spec or builder roles.",
      },
      {
        id: "build-spec",
        title: "Specify the build",
        summary:
          "Engineering and content architects convert the plan into actionable implementation or production specs.",
        trigger: "Discovery output is strong enough to execute.",
        agents: ["engineering-spec-writer", "lesson-builder", "book-drafting-agent"],
        programs: ["Spec docs", "Task breakdowns", "Reference resources"],
        codex: "optional",
        approval: "Codex is possible only after explicit implementation approval.",
        outputs: ["technical spec", "content outline", "test plan"],
        handoff:
          "Send code tasks to Codex or Builder; send content tasks to the right production agent.",
      },
      {
        id: "build-implement",
        title: "Implement or assemble",
        summary:
          "Builder roles and Codex create the artifact, keeping edits scoped and tests close to the touched surface.",
        trigger: "Operator approves implementation or explicitly summons Codex.",
        agents: ["builder-agent", "codex", "asset-repurposer"],
        programs: ["Codex", "Repo files", "pnpm", "Git"],
        codex: "explicit-only",
        approval: "No commits, pushes, or destructive changes unless separately approved.",
        outputs: ["implemented artifact", "changed files", "local proof"],
        handoff: "Send to QA, release, or support depending on the artifact.",
      },
      {
        id: "build-verify-release",
        title: "Verify, release, support",
        summary:
          "QA, release, and support agents verify behavior, document risks, and prepare handoff or support notes.",
        trigger: "Implementation is complete or a bug/support issue appears.",
        agents: ["qa-test-agent", "release-ops-agent", "support-incident-response-agent"],
        programs: ["Vitest", "OpenClaw checks", "Docs", "Support notes"],
        codex: "handoff",
        approval: "Release, publish, or external support actions require operator approval.",
        outputs: ["test evidence", "release checklist", "support response"],
        handoff: "Report status to Todd Stanski and update project resources when useful.",
      },
    ],
  },
  {
    id: "ops",
    label: "Executive and Personal Ops",
    subtitle: "Scheduling, email, calls, research briefs, hiring, journaling, and direction.",
    goal: "Keep personal and executive operations organized without crossing communication or privacy boundaries.",
    cadence:
      "On demand, scheduled check-ins, and event-driven work when messages or calendar items arrive.",
    steps: [
      {
        id: "ops-intake",
        title: "Capture request and context",
        summary:
          "Ops agents gather the calendar, message, call, hiring, or journal context needed to act accurately.",
        trigger:
          "Operator asks for scheduling, email, call prep, hiring, research, or personal ops help.",
        agents: ["executive-assistant-agent", "research-brief-agent", "journal-check-in-coach"],
        programs: ["Projects", "Docs", "Calendar/email connectors when configured"],
        codex: "never",
        approval: "Ask before accessing, sending, or changing external personal data.",
        outputs: ["context summary", "missing inputs", "recommended next step"],
        handoff: "Send action-ready work to the matching ops specialist.",
      },
      {
        id: "ops-draft",
        title: "Draft and prepare",
        summary:
          "Specialists prepare emails, call briefs, schedules, hiring screens, or decision briefs for review.",
        trigger: "Enough context exists to prepare a draft or plan.",
        agents: [
          "email-triage-drafting-agent",
          "call-prep-follow-up-agent",
          "scheduling-booking-coordinator",
          "hiring-screen-agent",
        ],
        programs: ["Email drafts", "Calendar drafts", "Call notes", "Hiring rubrics"],
        codex: "never",
        approval: "No sending, booking, or candidate-facing messages without approval.",
        outputs: ["draft response", "booking plan", "call brief", "hiring recommendation"],
        handoff: "Todd Stanski summarizes what is ready for approval.",
      },
      {
        id: "ops-review",
        title: "Review patterns and decisions",
        summary:
          "Pattern and direction roles identify repeated needs, personal operating signals, and decision opportunities.",
        trigger:
          "A repeated ops problem, journal pattern, or strategic direction question appears.",
        agents: ["pattern-detection-agent", "direction-niche-advisor", "judge"],
        programs: ["Journal notes", "Pattern reports", "Decision rubrics"],
        codex: "never",
        approval:
          "Do not turn sensitive inferred patterns into durable facts without operator confirmation.",
        outputs: ["pattern insight", "decision recommendation", "follow-up action"],
        handoff: "Feed approved patterns to memory or program management.",
      },
    ],
  },
  {
    id: "music",
    label: "Music Studio",
    subtitle: "Song ideas, arrangements, production notes, and release planning.",
    goal: "Move music ideas from raw concept to arranged, reviewed, and release-ready plans.",
    cadence: "On demand for creative sessions; scheduled only when a music project is active.",
    steps: [
      {
        id: "music-idea",
        title: "Capture musical idea",
        summary:
          "Music ideation gathers the concept, references, mood, constraints, and intended release context.",
        trigger: "Operator shares a music idea, lyric, arrangement prompt, or release goal.",
        agents: ["music-ideation-agent"],
        programs: ["Music notes", "Project resources", "Reference files"],
        codex: "never",
        approval: "Keep references and rights questions explicit before production use.",
        outputs: ["song concept", "reference map", "creative constraints"],
        handoff: "Send promising ideas to arrangement and release planning.",
      },
      {
        id: "music-arrange",
        title: "Arrange and plan production",
        summary:
          "Arrangement planning turns the idea into structure, instrumentation, production notes, and a release path.",
        trigger: "A music concept has enough detail to shape into a work plan.",
        agents: ["arrangement-release-planner", "asset-repurposer"],
        programs: ["Arrangement notes", "Release checklist", "Asset plan"],
        codex: "optional",
        approval:
          "Codex is only useful for tooling, file organization, or automation when explicitly requested.",
        outputs: ["arrangement plan", "production checklist", "release next actions"],
        handoff: "Return the plan to Todd Stanski for operator review and next creative decision.",
      },
    ],
  },
];

const DEFAULT_WORKFLOW_ROOM_ID = "core";

function orderedWorkflowSteps(map: WorkflowMap, orders: AgentWorkflowOrderState): WorkflowStep[] {
  const stepsById = new Map(map.steps.map((step) => [step.id, step]));
  const customOrder = orders[map.id] ?? [];
  const ordered = customOrder
    .map((id) => stepsById.get(id))
    .filter((step): step is WorkflowStep => Boolean(step));
  const seen = new Set(ordered.map((step) => step.id));
  return [...ordered, ...map.steps.filter((step) => !seen.has(step.id))];
}

export function resolveWorkflowMap(roomId: string | null): WorkflowMap {
  return WORKFLOW_MAPS.find((map) => map.id === roomId) ?? WORKFLOW_MAPS[0];
}

export function resolveOrderedWorkflowStepIds(
  roomId: string,
  orders: AgentWorkflowOrderState,
): string[] {
  return orderedWorkflowSteps(resolveWorkflowMap(roomId), orders).map((step) => step.id);
}

export function moveWorkflowStepOrder(
  roomId: string,
  orders: AgentWorkflowOrderState,
  stepId: string,
  direction: "back" | "forward",
): string[] {
  const ids = resolveOrderedWorkflowStepIds(roomId, orders);
  const index = ids.indexOf(stepId);
  if (index < 0) {
    return ids;
  }
  const nextIndex = direction === "back" ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= ids.length) {
    return ids;
  }
  const next = ids.slice();
  [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
  return next;
}

export function dropWorkflowStepBefore(
  roomId: string,
  orders: AgentWorkflowOrderState,
  draggedStepId: string,
  targetStepId: string,
): string[] {
  const ids = resolveOrderedWorkflowStepIds(roomId, orders);
  if (
    draggedStepId === targetStepId ||
    !ids.includes(draggedStepId) ||
    !ids.includes(targetStepId)
  ) {
    return ids;
  }
  const withoutDragged = ids.filter((id) => id !== draggedStepId);
  const targetIndex = withoutDragged.indexOf(targetStepId);
  return [
    ...withoutDragged.slice(0, targetIndex),
    draggedStepId,
    ...withoutDragged.slice(targetIndex),
  ];
}

function formatAgentId(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function resolveAgentName(agentId: string, agents: GatewayAgentRow[]): string {
  const configured = agents.find((agent) => agent.id === agentId);
  if (configured) {
    return normalizeAgentLabel(configured);
  }
  const metadata = AGENT_MASTER_PLAN[agentId];
  return metadata?.displayName ?? metadata?.role ?? formatAgentId(agentId);
}

function codexPolicyLabel(policy: CodexPolicy): string {
  switch (policy) {
    case "never":
      return "Codex not used";
    case "explicit-only":
      return "Codex only by explicit summon";
    case "optional":
      return "Codex possible with approval";
    case "handoff":
      return "Codex may receive verified fixes";
  }
  return "Codex possible with approval";
}

function codexPolicyTone(policy: CodexPolicy): string {
  return policy === "never" ? "quiet" : policy === "explicit-only" ? "gate" : "possible";
}

function sessionMatchesAgent(session: GatewaySessionRow, agentId: string): boolean {
  const parsed = parseAgentSessionKey(session.key);
  if (parsed?.agentId === agentId) {
    return true;
  }
  return agentId === "main" && session.key === "main";
}

function latestSessionForAgents(
  sessions: AgentRoomSessionsState | undefined,
  agentIds: string[],
): GatewaySessionRow | null {
  const rows = sessions?.result?.sessions ?? [];
  return (
    rows
      .filter((session) => agentIds.some((agentId) => sessionMatchesAgent(session, agentId)))
      .toSorted(
        (a, b) =>
          (b.updatedAt ?? b.endedAt ?? b.startedAt ?? 0) -
          (a.updatedAt ?? a.endedAt ?? a.startedAt ?? 0),
      )[0] ?? null
  );
}

function relatedCronJobs(cron: AgentWorkflowsProps["cron"], step: WorkflowStep): CronJob[] {
  const stepTokens = [step.id, step.title, ...step.agents].map((value) => value.toLowerCase());
  return (cron?.jobs ?? []).filter((job) => {
    if (job.agentId && step.agents.includes(job.agentId)) {
      return true;
    }
    const haystack = `${job.id ?? ""} ${job.name ?? ""} ${
      job.payload?.kind === "agentTurn" ? job.payload.message : ""
    }`.toLowerCase();
    return stepTokens.some((token) => token && haystack.includes(token));
  });
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
  return valid.length > 0 ? Math.max(...valid) : null;
}

function latestKalshiWorkflowAt(
  snapshot: KalshiDashboardSnapshot | null | undefined,
): number | null {
  const scheduler = snapshot?.accelerator?.scheduler;
  return newestTimestamp(
    parseUtcMillis(snapshot?.generated_at_utc),
    parseUtcMillis(scheduler?.latest_scheduled_completed_at_utc),
    parseUtcMillis(scheduler?.latest_weather_timestamp_utc),
    parseUtcMillis(snapshot?.self_improvement?.metrics?.latest_scored_decision_utc ?? null),
    parseUtcMillis(snapshot?.self_improvement?.metrics?.latest_scored_outcome_utc ?? null),
  );
}

function hasKalshiWorkflowFailure(snapshot: KalshiDashboardSnapshot | null | undefined): boolean {
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

function workflowStepStatus(
  map: WorkflowMap,
  step: WorkflowStep,
  props: AgentWorkflowsProps,
  now = Date.now(),
): WorkflowStatus {
  const latestSession = latestSessionForAgents(props.sessions, step.agents);
  const cronJobs = relatedCronJobs(props.cron, step);
  const latestSessionAt =
    latestSession?.updatedAt ?? latestSession?.endedAt ?? latestSession?.startedAt ?? null;
  const latestCronAt = newestTimestamp(
    ...cronJobs.map((job) => job.state?.runningAtMs ?? job.state?.lastRunAtMs ?? null),
  );
  const nextExpectedAt =
    cronJobs
      .map((job) => job.state?.nextRunAtMs ?? null)
      .filter((value): value is number => typeof value === "number")
      .toSorted((a, b) => a - b)[0] ?? null;
  const lastSuccessAt = newestTimestamp(
    ...cronJobs
      .filter((job) => job.state?.lastStatus === "ok" || job.state?.lastRunStatus === "ok")
      .map((job) => job.state?.lastRunAtMs ?? null),
    latestSession?.status === "done" ? latestSessionAt : null,
  );
  const lastFailureAt = newestTimestamp(
    ...cronJobs
      .filter((job) => job.state?.lastStatus === "error" || job.state?.lastRunStatus === "error")
      .map((job) => job.state?.lastRunAtMs ?? null),
    latestSession?.status === "failed" ||
      latestSession?.status === "timeout" ||
      latestSession?.status === "killed"
      ? latestSessionAt
      : null,
  );
  const latestKalshiAt =
    map.id === "markets" ? latestKalshiWorkflowAt(props.kalshiDashboard) : null;
  const latestAt = newestTimestamp(latestSessionAt, latestCronAt, latestKalshiAt);
  const cronError = cronJobs.find(
    (job) =>
      job.state?.lastStatus === "error" ||
      job.state?.lastRunStatus === "error" ||
      (job.state?.consecutiveErrors ?? 0) > 0,
  );
  const runningCron = cronJobs.find((job) => typeof job.state?.runningAtMs === "number");
  const sessionRunning = Boolean(
    latestSession?.status === "running" ||
    latestSession?.hasActiveRun ||
    latestSession?.hasActiveSubagentRun,
  );
  const sessionFailed = Boolean(
    latestSession?.status === "failed" || latestSession?.abortedLastRun,
  );
  const hasOnWatchAgent = step.agents.some((agentId) => {
    const activation = AGENT_MASTER_PLAN[agentId]?.activation;
    return activation === "always-on" || activation === "conditional-always-on";
  });
  const stale = latestAt !== null && now - latestAt > WORKFLOW_STALE_MS;
  const activeRecent = latestAt !== null && now - latestAt <= WORKFLOW_ACTIVE_MS;
  const nextInspection =
    map.id === "markets"
      ? "Kalshi dashboard, Cron Jobs, and Prediction Markets agents"
      : cronJobs.length > 0
        ? "Cron Jobs and recent session history"
        : "Agent details and recent session history";

  if (
    cronError ||
    sessionFailed ||
    (map.id === "markets" && hasKalshiWorkflowFailure(props.kalshiDashboard))
  ) {
    return {
      label: "Needs review",
      tone: "review",
      detail:
        cronError?.state?.lastError ??
        latestSession?.lastMessagePreview ??
        "A related workflow signal needs operator review.",
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  if (runningCron || sessionRunning) {
    return {
      label: "Active",
      tone: "active",
      detail: runningCron
        ? `${runningCron.name ?? runningCron.id} is running.`
        : (latestSession?.displayName ??
          latestSession?.derivedTitle ??
          "A related agent session is running."),
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  if (stale) {
    return {
      label: "Stale",
      tone: "stale",
      detail: `Last signal ${formatRelativeTimestamp(latestAt)}.`,
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  if (map.id === "markets" && activeRecent) {
    return {
      label: "Active",
      tone: "active",
      detail: "Recent Kalshi paper-learning status is available.",
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  if (hasOnWatchAgent) {
    return {
      label: "On watch",
      tone: "watch",
      detail: "At least one owner is configured as always-on or on-watch.",
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  if (latestAt !== null) {
    return {
      label: "Resting",
      tone: "resting",
      detail: `Last signal ${formatRelativeTimestamp(latestAt)}.`,
      latestAt,
      nextExpectedAt,
      lastSuccessAt,
      lastFailureAt,
      nextInspection,
      latestSession,
      cronJobs,
    };
  }
  return {
    label: "No recent signal",
    tone: "none",
    detail: "No recent session, cron, or live status is attached to this workflow step yet.",
    latestAt: null,
    nextExpectedAt,
    lastSuccessAt,
    lastFailureAt,
    nextInspection,
    latestSession: null,
    cronJobs,
  };
}

function workflowRoomStatus(
  map: WorkflowMap,
  props: AgentWorkflowsProps,
  now = Date.now(),
): WorkflowStatus {
  const statuses = map.steps.map((step) => workflowStepStatus(map, step, props, now));
  const priority = ["review", "active", "watch", "stale", "resting", "none"] as const;
  const selected =
    priority.map((tone) => statuses.find((status) => status.tone === tone)).find(Boolean) ??
    statuses[0];
  return {
    ...selected,
    detail:
      selected.tone === "review"
        ? `${statuses.filter((status) => status.tone === "review").length} step${statuses.filter((status) => status.tone === "review").length === 1 ? "" : "s"} need review.`
        : selected.detail,
    latestAt: newestTimestamp(...statuses.map((status) => status.latestAt)),
    nextExpectedAt:
      statuses
        .map((status) => status.nextExpectedAt)
        .filter((value): value is number => typeof value === "number")
        .toSorted((a, b) => a - b)[0] ?? null,
    lastSuccessAt: newestTimestamp(...statuses.map((status) => status.lastSuccessAt)),
    lastFailureAt: newestTimestamp(...statuses.map((status) => status.lastFailureAt)),
  };
}

function workflowSummary(props: AgentWorkflowsProps) {
  const roomStatuses = WORKFLOW_MAPS.map((map) => workflowRoomStatus(map, props));
  return {
    activeRooms: roomStatuses.filter(
      (status) => status.tone === "active" || status.tone === "watch",
    ).length,
    reviewRooms: roomStatuses.filter(
      (status) => status.tone === "review" || status.tone === "stale",
    ).length,
    scheduledJobs: props.cron?.jobs.length ?? 0,
    latestAt: newestTimestamp(...roomStatuses.map((status) => status.latestAt)),
  };
}

function chipList(items: string[], className: string) {
  return html`
    <span class=${className}> ${items.map((item) => html`<span>${item}</span>`)} </span>
  `;
}

function renderStepCard(
  map: WorkflowMap,
  step: WorkflowStep,
  index: number,
  selected: boolean,
  status: WorkflowStatus,
  props: AgentWorkflowsProps,
) {
  const orderedIds = resolveOrderedWorkflowStepIds(map.id, props.workflowMaps.orders);
  const canMoveBack = index > 0;
  const canMoveForward = index < orderedIds.length - 1;
  const move = (event: Event, direction: "back" | "forward") => {
    event.stopPropagation();
    props.onOrderChange(
      map.id,
      moveWorkflowStepOrder(map.id, props.workflowMaps.orders, step.id, direction),
    );
    props.onSelectStep(step.id);
  };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const dragged =
      event.dataTransfer?.getData("application/x-openclaw-workflow-step") ||
      event.dataTransfer?.getData("text/plain");
    if (!dragged) {
      return;
    }
    props.onOrderChange(
      map.id,
      dropWorkflowStepBefore(map.id, props.workflowMaps.orders, dragged, step.id),
    );
    props.onSelectStep(dragged);
  };
  return html`
    <li>
      <article
        class="agent-workflow-step ${selected ? "agent-workflow-step--selected" : ""}"
        role="button"
        tabindex="0"
        draggable="true"
        aria-label=${`${step.title}. ${step.summary}`}
        @click=${() => props.onSelectStep(step.id)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onSelectStep(step.id);
          }
        }}
        @dragstart=${(event: DragEvent) => {
          event.dataTransfer?.setData("application/x-openclaw-workflow-step", step.id);
          event.dataTransfer?.setData("text/plain", step.id);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
          }
        }}
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${handleDrop}
      >
        <div class="agent-workflow-step__top">
          <span class="agent-workflow-step__index">${index + 1}</span>
          <span class="agent-workflow-step__title">${step.title}</span>
        </div>
        <div class="agent-workflow-status agent-workflow-status--${status.tone}">
          <strong>${status.label}</strong>
          <span
            >${status.latestAt ? formatRelativeTimestamp(status.latestAt) : "No timestamp"}</span
          >
        </div>
        <p>${step.summary}</p>
        <div class="agent-workflow-step__signal">
          Owner:
          ${step.agents
            .slice(0, 2)
            .map((agentId) => resolveAgentName(agentId, props.agents))
            .join(", ")}
        </div>
        <div class="agent-workflow-step__chips">
          ${chipList(
            step.agents.slice(0, 3).map((agentId) => resolveAgentName(agentId, props.agents)),
            "agent-workflow-chips agent-workflow-chips--agents",
          )}
          <span class="agent-workflow-codex agent-workflow-codex--${codexPolicyTone(step.codex)}"
            >${codexPolicyLabel(step.codex)}</span
          >
        </div>
        <div class="agent-workflow-step__tools">
          ${step.programs.slice(0, 4).map((program) => html`<span>${program}</span>`)}
        </div>
        <div class="agent-workflow-step__signal">${status.detail}</div>
        <div class="agent-workflow-step__actions" aria-label="Modify workflow order">
          <button
            type="button"
            class="btn btn--xs btn--ghost"
            ?disabled=${!canMoveBack}
            @click=${(event: Event) => move(event, "back")}
          >
            Earlier
          </button>
          <button
            type="button"
            class="btn btn--xs btn--ghost"
            ?disabled=${!canMoveForward}
            @click=${(event: Event) => move(event, "forward")}
          >
            Later
          </button>
        </div>
      </article>
    </li>
  `;
}

function renderStepDetails(step: WorkflowStep, status: WorkflowStatus, agents: GatewayAgentRow[]) {
  return html`
    <aside class="agent-workflow-detail" aria-label="Selected workflow step">
      <div class="agent-workflow-detail__eyebrow">Selected Step</div>
      <h3>${step.title}</h3>
      <p>${step.summary}</p>
      <dl>
        <div class="agent-workflow-detail__signal">
          <dt>Current Signal</dt>
          <dd>
            <span class="agent-workflow-status agent-workflow-status--${status.tone}">
              <strong>${status.label}</strong>
              <span
                >${status.latestAt
                  ? formatRelativeTimestamp(status.latestAt)
                  : "No recent signal"}</span
              >
            </span>
            <p>${status.detail}</p>
          </dd>
        </div>
        <div>
          <dt>Next Inspection Target</dt>
          <dd>${status.nextInspection}</dd>
        </div>
        <div>
          <dt>Next Expected Run</dt>
          <dd>
            ${status.nextExpectedAt
              ? formatRelativeTimestamp(status.nextExpectedAt)
              : "No scheduled run visible"}
          </dd>
        </div>
        <div>
          <dt>Last Success</dt>
          <dd>
            ${status.lastSuccessAt
              ? formatRelativeTimestamp(status.lastSuccessAt)
              : "No success signal"}
          </dd>
        </div>
        <div>
          <dt>Last Failure</dt>
          <dd>
            ${status.lastFailureAt
              ? formatRelativeTimestamp(status.lastFailureAt)
              : "No failure signal"}
          </dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>${step.trigger}</dd>
        </div>
        <div>
          <dt>Agents</dt>
          <dd>
            ${chipList(
              step.agents.map((agentId) => resolveAgentName(agentId, agents)),
              "agent-workflow-chips agent-workflow-chips--agents",
            )}
          </dd>
        </div>
        <div>
          <dt>Programs and Tools</dt>
          <dd>${chipList(step.programs, "agent-workflow-chips")}</dd>
        </div>
        <div>
          <dt>Scheduled Jobs</dt>
          <dd>
            ${status.cronJobs.length > 0
              ? chipList(
                  status.cronJobs.slice(0, 4).map((job) => job.name ?? job.id),
                  "agent-workflow-chips",
                )
              : "No directly related scheduled jobs"}
          </dd>
        </div>
        <div>
          <dt>Latest Session</dt>
          <dd>
            ${status.latestSession
              ? (status.latestSession.derivedTitle ??
                status.latestSession.displayName ??
                status.latestSession.label ??
                status.latestSession.key)
              : "No related session yet"}
          </dd>
        </div>
        <div>
          <dt>Codex Use</dt>
          <dd>
            <span class="agent-workflow-codex agent-workflow-codex--${codexPolicyTone(step.codex)}"
              >${codexPolicyLabel(step.codex)}</span
            >
          </dd>
        </div>
        <div>
          <dt>Approval Gate</dt>
          <dd>${step.approval}</dd>
        </div>
        <div>
          <dt>Outputs</dt>
          <dd>
            <ul>
              ${step.outputs.map((output) => html`<li>${output}</li>`)}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Handoff</dt>
          <dd>${step.handoff}</dd>
        </div>
      </dl>
    </aside>
  `;
}

export function renderAgentWorkflows(props: AgentWorkflowsProps) {
  const selectedMap = resolveWorkflowMap(
    props.workflowMaps.selectedRoomId ?? DEFAULT_WORKFLOW_ROOM_ID,
  );
  const orderedSteps = orderedWorkflowSteps(selectedMap, props.workflowMaps.orders);
  const selectedStep =
    orderedSteps.find((step) => step.id === props.workflowMaps.selectedStepId) ?? orderedSteps[0];
  const stepStatuses = new Map(
    orderedSteps.map((step) => [step.id, workflowStepStatus(selectedMap, step, props)]),
  );
  const selectedStatus = selectedStep ? stepStatuses.get(selectedStep.id) : null;
  const summary = workflowSummary(props);
  const activeAgentCount = new Set(selectedMap.steps.flatMap((step) => step.agents)).size;
  const programCount = new Set(selectedMap.steps.flatMap((step) => step.programs)).size;

  return html`
    <section class="agent-workflows-shell" aria-label="OpenClaw workflow maps">
      <header class="agent-workflows-header">
        <div>
          <div class="card-title">OpenClaw Agent Workflow Maps</div>
          <div class="card-sub">
            Workflow Health for each Live Agent Workspace room, including owners, tools, Codex
            gates, approvals, handoffs, and live inspection signals.
          </div>
        </div>
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          @click=${() => props.onResetRoom(selectedMap.id)}
        >
          Reset This Map
        </button>
      </header>

      <div class="agent-workflows-summary" aria-label="Workflow operations summary">
        <span><strong>${summary.activeRooms}</strong> active / on watch rooms</span>
        <span><strong>${summary.reviewRooms}</strong> stale or needs review</span>
        <span><strong>${summary.scheduledJobs}</strong> scheduled jobs visible</span>
        <span
          ><strong
            >${summary.latestAt ? formatRelativeTimestamp(summary.latestAt) : "No signal"}</strong
          >
          last workflow signal</span
        >
      </div>

      <div class="agent-workflows-grid">
        <nav class="agent-workflows-rooms" aria-label="Workflow project rooms">
          ${WORKFLOW_MAPS.map((map) => {
            const roomStatus = workflowRoomStatus(map, props);
            return html`
              <button
                type="button"
                class=${selectedMap.id === map.id ? "active" : ""}
                @click=${() => props.onSelectRoom(map.id)}
              >
                <span>${map.label}</span>
                <em>${map.steps.length} steps</em>
                <b class="agent-workflow-status agent-workflow-status--${roomStatus.tone}"
                  >${roomStatus.label}</b
                >
              </button>
            `;
          })}
        </nav>

        <div class="agent-workflows-main">
          <section class="agent-workflow-map">
            <div class="agent-workflow-map__intro">
              <div>
                <h2>${selectedMap.label}</h2>
                <p>${selectedMap.goal}</p>
              </div>
              <div class="agent-workflow-map__stats" aria-label="Workflow summary">
                <span><strong>${orderedSteps.length}</strong> steps</span>
                <span><strong>${activeAgentCount}</strong> agents</span>
                <span><strong>${programCount}</strong> tools</span>
              </div>
            </div>
            <div class="agent-workflow-map__meta">
              <span>${selectedMap.subtitle}</span>
              <span>${selectedMap.cadence}</span>
            </div>
            <div class="agent-workflow-edit-hint">
              Click a step to inspect it. Drag steps or use Earlier/Later to adjust the
              browser-local visual order without changing automation behavior; these controls are
              visual-only until real automation wiring is explicitly added.
            </div>
            <ol class="agent-workflow-lane">
              ${orderedSteps.map((step, index) =>
                renderStepCard(
                  selectedMap,
                  step,
                  index,
                  step.id === selectedStep?.id,
                  stepStatuses.get(step.id) ?? workflowStepStatus(selectedMap, step, props),
                  props,
                ),
              )}
            </ol>
          </section>

          ${selectedStep && selectedStatus
            ? renderStepDetails(selectedStep, selectedStatus, props.agents)
            : nothing}
        </div>
      </div>
    </section>
  `;
}
