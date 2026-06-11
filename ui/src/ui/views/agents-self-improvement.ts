import { html, nothing } from "lit";
import type {
  SelfImprovementActionQueueSummary,
  SelfImprovementActionability,
  SelfImprovementAnalysisRunResult,
  SelfImprovementAuditEvent,
  SelfImprovementDailyScorecard,
  SelfImprovementMaintenanceResult,
  SelfImprovementModelPreflightResult,
  SelfImprovementOperationalHealthResult,
  SelfImprovementProductionCheckResult,
  SelfImprovementProposal,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationGroup,
  SelfImprovementScanResult,
  SelfImprovementScorecard,
} from "../types.ts";

export type SelfImprovementPanelProps = {
  loading: boolean;
  error: string | null;
  recommendations: SelfImprovementRecommendation[];
  groups: SelfImprovementRecommendationGroup[];
  scorecard: SelfImprovementScorecard | null;
  scorecards: SelfImprovementDailyScorecard[];
  health: SelfImprovementOperationalHealthResult | null;
  proposals: SelfImprovementProposal[];
  auditEvents: SelfImprovementAuditEvent[];
  total: number;
  scanLoading: boolean;
  lastScan: SelfImprovementScanResult["scan"] | null;
  analysisLoading: boolean;
  lastAnalysis: SelfImprovementAnalysisRunResult | null;
  modelPreflightLoading: boolean;
  lastModelPreflight: SelfImprovementModelPreflightResult | null;
  productionCheckLoading: boolean;
  lastProductionCheck: SelfImprovementProductionCheckResult | null;
  maintenanceLoading: boolean;
  lastMaintenance: SelfImprovementMaintenanceResult | null;
  onRefresh: () => void;
  onScan: () => void;
  onAnalyze: () => void;
  onModelPreflight: () => void;
  onProductionCheck: () => void;
  onMaintenanceDryRun: () => void;
  onRecommendationUpdate: (input: {
    id: string;
    status: string;
    note?: string;
    assignedTargetAgentId?: string;
    claimedBy?: string;
    resolutionProof?: string;
    dismissalReason?: string;
  }) => void;
  onGroupUpdate: (input: {
    id: string;
    status: string;
    note?: string;
    assignedTargetAgentId?: string;
    claimedBy?: string;
    resolutionProof?: string;
    dismissalReason?: string;
  }) => void;
  onCuratorUpdate: (input: {
    id: string;
    curatorStatus: string;
    proof?: string;
    reason?: string;
    workshopProposalId?: string;
    workshopProposalStatus?: string;
    note?: string;
  }) => void;
};

function formatLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatTime(value: number | null | undefined): string {
  if (!value) {
    return "Never";
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatModelMeta(params: {
  mode?: string;
  tier?: string;
  modelId?: string;
  confidence?: number;
  quantization?: string;
  parameters?: string;
  contextWindow?: number;
  attemptCount?: number;
  preflightStatus?: string;
  preflightSource?: string;
  preflightMs?: number;
  providerConfigured?: boolean;
  schemaValidated?: boolean;
  escalationReason?: string;
}): string {
  const parts = [
    params.mode,
    params.tier ? `tier ${params.tier}` : undefined,
    params.modelId,
    params.confidence !== undefined
      ? `confidence ${Math.round(Math.min(1, Math.max(0, params.confidence)) * 100)}%`
      : undefined,
    params.quantization,
    params.parameters,
    params.contextWindow ? `${params.contextWindow.toLocaleString()} ctx` : undefined,
    params.attemptCount !== undefined ? `${params.attemptCount} attempt(s)` : undefined,
    params.preflightStatus
      ? `preflight ${params.preflightStatus}${
          params.preflightMs !== undefined ? ` ${params.preflightMs}ms` : ""
        }`
      : undefined,
    params.preflightSource ? `source ${params.preflightSource}` : undefined,
    params.providerConfigured !== undefined
      ? `provider ${params.providerConfigured ? "configured" : "default"}`
      : undefined,
    params.schemaValidated !== undefined
      ? `schema ${params.schemaValidated ? "valid" : "not validated"}`
      : undefined,
    params.escalationReason,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.join(" | ");
}

function renderActionabilityChips(actionability: SelfImprovementActionability | undefined) {
  if (!actionability) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-actionability">
      <span>Owner ${formatLabel(actionability.ownerState)}</span>
      <span>SLA ${formatLabel(actionability.slaState)}</span>
      <span>Proof ${formatLabel(actionability.proofState)}</span>
      <span>Closure ${formatLabel(actionability.closureState)}</span>
    </div>
    ${actionability.blockers.length > 0
      ? html`
          <div class="agent-self-improvement-card__section">
            <strong>Action blockers</strong>
            <span>${actionability.blockers.slice(0, 3).join(" | ")}</span>
          </div>
        `
      : nothing}
    <div class="agent-self-improvement-card__section">
      <strong>Next operator action</strong>
      <span>${actionability.nextAction}</span>
    </div>
  `;
}

function renderRecommendationControls(
  recommendation: SelfImprovementRecommendation,
  onUpdate: SelfImprovementPanelProps["onRecommendationUpdate"],
) {
  const closed = recommendation.status === "resolved" || recommendation.status === "dismissed";
  if (closed) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-actions">
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() => onUpdate({ id: recommendation.id, status: "acknowledged" })}
      >
        Acknowledge
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: recommendation.id,
            status: "assigned",
            assignedTargetAgentId: recommendation.route.targetAgentId,
          })}
      >
        Assign
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: recommendation.id,
            status: "in_progress",
            claimedBy: "",
          })}
      >
        Claim
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() => onUpdate({ id: recommendation.id, status: "in_progress" })}
      >
        In progress
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: recommendation.id,
            status: "in_progress",
            resolutionProof: "",
          })}
      >
        Attach proof
      </button>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() =>
          onUpdate({
            id: recommendation.id,
            status: "resolved",
            resolutionProof: "",
          })}
      >
        Resolve
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() => onUpdate({ id: recommendation.id, status: "dismissed" })}
      >
        Dismiss
      </button>
    </div>
  `;
}

function renderGroupControls(
  group: SelfImprovementRecommendationGroup,
  onUpdate: SelfImprovementPanelProps["onGroupUpdate"],
) {
  const closed = group.status === "resolved" || group.status === "dismissed";
  if (closed) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-actions">
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: group.id,
            status: "assigned",
            assignedTargetAgentId: group.route.targetAgentId,
          })}
      >
        Assign group
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() => onUpdate({ id: group.id, status: "in_progress" })}
      >
        In progress
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: group.id,
            status: "in_progress",
            resolutionProof: "",
          })}
      >
        Attach proof
      </button>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() =>
          onUpdate({
            id: group.id,
            status: "resolved",
            resolutionProof: "",
          })}
      >
        Resolve group
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() => onUpdate({ id: group.id, status: "dismissed" })}
      >
        Dismiss group
      </button>
    </div>
  `;
}

function formatAttemptDiagnosticSummary(
  attempts: Array<{ tier: string; diagnostic?: string }>,
): string {
  return attempts
    .filter((attempt) => attempt.diagnostic)
    .slice(0, 3)
    .map((attempt) => `${attempt.tier} diagnostic ${attempt.diagnostic}`)
    .join(" | ");
}

function formatAttemptProfileSummary(
  attempts: Array<{
    tier: string;
    status: string;
    modelId: string;
    quantization?: string;
    parameters?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    timeoutMs?: number;
    completionMs?: number;
    preflightStatus?: string;
    preflightSource?: string;
    preflightMs?: number;
    providerConfigured?: boolean;
    schemaValidated?: boolean;
    diagnostic?: string;
    remediationHint?: string;
  }>,
): string[] {
  return attempts.slice(0, 3).map((attempt) => {
    const parts = [
      `${attempt.tier} ${attempt.status} ${attempt.modelId}`,
      attempt.quantization,
      attempt.parameters,
      attempt.contextWindow ? `${attempt.contextWindow.toLocaleString()} ctx` : undefined,
      attempt.maxOutputTokens ? `max ${attempt.maxOutputTokens.toLocaleString()}` : undefined,
      attempt.temperature !== undefined ? `temp ${attempt.temperature}` : undefined,
      attempt.topP !== undefined ? `top_p ${attempt.topP}` : undefined,
      attempt.timeoutMs !== undefined ? `timeout ${attempt.timeoutMs}ms` : undefined,
      attempt.completionMs !== undefined ? `completion ${attempt.completionMs}ms` : undefined,
      attempt.preflightStatus
        ? `preflight ${attempt.preflightStatus}${
            attempt.preflightMs !== undefined ? ` ${attempt.preflightMs}ms` : ""
          }`
        : undefined,
      attempt.preflightSource ? `source ${attempt.preflightSource}` : undefined,
      attempt.providerConfigured !== undefined
        ? `provider ${attempt.providerConfigured ? "configured" : "default"}`
        : undefined,
      attempt.schemaValidated !== undefined
        ? `schema ${attempt.schemaValidated ? "valid" : "not validated"}`
        : undefined,
      attempt.diagnostic ? `diagnostic ${attempt.diagnostic}` : undefined,
      attempt.remediationHint ? `next ${attempt.remediationHint}` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    return parts.join(" | ");
  });
}

function renderRecommendationCard(
  recommendation: SelfImprovementRecommendation,
  onUpdate: SelfImprovementPanelProps["onRecommendationUpdate"],
) {
  const testsStatus = recommendation.safety.requiresTests ? "required" : "as needed";
  const approvalStatus = recommendation.safety.requiresApproval ? "required" : "as needed";
  return html`
    <article class="agent-self-improvement-card">
      <div class="agent-self-improvement-card__header">
        <div>
          <div class="agent-self-improvement-card__title">${recommendation.title}</div>
          <div class="agent-self-improvement-card__meta">
            ${formatLabel(recommendation.severity)} criticality | ${recommendation.status} |
            ${formatLabel(recommendation.category)} | confidence
            ${Math.round(recommendation.confidence * 100)}%
          </div>
        </div>
        <div class="agent-self-improvement-route">
          <span>${recommendation.route.targetAgentLabel}</span>
          <small>${recommendation.route.targetAgentId}</small>
        </div>
      </div>
      <p>${recommendation.summary}</p>
      <div class="agent-self-improvement-card__section">
        <strong>Recommended action</strong>
        <span>${recommendation.recommendedAction}</span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Required evidence</strong>
        <ul>
          ${recommendation.requiredEvidence.map((item) => html`<li>${item}</li>`)}
        </ul>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Safety</strong>
        <span>Recommendation-only | tests ${testsStatus} | approval ${approvalStatus}</span>
      </div>
      ${renderActionabilityChips(recommendation.actionability)}
      ${renderRecommendationControls(recommendation, onUpdate)}
    </article>
  `;
}

function renderScorecard(scorecard: SelfImprovementScorecard | null, total: number) {
  const values = scorecard ?? {
    activeRecommendations: total,
    groupedRecommendations: 0,
    criticalOpen: 0,
    highOpen: 0,
    testRequired: 0,
    approvalRequired: 0,
    reopenedLast24h: 0,
    resolvedLast24h: 0,
  };
  return html`
    <div class="agent-self-improvement-scorecard">
      <div>
        <strong>${values.activeRecommendations}</strong>
        <span>Active</span>
      </div>
      <div>
        <strong>${values.groupedRecommendations}</strong>
        <span>Groups</span>
      </div>
      <div>
        <strong>${values.criticalOpen}</strong>
        <span>Critical</span>
      </div>
      <div>
        <strong>${values.highOpen}</strong>
        <span>High</span>
      </div>
      <div>
        <strong>${values.testRequired}</strong>
        <span>Need tests</span>
      </div>
      <div>
        <strong>${values.approvalRequired}</strong>
        <span>Need approval</span>
      </div>
      <div>
        <strong>${values.reopenedLast24h}</strong>
        <span>Reopened 24h</span>
      </div>
      <div>
        <strong>${values.resolvedLast24h}</strong>
        <span>Resolved 24h</span>
      </div>
    </div>
  `;
}

function renderGroupCard(
  group: SelfImprovementRecommendationGroup,
  onUpdate: SelfImprovementPanelProps["onGroupUpdate"],
) {
  const testsStatus = group.requiresTests ? "required" : "as needed";
  const approvalStatus = group.requiresApproval ? "required" : "as needed";
  return html`
    <article class="agent-self-improvement-card agent-self-improvement-card--group">
      <div class="agent-self-improvement-card__header">
        <div>
          <div class="agent-self-improvement-card__title">${group.title}</div>
          <div class="agent-self-improvement-card__meta">
            ${formatLabel(group.priority)} priority | ${group.status} |
            ${formatLabel(group.category)} | ${group.count} related
          </div>
        </div>
        <div class="agent-self-improvement-route">
          <span>${group.route.targetAgentLabel}</span>
          <small>${group.route.targetAgentId}</small>
        </div>
      </div>
      <p>${group.analysis.summary}</p>
      <div class="agent-self-improvement-card__section">
        <strong>Recommended action</strong>
        <span>${group.recommendedAction}</span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Analysis</strong>
        <span>
          ${formatModelMeta({
            mode: group.analysis.mode,
            tier: group.analysis.modelTier,
            modelId: group.analysis.modelId,
            confidence: group.analysis.confidence,
            quantization: group.analysis.quantization,
            parameters: group.analysis.parameters,
            contextWindow: group.analysis.contextWindow,
            attemptCount: group.analysis.attemptCount,
            preflightStatus: group.analysis.preflightStatus,
            preflightSource: group.analysis.preflightSource,
            preflightMs: group.analysis.preflightMs,
            providerConfigured: group.analysis.providerConfigured,
            schemaValidated: group.analysis.schemaValidated,
            escalationReason: group.analysis.escalationReason,
          })}
        </span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Evidence</strong>
        <ul>
          ${group.topEvidence.slice(0, 4).map((item) => html`<li>${item}</li>`)}
        </ul>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Safety</strong>
        <span>Recommendation-only | tests ${testsStatus} | approval ${approvalStatus}</span>
      </div>
      ${renderActionabilityChips(group.actionability)} ${renderGroupControls(group, onUpdate)}
    </article>
  `;
}

function renderActionQueue(actionQueue: SelfImprovementActionQueueSummary | undefined) {
  if (!actionQueue) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <h3>Action Queue</h3>
      <div class="agent-self-improvement-scorecard">
        <div>
          <strong>${actionQueue.unassigned}</strong>
          <span>Unassigned</span>
        </div>
        <div>
          <strong>${actionQueue.overdue}</strong>
          <span>Overdue</span>
        </div>
        <div>
          <strong>${actionQueue.proofMissing}</strong>
          <span>Proof missing</span>
        </div>
        <div>
          <strong>${actionQueue.readyToResolve}</strong>
          <span>Ready to resolve</span>
        </div>
      </div>
      ${actionQueue.items.length > 0
        ? html`
            <div class="agent-self-improvement-list agent-self-improvement-list--compact">
              ${actionQueue.items.slice(0, 5).map(
                (item) => html`
                  <div class="agent-self-improvement-group-strip">
                    <strong>${item.title}</strong>
                    <span>
                      ${item.kind} | ${formatLabel(item.priority)} | ${item.status} |
                      ${item.route.targetAgentLabel} | ${item.actionability.nextAction}
                    </span>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderImprovementIntelligence(scorecard: SelfImprovementScorecard | null) {
  const intelligence = scorecard?.intelligence;
  if (!intelligence || intelligence.total === 0) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <h3>Improvement Intelligence</h3>
      <div class="agent-self-improvement-scorecard">
        <div>
          <strong>${intelligence.total}</strong>
          <span>Signals</span>
        </div>
        <div>
          <strong>${intelligence.highCritical}</strong>
          <span>High/critical</span>
        </div>
        <div>
          <strong>${intelligence.simplificationCandidates.length}</strong>
          <span>Simplification</span>
        </div>
        <div>
          <strong>${intelligence.outcomeMetricGaps.length}</strong>
          <span>Metric gaps</span>
        </div>
      </div>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${intelligence.byCategory.slice(0, 6).map(
          (bucket) => html`
            <div class="agent-self-improvement-group-strip">
              <strong>${bucket.label}</strong>
              <span>
                ${bucket.count} signal${bucket.count === 1 ? "" : "s"} | ${bucket.highCritical}
                high/critical |
                ${bucket.routes.map((route) => `${route.label} ${route.count}`).join(" | ")}
              </span>
            </div>
          `,
        )}
        ${intelligence.topOpportunities.slice(0, 5).map(
          (item) => html`
            <div class="agent-self-improvement-group-strip">
              <strong>${item.title}</strong>
              <span>
                ${formatLabel(item.category)} | ${formatLabel(item.priority)} |
                ${item.route.targetAgentLabel} | confidence
                ${Math.round(Math.min(1, Math.max(0, item.confidence)) * 100)}%
              </span>
              <small>${item.recommendedAction}</small>
            </div>
          `,
        )}
      </div>
      ${intelligence.majorChangeCandidates.length > 0
        ? html`
            <div class="agent-self-improvement-group-strip">
              <strong>Major-change candidates</strong>
              <span>
                ${intelligence.majorChangeCandidates
                  .slice(0, 3)
                  .map((item) => item.title)
                  .join(" | ")}
              </span>
            </div>
          `
        : nothing}
      ${intelligence.instructionThemes.length > 0
        ? html`
            <div class="agent-self-improvement-group-strip">
              <strong>Instruction themes</strong>
              <span>
                ${intelligence.instructionThemes
                  .slice(0, 3)
                  .map((item) => item.title)
                  .join(" | ")}
              </span>
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderScorecardGroupList(title: string, groups: SelfImprovementRecommendationGroup[]) {
  if (groups.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-group-strip">
      <strong>${title}</strong>
      <span>${groups.map((group) => group.title).join(" | ")}</span>
    </div>
  `;
}

function renderScorecardHistory(scorecards: SelfImprovementDailyScorecard[]) {
  if (scorecards.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-history">
      <strong>Daily scorecards</strong>
      <div class="agent-self-improvement-history__items">
        ${scorecards
          .slice(0, 7)
          .map(
            (entry) => html`
              <span>
                ${entry.dateKey}: ${entry.scorecard.activeRecommendations} active,
                ${entry.scorecard.groupedRecommendations} groups
              </span>
            `,
          )}
      </div>
    </div>
  `;
}

function formatAuditMetadataValue(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) {
    return value.slice(0, 3).join(", ");
  }
  return String(value);
}

function selectAuditMetadata(metadata: SelfImprovementAuditEvent["metadata"]) {
  if (!metadata) {
    return [];
  }
  const priorityKeys = [
    "passRate",
    "schemaValidRate",
    "safetyPassRate",
    "routePreservationRate",
    "p95CompletionMs",
    "modelId",
    "modelTier",
    "failedCases",
    "diagnostics",
    "primaryRemediationHint",
    "blockedPrimaryReason",
    "preflightSources",
    "defaultOllamaFallbackAttempts",
    "invalidJsonDiagnostics",
    "blockedRemediationHints",
    "readiness",
    "readyTier",
    "readyModelId",
    "preflightStatus",
  ];
  const entries = Object.entries(metadata);
  const selected = priorityKeys
    .map((key) => entries.find(([entryKey]) => entryKey === key))
    .filter((entry): entry is [string, string | number | boolean | string[]] => Boolean(entry));
  const selectedKeys = new Set(selected.map(([key]) => key));
  return [...selected, ...entries.filter(([key]) => !selectedKeys.has(key))].slice(0, 4);
}

function renderAuditEvents(events: SelfImprovementAuditEvent[]) {
  if (events.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <h3>Audit Ledger</h3>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${events.slice(0, 6).map((event) => {
          const metadata = selectAuditMetadata(event.metadata);
          return html`
            <article class="agent-self-improvement-card agent-self-improvement-card--audit">
              <div class="agent-self-improvement-card__header">
                <div>
                  <div class="agent-self-improvement-card__title">${event.summary}</div>
                  <div class="agent-self-improvement-card__meta">
                    ${formatLabel(event.kind)} | ${event.actor} | ${formatTime(event.createdAt)}
                  </div>
                </div>
                <div class="agent-self-improvement-route">
                  <span>${event.targetId}</span>
                  <small>read-only ledger</small>
                </div>
              </div>
              ${metadata.length > 0
                ? html`
                    <div class="agent-self-improvement-card__section">
                      <strong>Metadata</strong>
                      <span>
                        ${metadata
                          .map(([key, value]) => `${key}: ${formatAuditMetadataValue(value)}`)
                          .join(" | ")}
                      </span>
                    </div>
                  `
                : nothing}
            </article>
          `;
        })}
      </div>
    </div>
  `;
}

function auditMetadataString(
  metadata: SelfImprovementAuditEvent["metadata"] | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function auditMetadataBoolean(
  metadata: SelfImprovementAuditEvent["metadata"] | undefined,
  key: string,
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function auditMetadataNumber(
  metadata: SelfImprovementAuditEvent["metadata"] | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatAuditRate(value: number | undefined): string {
  return value === undefined ? "n/a" : `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function renderOperationalHealth(health: SelfImprovementOperationalHealthResult | null) {
  if (!health) {
    return html`
      <div class="agent-self-improvement-group-strip">
        <strong>Operational health</strong>
        <span>No health data loaded yet.</span>
      </div>
    `;
  }
  const current = health.current;
  return html`
    <div class="agent-self-improvement-subsection">
      <div class="agent-self-improvement-group-strip">
        <strong>Operational health</strong>
        <span>
          ${current.status} | score ${current.score} | trend ${current.trend} | snapshots
          ${health.snapshots.length} | ${formatTime(current.generatedAt)}
        </span>
        ${current.blockers.length > 0
          ? html`<small>${current.blockers.slice(0, 3).join(" | ")}</small>`
          : nothing}
      </div>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${current.dimensions.map(
          (dimension) => html`
            <article class="agent-self-improvement-card agent-self-improvement-card--health">
              <div class="agent-self-improvement-card__header">
                <div>
                  <div class="agent-self-improvement-card__title">${dimension.label}</div>
                  <div class="agent-self-improvement-card__meta">
                    ${dimension.status} | score ${dimension.score}
                  </div>
                </div>
              </div>
              <p>${dimension.summary}</p>
              ${dimension.blockers.length > 0
                ? html`
                    <div class="agent-self-improvement-card__section">
                      <strong>Blockers</strong>
                      <ul>
                        ${dimension.blockers
                          .slice(0, 3)
                          .map((blocker) => html`<li>${blocker}</li>`)}
                      </ul>
                    </div>
                  `
                : nothing}
              <div class="agent-self-improvement-card__section">
                <strong>Next action</strong>
                <span>${dimension.nextActions[0] ?? "No immediate action."}</span>
              </div>
            </article>
          `,
        )}
      </div>
    </div>
  `;
}

function renderReviewerEvalHealth(events: SelfImprovementAuditEvent[]) {
  const event = events.find((entry) => entry.kind === "reviewer_eval_run");
  if (!event) {
    return nothing;
  }
  const metadata = event.metadata;
  const readiness = auditMetadataString(metadata, "readiness") ?? "blocked";
  const ready = auditMetadataBoolean(metadata, "ready") ?? false;
  const passRate = auditMetadataNumber(metadata, "passRate");
  const schemaValidRate = auditMetadataNumber(metadata, "schemaValidRate");
  const safetyPassRate = auditMetadataNumber(metadata, "safetyPassRate");
  const routeRate = auditMetadataNumber(metadata, "routePreservationRate");
  const p95CompletionMs = auditMetadataNumber(metadata, "p95CompletionMs");
  const model =
    auditMetadataString(metadata, "modelId") ??
    auditMetadataString(metadata, "reviewModelId") ??
    "n/a";
  const modelTier = auditMetadataString(metadata, "modelTier");
  const failedCases = Array.isArray(metadata?.failedCases) ? metadata.failedCases : [];
  return html`
    <div class="agent-self-improvement-group-strip">
      <strong>Reviewer eval health</strong>
      <span>
        ${readiness} | ready ${String(ready)} | pass ${formatAuditRate(passRate)} | schema
        ${formatAuditRate(schemaValidRate)} | safety ${formatAuditRate(safetyPassRate)} | route
        ${formatAuditRate(routeRate)}${p95CompletionMs !== undefined
          ? ` | p95 ${p95CompletionMs}ms`
          : ""}
        | model ${model}${modelTier ? ` | tier ${modelTier}` : ""} | ${formatTime(event.createdAt)}
      </span>
      ${failedCases.length > 0
        ? html`<small>${failedCases.slice(0, 3).join(" | ")}</small>`
        : nothing}
    </div>
  `;
}

function renderLastAnalysis(analysis: SelfImprovementAnalysisRunResult | null) {
  if (!analysis) {
    return nothing;
  }
  const readyVia =
    analysis.readyTier && analysis.readyModelId
      ? ` | ready via ${analysis.readyTier} ${analysis.readyModelId}`
      : "";
  const readiness =
    analysis.readiness !== undefined
      ? ` | readiness ${analysis.readiness} | ready ${String(analysis.ready ?? false)}${readyVia}`
      : "";
  const attemptDiagnostics = formatAttemptDiagnosticSummary(analysis.attempts);
  return html`
    <div class="agent-self-improvement-group-strip">
      <strong>Last analysis</strong>
      <span>
        ${formatModelMeta({
          mode: analysis.mode,
          tier: analysis.modelTier,
          modelId: analysis.modelId ?? analysis.reviewModelId,
          confidence: analysis.confidence,
          attemptCount: analysis.attempts.length,
          preflightStatus: analysis.preflightStatus,
          preflightMs: analysis.preflightMs,
          schemaValidated: analysis.schemaValidated,
          escalationReason: analysis.escalationReason,
        })}
        ${readiness} | ${analysis.groupsAnalyzed} group${analysis.groupsAnalyzed === 1 ? "" : "s"}
        analyzed | ${analysis.groupsReviewedByLlm} llm-reviewed |
        ${analysis.groupsReviewedByLocalLlm} local-reviewed | ${analysis.proposalsCreated}
        proposal${analysis.proposalsCreated === 1 ? "" : "s"}
        created${attemptDiagnostics ? ` | ${attemptDiagnostics}` : ""}
        ${analysis.fallbackReason ? ` | ${analysis.fallbackReason}` : ""}
        ${analysis.blockedPrimaryReason ? ` | ${analysis.blockedPrimaryReason}` : ""}
      </span>
      ${analysis.attempts.length > 0
        ? html`<small>${formatAttemptProfileSummary(analysis.attempts).join(" | ")}</small>`
        : nothing}
    </div>
  `;
}

function renderModelPreflight(preflight: SelfImprovementModelPreflightResult | null) {
  if (!preflight) {
    return nothing;
  }
  const readiness = preflight.readiness ?? (preflight.ready ? "ready" : "blocked");
  const readyVia =
    preflight.readyTier && preflight.readyModelId
      ? ` | ready via ${preflight.readyTier} ${preflight.readyModelId}`
      : "";
  const attemptSummaries = formatAttemptProfileSummary(preflight.attempts);
  const attemptBlockers = preflight.attempts
    .filter((attempt) => attempt.error)
    .slice(0, 2)
    .map(
      (attempt) =>
        `${attempt.tier}: ${attempt.error}${
          attempt.remediationHint ? ` Next: ${attempt.remediationHint}` : ""
        }`,
    );
  return html`
    <div class="agent-self-improvement-group-strip">
      <strong>Model readiness</strong>
      <span>
        ${readiness} | ready ${String(preflight.ready)}${readyVia} | policy
        ${preflight.reviewPolicy} |
        ${formatModelMeta({
          mode: preflight.localFirst ? "local first" : "hosted",
          modelId: preflight.reviewModelId ?? preflight.hostedModelId,
          attemptCount: preflight.attempts.length,
          preflightStatus: preflight.preflightStatus,
          preflightMs: preflight.preflightMs,
          schemaValidated: preflight.schemaValidated,
          escalationReason: preflight.escalationReason,
        })}${preflight.fallbackReason ? ` | ${preflight.fallbackReason}` : ""}
        ${preflight.blockedPrimaryReason ? ` | ${preflight.blockedPrimaryReason}` : ""}
      </span>
      ${attemptSummaries.length > 0
        ? html`<small>${attemptSummaries.join(" | ")}</small>`
        : nothing}
      ${attemptBlockers.length > 0
        ? html`<small class="agent-self-improvement-group-strip__blockers"
            >${attemptBlockers.join(" | ")}</small
          >`
        : nothing}
    </div>
  `;
}

function renderProductionCheck(check: SelfImprovementProductionCheckResult | null) {
  if (!check) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <div class="agent-self-improvement-group-strip">
        <strong>Production readiness</strong>
        <span>
          ${check.status} | ready ${String(check.ready)} | score ${check.score} | evidence
          ${check.evidence.length} | ${formatTime(check.checkedAt)}
        </span>
        ${check.blockers.length > 0
          ? html`<small>${check.blockers.slice(0, 3).join(" | ")}</small>`
          : check.warnings.length > 0
            ? html`<small>${check.warnings.slice(0, 3).join(" | ")}</small>`
            : nothing}
      </div>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${check.evidence.slice(0, 6).map(
          (item) => html`
            <div class="agent-self-improvement-group-strip">
              <strong>${item.label}</strong>
              <span>${item.status} | ${item.summary}</span>
              <small>${item.source}</small>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function renderMaintenanceResult(maintenance: SelfImprovementMaintenanceResult | null) {
  if (!maintenance) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <div class="agent-self-improvement-group-strip">
        <strong>Retention maintenance</strong>
        <span>
          ${maintenance.applied ? "applied" : "dry run"} | pruned ${maintenance.totalPruned} |
          before ${maintenance.totalBefore} | after ${maintenance.totalAfter} |
          ${formatTime(maintenance.maintainedAt)}
        </span>
        ${maintenance.auditEventId ? html`<small>${maintenance.auditEventId}</small>` : nothing}
      </div>
      <div class="agent-self-improvement-scorecard">
        ${maintenance.stores.map(
          (store) => html`
            <div>
              <strong>${store.pruned}</strong>
              <span>${formatLabel(store.store)}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function renderProposalCard(proposal: SelfImprovementProposal) {
  const testsStatus = proposal.testsRequired ? "required" : "as needed";
  const approvalStatus = proposal.approvalRequired ? "required" : "as needed";
  return html`
    <article class="agent-self-improvement-card agent-self-improvement-card--proposal">
      <div class="agent-self-improvement-card__header">
        <div>
          <div class="agent-self-improvement-card__title">${proposal.title}</div>
          <div class="agent-self-improvement-card__meta">
            ${formatLabel(proposal.kind)} | ${proposal.status} |
            ${proposal.sourceRecommendationIds.length} source
            recommendation${proposal.sourceRecommendationIds.length === 1 ? "" : "s"}
          </div>
        </div>
        <div class="agent-self-improvement-route">
          <span>${proposal.route.targetAgentLabel}</span>
          <small>${proposal.route.targetAgentId}</small>
        </div>
      </div>
      <p>${proposal.summary}</p>
      <div class="agent-self-improvement-card__section">
        <strong>Recommended action</strong>
        <span>${proposal.recommendedAction}</span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Safety</strong>
        <span>Pending mode | tests ${testsStatus} | approval ${approvalStatus}</span>
      </div>
    </article>
  `;
}

function renderCuratorControls(
  proposal: SelfImprovementProposal,
  onUpdate: SelfImprovementPanelProps["onCuratorUpdate"],
) {
  if (proposal.kind !== "memory_skill" || proposal.curatorStatus === "promoted") {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-actions">
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: proposal.id,
            curatorStatus: "accepted_for_workshop",
            proof: "",
          })}
      >
        Accept
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: proposal.id,
            curatorStatus: "accepted_for_workshop",
            proof: "",
            workshopProposalId: "",
            workshopProposalStatus: "pending",
          })}
      >
        Link workshop
      </button>
      <button
        class="btn btn--sm"
        type="button"
        @click=${() =>
          onUpdate({
            id: proposal.id,
            curatorStatus: "promoted",
            proof: "",
            workshopProposalStatus: "applied",
          })}
      >
        Promotion proof
      </button>
      <button
        class="btn btn--sm btn--ghost"
        type="button"
        @click=${() =>
          onUpdate({
            id: proposal.id,
            curatorStatus: "rejected",
            reason: "",
          })}
      >
        Reject
      </button>
    </div>
  `;
}

function renderCuratorCard(
  proposal: SelfImprovementProposal,
  onUpdate: SelfImprovementPanelProps["onCuratorUpdate"],
) {
  const workshop = proposal.workshopProposalId
    ? `${proposal.workshopProposalId} (${proposal.workshopProposalStatus ?? "pending"})`
    : "unlinked";
  const proofState = proposal.promotionProof
    ? "promotion proof attached"
    : proposal.curatorProof
      ? "curator proof attached"
      : "proof missing";
  return html`
    <article class="agent-self-improvement-card agent-self-improvement-card--proposal">
      <div class="agent-self-improvement-card__header">
        <div>
          <div class="agent-self-improvement-card__title">${proposal.title}</div>
          <div class="agent-self-improvement-card__meta">
            curator ${formatLabel(proposal.curatorStatus ?? "pending_review")} | proposal
            ${proposal.status} | ${proofState}
          </div>
        </div>
        <div class="agent-self-improvement-route">
          <span>${proposal.route.targetAgentLabel}</span>
          <small>${proposal.route.targetAgentId}</small>
        </div>
      </div>
      <p>${proposal.summary}</p>
      <div class="agent-self-improvement-card__section">
        <strong>Workshop</strong>
        <span>${workshop}</span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Recommended action</strong>
        <span>${proposal.recommendedAction}</span>
      </div>
      <div class="agent-self-improvement-card__section">
        <strong>Safety</strong>
        <span>Pending mode | no direct skill write | proof required before promotion</span>
      </div>
      ${renderCuratorControls(proposal, onUpdate)}
    </article>
  `;
}

function renderCuratorQueue(
  proposals: SelfImprovementProposal[],
  onUpdate: SelfImprovementPanelProps["onCuratorUpdate"],
) {
  const curatorProposals = proposals.filter((proposal) => proposal.kind === "memory_skill");
  if (curatorProposals.length === 0) {
    return nothing;
  }
  const pending = curatorProposals.filter(
    (proposal) =>
      !proposal.curatorStatus ||
      proposal.curatorStatus === "pending_review" ||
      proposal.curatorStatus === "needs_more_evidence",
  ).length;
  const acceptedUnlinked = curatorProposals.filter(
    (proposal) =>
      proposal.curatorStatus === "accepted_for_workshop" && !proposal.workshopProposalId,
  ).length;
  const promoted = curatorProposals.filter(
    (proposal) => proposal.curatorStatus === "promoted",
  ).length;
  return html`
    <div class="agent-self-improvement-subsection">
      <h3>Memory/Skill Curator Queue</h3>
      <div class="agent-self-improvement-scorecard">
        <div>
          <strong>${pending}</strong>
          <span>Pending review</span>
        </div>
        <div>
          <strong>${acceptedUnlinked}</strong>
          <span>Need workshop link</span>
        </div>
        <div>
          <strong>${promoted}</strong>
          <span>Promoted</span>
        </div>
      </div>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${curatorProposals.slice(0, 8).map((proposal) => renderCuratorCard(proposal, onUpdate))}
      </div>
    </div>
  `;
}

function renderProposals(proposals: SelfImprovementProposal[]) {
  const visibleProposals = proposals.filter((proposal) => proposal.kind !== "memory_skill");
  if (visibleProposals.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-self-improvement-subsection">
      <h3>Proposal Queue</h3>
      <div class="agent-self-improvement-list agent-self-improvement-list--compact">
        ${visibleProposals.slice(0, 5).map((proposal) => renderProposalCard(proposal))}
      </div>
    </div>
  `;
}

export function renderSelfImprovementPanel(props: SelfImprovementPanelProps) {
  const groups = props.groups.length > 0 ? props.groups : [];
  return html`
    <section class="agent-self-improvement-panel">
      <div class="agent-panel-heading">
        <div>
          <div class="agent-panel-kicker">Self-Improvement Governor</div>
          <h2>Self-Improvement Recommendations</h2>
          <p>
            ${props.total} active recommendation${props.total === 1 ? "" : "s"} | last scan
            ${formatTime(props.lastScan?.scannedAt)}
          </p>
        </div>
        <div class="agent-panel-actions">
          <button class="btn btn--sm btn--ghost" type="button" @click=${props.onRefresh}>
            ${props.loading ? "Refreshing" : "Refresh"}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.scanLoading}
            @click=${props.onScan}
          >
            ${props.scanLoading ? "Scanning" : "Run scan"}
          </button>
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.analysisLoading}
            @click=${props.onAnalyze}
          >
            ${props.analysisLoading ? "Analyzing" : "Run analysis"}
          </button>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            ?disabled=${props.modelPreflightLoading}
            @click=${props.onModelPreflight}
          >
            ${props.modelPreflightLoading ? "Checking" : "Check models"}
          </button>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            ?disabled=${props.productionCheckLoading}
            @click=${props.onProductionCheck}
          >
            ${props.productionCheckLoading ? "Checking" : "Production check"}
          </button>
          <button
            class="btn btn--sm btn--ghost"
            type="button"
            ?disabled=${props.maintenanceLoading}
            @click=${props.onMaintenanceDryRun}
          >
            ${props.maintenanceLoading ? "Checking" : "Maintenance dry run"}
          </button>
        </div>
      </div>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${renderOperationalHealth(props.health)} ${renderScorecard(props.scorecard, props.total)}
      ${renderActionQueue(props.scorecard?.actionQueue)}
      ${renderImprovementIntelligence(props.scorecard)} ${renderScorecardHistory(props.scorecards)}
      ${renderLastAnalysis(props.lastAnalysis)} ${renderModelPreflight(props.lastModelPreflight)}
      ${renderProductionCheck(props.lastProductionCheck)}
      ${renderMaintenanceResult(props.lastMaintenance)}
      ${renderReviewerEvalHealth(props.auditEvents)}
      ${props.scorecard
        ? html`
            ${renderScorecardGroupList("Needs approval", props.scorecard.needsApproval)}
            ${renderScorecardGroupList("What worsened", props.scorecard.whatWorsened)}
            ${renderScorecardGroupList("What improved", props.scorecard.whatImproved)}
          `
        : nothing}
      ${renderCuratorQueue(props.proposals, props.onCuratorUpdate)}
      ${renderProposals(props.proposals)} ${renderAuditEvents(props.auditEvents)}
      ${props.loading && props.recommendations.length === 0 && groups.length === 0
        ? html`<div class="card agent-panel-loading">Loading recommendations</div>`
        : props.recommendations.length === 0 && groups.length === 0
          ? html`
              <div class="agent-self-improvement-empty">
                <strong>No active recommendations</strong>
                <span
                  >The governor has no open or acknowledged items in the recommendation store.</span
                >
              </div>
            `
          : html`
              <div class="agent-self-improvement-list">
                ${groups.length > 0
                  ? groups.map((group) => renderGroupCard(group, props.onGroupUpdate))
                  : props.recommendations.map((recommendation) =>
                      renderRecommendationCard(recommendation, props.onRecommendationUpdate),
                    )}
              </div>
            `}
    </section>
  `;
}
