/**
 * Types for the OpenClaw Control Console views:
 * - Run trace / call chain visualization
 * - System prompt inspector
 * - Security policy observer
 */

// ─── Run Trace Types ───────────────────────────────────────────

export type TraceNodeKind =
  | "inbound"
  | "router"
  | "prompt-assembly"
  | "model-call"
  | "tool-call"
  | "subagent"
  | "outbound"
  | "error";

export type TraceNodeStatus = "pending" | "running" | "success" | "error" | "skipped";

export type TraceNode = {
  id: string;
  kind: TraceNodeKind;
  label: string;
  status: TraceNodeStatus;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
  /** For subagent nodes, the nested trace */
  children?: TraceNode[];
  /** Token usage for model-call nodes */
  tokens?: { input: number; output: number; total: number };
  /** Error message for error nodes */
  error?: string;
};

export type TraceEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type RunTrace = {
  runId: string;
  sessionKey: string;
  agentId: string;
  startedAt: number;
  completedAt: number | null;
  status: TraceNodeStatus;
  nodes: TraceNode[];
  edges: TraceEdge[];
  totalTokens: { input: number; output: number; total: number };
  totalDurationMs: number | null;
};

export type RunListEntry = {
  runId: string;
  sessionKey: string;
  agentId: string;
  startedAt: number;
  completedAt: number | null;
  status: TraceNodeStatus;
  totalTokens: { input: number; output: number; total: number };
  nodeCount: number;
  toolCallCount: number;
  subagentCount: number;
};

// ─── System Prompt Types ───────────────────────────────────────

export type PromptSectionKind =
  | "system-base"
  | "bootstrap"
  | "claude-md"
  | "agents-md"
  | "skills"
  | "tools-catalog"
  | "runtime-metadata"
  | "session-context"
  | "custom";

export type PromptSection = {
  id: string;
  kind: PromptSectionKind;
  label: string;
  source: string | null;
  content: string;
  tokenCount: number;
  injectedAt: number | null;
  order: number;
};

export type PromptSnapshot = {
  agentId: string;
  sessionKey: string | null;
  sections: PromptSection[];
  totalTokens: number;
  bootstrapFiles: BootstrapFile[];
  skillsMetadata: SkillRuntimeMeta[];
  capturedAt: number;
};

export type BootstrapFile = {
  path: string;
  exists: boolean;
  sizeBytes: number;
  tokenCount: number;
};

export type SkillRuntimeMeta = {
  name: string;
  key: string;
  enabled: boolean;
  source: string;
  triggerPattern: string | null;
  tokenBudget: number | null;
};

// ─── Security Policy Types ─────────────────────────────────────

export type ToolPolicyAction = "allow" | "deny" | "ask" | "gated";

export type ToolPolicy = {
  toolName: string;
  action: ToolPolicyAction;
  conditions: string[];
  source: string;
  priority: number;
};

export type SkillGatingRule = {
  skillKey: string;
  skillName: string;
  gated: boolean;
  requiredApiKey: boolean;
  hasApiKey: boolean;
  trustLevel: "builtin" | "verified" | "community" | "local";
  source: string;
};

export type PluginTrustEntry = {
  pluginId: string;
  pluginName: string;
  trusted: boolean;
  trustReason: string;
  permissions: string[];
  source: string;
  version: string | null;
  integrity: "verified" | "unverified" | "tampered";
};

export type HookEntry = {
  hookId: string;
  event: string;
  command: string;
  enabled: boolean;
  source: string;
  lastTriggeredAt: number | null;
  lastResult: "success" | "failure" | null;
};

export type SecuritySnapshot = {
  toolPolicies: ToolPolicy[];
  skillGating: SkillGatingRule[];
  pluginTrust: PluginTrustEntry[];
  hooks: HookEntry[];
  execApprovalMode: string;
  capturedAt: number;
};

// ─── Session Transcript Types ──────────────────────────────────

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  tokens: number;
  toolName?: string;
  toolCallId?: string;
  runId?: string;
};

export type SessionDetail = {
  key: string;
  agentId: string;
  kind: string;
  transcript: TranscriptEntry[];
  totalTokens: { input: number; output: number; total: number };
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  runs: RunListEntry[];
};
