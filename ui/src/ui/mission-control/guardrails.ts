import type { MissionAgentCard, MissionMemoryRecord, MissionWorkItem } from "./types.ts";

export type GuardrailWarning = {
  id: string;
  severity: "info" | "medium" | "high";
  message: string;
};

function hasEvidenceContract(memoryRecords: MissionMemoryRecord[]): boolean {
  return memoryRecords.some((record) => record.key.includes("scout-output-contract"));
}

export function computeGuardrailWarnings(
  agent: MissionAgentCard,
  workItems: MissionWorkItem[],
  memoryRecords: MissionMemoryRecord[],
): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  const active = workItems.filter((item) => item.owner === agent.id && item.stage !== "done");

  if (
    agent.id === "orbit" &&
    active.some((item) => item.stage === "execution" || item.stage === "review")
  ) {
    warnings.push({
      id: "orbit-execution-owner",
      severity: "high",
      message: "Orbit should not be primary executor on non-trivial execution/review stages.",
    });
  }

  if (agent.id === "atlas" && agent.currentMode && !["plan", "draft"].includes(agent.currentMode)) {
    warnings.push({
      id: "atlas-mode",
      severity: "high",
      message: "Atlas mode must stay plan/draft.",
    });
  }

  if (
    agent.id === "forge" &&
    active.some((item) => item.blocked && !item.requiredArtifact && !item.nextOwner)
  ) {
    warnings.push({
      id: "forge-scope",
      severity: "medium",
      message: "Blocked Forge work should include explicit escalation artifact.",
    });
  }

  if (
    agent.id === "review" &&
    active.some((item) => item.stage === "review" && !item.requiredArtifact)
  ) {
    warnings.push({
      id: "review-structured-outcome",
      severity: "medium",
      message: "Review-stage work should publish structured validation outcome.",
    });
  }

  if (agent.id === "vault" && memoryRecords.some((record) => !record.sourceRefs?.length)) {
    warnings.push({
      id: "vault-source-refs",
      severity: "high",
      message: "Vault records require source references.",
    });
  }

  if (agent.id === "scout" && active.length > 0 && !hasEvidenceContract(memoryRecords)) {
    warnings.push({
      id: "scout-contract",
      severity: "info",
      message: "Evidence/inference/unknowns contract is not yet confirmed in memory records.",
    });
  }

  return warnings;
}
