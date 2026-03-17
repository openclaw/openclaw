import { MC_CONFIG } from "./generated-config.ts";

const fallbackStages = [
  "intake",
  "context",
  "research",
  "planning",
  "drafting",
  "execution",
  "review",
  "final_synthesis",
  "memory_sync",
  "done",
  "blocked",
];

const fallbackGuardrails = [
  "orbit_not_primary_executor_on_non_trivial_work",
  "scout_must_separate_evidence_inference_unknowns",
  "atlas_modes_limited_to_plan_and_draft",
  "forge_cannot_redefine_scope_without_block",
  "review_must_issue_structured_outcome",
  "vault_only_stores_explicit_or_strongly_supported_memory",
];

export const MC_STAGES = (
  MC_CONFIG.workflow?.stages?.length ? MC_CONFIG.workflow.stages : fallbackStages
) as ReadonlyArray<string>;

export const MC_GUARDRAILS = (
  MC_CONFIG.workflow?.guardrails?.length ? MC_CONFIG.workflow.guardrails : fallbackGuardrails
) as ReadonlyArray<string>;

export const MC_FLAG_DEFAULT = MC_CONFIG.featureFlags?.missionControl ?? true;
export const MC_AGENTS = MC_CONFIG.team?.agents ?? [];
