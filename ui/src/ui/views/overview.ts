import { html } from "lit";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { t, i18n, SUPPORTED_LOCALES, type Locale } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { GatewayHelloOk } from "../gateway.ts";
import { formatNextRun } from "../presenter.ts";
import type { UiSettings } from "../storage.ts";
import type { GrowthFoundationSummary } from "../types.ts";
import { shouldShowPairingHint } from "./overview-hints.ts";

type GrowthReviewAction = "complete" | "reopen";

export type OverviewProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  settings: UiSettings;
  password: string;
  lastError: string | null;
  lastErrorCode: string | null;
  presenceCount: number;
  sessionsCount: number | null;
  cronEnabled: boolean | null;
  cronNext: number | null;
  lastChannelsRefresh: number | null;
  growthFoundation: GrowthFoundationSummary | null;
  growthFoundationActionBusyKey: string | null;
  growthFoundationActionError: string | null;
  onSettingsChange: (next: UiSettings) => void;
  onPasswordChange: (next: string) => void;
  onSessionKeyChange: (next: string) => void;
  onConnect: () => void;
  onRefresh: () => void;
  onGrowthReviewAction: (action: GrowthReviewAction, itemKey: string) => void;
};

function growthBadgeClass(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "clear" || normalized === "ok") {
    return "ok";
  }
  if (
    normalized === "critical" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "rejected"
  ) {
    return "danger";
  }
  return "warn";
}

function toRelativeTimeLabel(value: string | null): string {
  if (!value) {
    return t("common.na");
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatRelativeTimestamp(ms) : t("common.na");
}

function normalizeGrowthItem(text: string): string {
  return text
    .replace(/^\[(?: |x)\]\s*/i, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function buildGrowthFileHref(relPath: string): string {
  return `./__openclaw/growth-foundation/file?path=${encodeURIComponent(relPath)}`;
}

function renderGrowthList(items: string[], emptyLabel: string) {
  if (items.length === 0) {
    return html`<div class="muted">${emptyLabel}</div>`;
  }
  return html`<ul style="margin: 10px 0 0 18px; padding: 0;">
    ${items.map((item) => html`<li>${normalizeGrowthItem(item)}</li>`)}
  </ul>`;
}

function renderGrowthReviewItems(
  items: Array<{ key: string; display: string }>,
  params: {
    emptyLabel: string;
    action: GrowthReviewAction;
    busyKey: string | null;
    busyLabel: string;
    idleLabel: string;
    onSubmit: (action: GrowthReviewAction, itemKey: string) => void;
  },
) {
  if (items.length === 0) {
    return html`<div class="muted">${params.emptyLabel}</div>`;
  }
  const isBusy = params.busyKey !== null;
  return html`<div style="display:grid; gap:10px; margin-top:10px;">
    ${items.map(
      (item) => html`
        <div
          style="display:flex; gap:10px; justify-content:space-between; align-items:flex-start; border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;"
        >
          <div style="flex:1; min-width:0;">${item.display}</div>
          <button
            class="btn btn--sm"
            ?disabled=${isBusy}
            @click=${() => params.onSubmit(params.action, item.key)}
          >
            ${params.busyKey === item.key ? params.busyLabel : params.idleLabel}
          </button>
        </div>
      `,
    )}
  </div>`;
}

function renderGrowthCompletionHistory(
  items: Array<{
    timestamp: string;
    action: string;
    source: string;
    text: string;
    weeklyPath: string | null;
  }>,
  emptyLabel: string,
) {
  if (items.length === 0) {
    return html`<div class="muted">${emptyLabel}</div>`;
  }
  return html`<div style="display:grid; gap:10px; margin-top:10px;">
    ${items.map(
      (item) => html`
        <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
          <div>${item.text}</div>
          <div class="muted" style="margin-top:6px;">
            ${item.action} · ${toRelativeTimeLabel(item.timestamp)}${item.source ? ` · ${item.source}` : ""}
          </div>
          ${
            item.weeklyPath
              ? html`<div style="margin-top:8px;">
                  <a
                    class="session-link"
                    href=${buildGrowthFileHref(item.weeklyPath)}
                    target="_blank"
                    rel="noopener noreferrer"
                    >Open weekly review</a
                  >
                </div>`
              : null
          }
        </div>
      `,
    )}
  </div>`;
}

function renderGrowthCodexSmoke(growth: GrowthFoundationSummary, labels: { none: string }) {
  const status = growth.codexSmokeStatus || labels.none;
  const period = growth.codexSmokePeriod || labels.none;
  const jobId = growth.codexSmokeJobId || labels.none;
  const updatedAt = growth.codexSmokeUpdatedAt
    ? toRelativeTimeLabel(growth.codexSmokeUpdatedAt)
    : labels.none;
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${status}</div>
      <div class="muted" style="margin-top:6px;">period: ${period} · job: ${jobId}</div>
      <div class="muted" style="margin-top:6px;">updated: ${updatedAt}</div>
      ${
        growth.codexSmokeStatePath
          ? html`<div class="muted" style="margin-top:8px;">${growth.codexSmokeStatePath}</div>`
          : null
      }
    </div>
  `;
}

function renderGrowthCodexReviewSmoke(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  const status = growth.codexReviewSmokeStatus || labels.none;
  const period = growth.codexReviewSmokePeriod || labels.none;
  const jobId = growth.codexReviewSmokeJobId || labels.none;
  const sourceJobId = growth.codexReviewSmokeSourceJobId || labels.none;
  const updatedAt = growth.codexReviewSmokeUpdatedAt
    ? toRelativeTimeLabel(growth.codexReviewSmokeUpdatedAt)
    : labels.none;
  const backfillItems = growth.codexReviewSmokeBackfillItems ?? [];
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${status}</div>
      <div class="muted" style="margin-top:6px;">period: ${period} · job: ${jobId}</div>
      <div class="muted" style="margin-top:6px;">source: ${sourceJobId}</div>
      <div class="muted" style="margin-top:6px;">updated: ${updatedAt}</div>
      <div class="muted" style="margin-top:6px;">backfills: ${growth.codexReviewSmokeBackfillCount}</div>
      ${
        growth.codexReviewSmokeDiffPath
          ? html`<div style="margin-top:8px;">
              <a
                class="session-link"
                href=${buildGrowthFileHref(growth.codexReviewSmokeDiffPath)}
                target="_blank"
                rel="noopener noreferrer"
                >${labels.openLabel}</a
              >
            </div>`
          : null
      }
      ${
        backfillItems.length > 0
          ? html`<div style="display:grid; gap:8px; margin-top:10px;">
              ${backfillItems.map(
                (item) => html`
                  <div style="border:1px solid var(--border-color); border-radius:10px; padding:8px 10px;">
                    <div>${item.period}</div>
                    <div class="muted" style="margin-top:4px;">job: ${item.jobId ?? labels.none}</div>
                    ${
                      item.sourceJobId
                        ? html`<div class="muted" style="margin-top:4px;">source: ${item.sourceJobId}</div>`
                        : null
                    }
                    ${
                      item.sourceOrigin
                        ? html`<div class="muted" style="margin-top:4px;">origin: ${item.sourceOrigin}</div>`
                        : null
                    }
                    <div class="muted" style="margin-top:4px;">
                      ${item.requestedAt ? toRelativeTimeLabel(item.requestedAt) : labels.none}
                    </div>
                    <div class="muted" style="margin-top:4px;">${item.reason ?? labels.none}</div>
                    ${
                      item.diffRelpath
                        ? html`<div style="margin-top:8px;">
                            <a
                              class="session-link"
                              href=${buildGrowthFileHref(item.diffRelpath)}
                              target="_blank"
                              rel="noopener noreferrer"
                              >${labels.openLabel}</a
                            >
                          </div>`
                        : null
                    }
                  </div>
                `,
              )}
            </div>`
          : null
      }
      ${
        growth.codexReviewSmokeStatePath
          ? html`<div class="muted" style="margin-top:8px;">${growth.codexReviewSmokeStatePath}</div>`
          : null
      }
      ${
        growth.codexReviewSmokeBackfillStatePath
          ? html`<div class="muted" style="margin-top:8px;">${growth.codexReviewSmokeBackfillStatePath}</div>`
          : null
      }
    </div>
  `;
}

function renderGrowthCodexSmokeBackfills(
  items: Array<{
    period: string;
    jobId: string | null;
    requestedAt: string | null;
    reason: string | null;
  }>,
  emptyLabel: string,
) {
  if (items.length === 0) {
    return html`<div class="muted">${emptyLabel}</div>`;
  }
  return html`<div style="display:grid; gap:10px; margin-top:10px;">
    ${items.map(
      (item) => html`
        <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
          <div>${item.period}</div>
          <div class="muted" style="margin-top:6px;">job: ${item.jobId ?? emptyLabel}</div>
          <div class="muted" style="margin-top:6px;">
            ${item.requestedAt ? toRelativeTimeLabel(item.requestedAt) : emptyLabel}
          </div>
          <div class="muted" style="margin-top:6px;">${item.reason ?? emptyLabel}</div>
        </div>
      `,
    )}
  </div>`;
}

function renderGrowthGithubSummary(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${growth.githubProjectTitle ?? labels.none}</div>
      <div class="muted" style="margin-top:6px;">
        sync: ${growth.githubSyncStatus} · project: ${growth.githubProjectStatus}
      </div>
      <div class="muted" style="margin-top:6px;">
        issues: ${growth.githubSyncIssueCount} · board items: ${growth.githubProjectItemCount}
      </div>
      <div class="muted" style="margin-top:6px;">
        updated: ${growth.githubSyncUpdatedAt ? toRelativeTimeLabel(growth.githubSyncUpdatedAt) : labels.none}
      </div>
      ${
        growth.githubProjectUrl
          ? html`<div style="margin-top:8px;">
              <a
                class="session-link"
                href=${growth.githubProjectUrl}
                target="_blank"
                rel="noopener noreferrer"
                >${labels.openLabel}</a
              >
            </div>`
          : null
      }
      ${growth.githubSyncCurrentPath ? html`<div class="muted" style="margin-top:8px;">${growth.githubSyncCurrentPath}</div>` : null}
    </div>
  `;
}

function renderGrowthWritebackSummary(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  const actions =
    growth.githubWritebackActions.length > 0
      ? growth.githubWritebackActions.join(", ")
      : labels.none;
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${growth.githubWritebackStatus || labels.none}</div>
      <div class="muted" style="margin-top:6px;">
        issue: ${growth.githubWritebackIssueRef ?? labels.none}
      </div>
      <div class="muted" style="margin-top:6px;">
        actions: ${actions} · close: ${String(growth.githubWritebackCloseIssue)}
      </div>
      <div class="muted" style="margin-top:6px;">
        proposal: ${growth.githubWritebackProposalUpdatedAt ? toRelativeTimeLabel(growth.githubWritebackProposalUpdatedAt) : labels.none}
      </div>
      <div class="muted" style="margin-top:6px;">
        receipt: ${growth.githubWritebackReceiptAppliedAt ? toRelativeTimeLabel(growth.githubWritebackReceiptAppliedAt) : labels.none} · operator: ${growth.githubWritebackOperator ?? labels.none}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
        ${
          growth.githubWritebackProposalPath
            ? html`<a
                class="session-link"
                href=${buildGrowthFileHref(growth.githubWritebackProposalPath)}
                target="_blank"
                rel="noopener noreferrer"
                >${labels.openLabel}</a
              >`
            : null
        }
        ${
          growth.githubWritebackReceiptPath
            ? html`<a
                class="session-link"
                href=${buildGrowthFileHref(growth.githubWritebackReceiptPath)}
                target="_blank"
                rel="noopener noreferrer"
                >Receipt</a
              >`
            : null
        }
      </div>
      ${
        growth.githubWritebackProposalPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.githubWritebackProposalPath}</div>`
          : null
      }
      ${
        growth.githubWritebackReceiptPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.githubWritebackReceiptPath}</div>`
          : null
      }
    </div>
  `;
}

function renderGrowthIssueFlowSummary(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  const issueRef = growth.issueFlowIssueRef ?? labels.none;
  const stage = growth.issueFlowStage ?? labels.none;
  const visibilityStatus = growth.issueFlowVisibilityStatus ?? labels.none;
  const visibilityReason = growth.issueFlowVisibilityReason ?? labels.none;
  const visibilityOpenIssue =
    growth.issueFlowVisibilityOpenIssue === null ||
    growth.issueFlowVisibilityOpenIssue === undefined
      ? labels.none
      : String(growth.issueFlowVisibilityOpenIssue);
  const updatedAt = growth.issueFlowUpdatedAt
    ? toRelativeTimeLabel(growth.issueFlowUpdatedAt)
    : labels.none;
  const syncUpdatedAt = growth.issueFlowVisibilityGithubSyncUpdatedAt
    ? toRelativeTimeLabel(growth.issueFlowVisibilityGithubSyncUpdatedAt)
    : labels.none;
  const links = [
    ["preflight", growth.issueFlowPreflightPath ?? null],
    ["draft", growth.issueFlowDraftPath ?? null],
    ["proposal", growth.issueFlowProposalPath ?? null],
    ["receipt", growth.issueFlowReceiptPath ?? null],
    ["outcome", growth.issueFlowOutcomePath ?? null],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${growth.issueFlowStatus ?? labels.none}</div>
      <div class="muted" style="margin-top:6px;">stage: ${stage} · issue: ${issueRef}</div>
      <div class="muted" style="margin-top:6px;">
        visibility: ${visibilityStatus} · open in sync: ${visibilityOpenIssue}
      </div>
      <div class="muted" style="margin-top:6px;">
        ${visibilityReason}
      </div>
      <div class="muted" style="margin-top:6px;">
        preflight: ${growth.issueFlowPreflightStatus ?? labels.none} · draft: ${growth.issueFlowDraftStatus ?? labels.none}
      </div>
      <div class="muted" style="margin-top:6px;">
        proposal: ${growth.issueFlowProposalStatus ?? labels.none} · enqueue: ${growth.issueFlowEnqueueStatus ?? labels.none}
      </div>
      <div class="muted" style="margin-top:6px;">
        outcome: ${growth.issueFlowOutcomeStatus ?? labels.none} · updated: ${updatedAt} · github sync: ${syncUpdatedAt}
      </div>
      ${
        links.length > 0
          ? html`<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
              ${links.map(
                ([label, relPath]) => html`
                  <a
                    class="session-link"
                    href=${buildGrowthFileHref(relPath)}
                    target="_blank"
                    rel="noopener noreferrer"
                    >${label}</a
                  >
                `,
              )}
            </div>`
          : null
      }
      ${
        growth.issueFlowDirectoryPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.issueFlowDirectoryPath}</div>`
          : null
      }
      ${
        growth.issueFlowPrimaryResultPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.issueFlowPrimaryResultPath}</div>`
          : null
      }
    </div>
  `;
}

function renderGrowthIssueFlowRecentHistory(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  const items = growth.issueFlowRecentItems ?? [];
  if (items.length === 0) {
    return html`
      <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
        <div>${labels.none}</div>
        <div class="muted" style="margin-top:6px;">No prior issue-flow runs are available yet.</div>
      </div>
    `;
  }
  return html`${items.map((item) => {
    const links = [
      ["preflight", item.preflightPath ?? null],
      ["draft", item.draftPath ?? null],
      ["proposal", item.proposalPath ?? null],
      ["receipt", item.receiptPath ?? null],
      ["outcome", item.outcomePath ?? null],
      ["result", item.primaryResultPath ?? null],
    ].filter((entry): entry is [string, string] => Boolean(entry[1]));
    return html`
      <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px; margin-top:8px;">
        <div>${item.status}</div>
        <div class="muted" style="margin-top:6px;">stage: ${item.stage ?? labels.none} · issue: ${item.issueRef ?? labels.none}</div>
        <div class="muted" style="margin-top:6px;">
          proposal: ${item.proposalStatus} · enqueue: ${item.enqueueStatus} · outcome: ${item.outcomeStatus}
        </div>
        <div class="muted" style="margin-top:6px;">
          updated: ${item.updatedAt ? toRelativeTimeLabel(item.updatedAt) : labels.none}
        </div>
        ${
          links.length > 0
            ? html`<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                ${links.map(
                  ([label, relPath]) => html`
                    <a
                      class="session-link"
                      href=${buildGrowthFileHref(relPath)}
                      target="_blank"
                      rel="noopener noreferrer"
                      >${label}</a
                    >
                  `,
                )}
              </div>`
            : null
        }
        <div class="muted" style="margin-top:8px;">${item.directoryPath}</div>
      </div>
    `;
  })}`;
}

function renderGrowthIssueFlowArchiveSummary(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  const activeCount = growth.issueFlowActiveCount ?? 0;
  const archivedCount = growth.issueFlowArchivedCount ?? 0;
  const latestIssueRef = growth.issueFlowArchivedLatestIssueRef ?? labels.none;
  const archivedAt = growth.issueFlowArchivedLatestArchivedAt
    ? toRelativeTimeLabel(growth.issueFlowArchivedLatestArchivedAt)
    : labels.none;
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>archived: ${archivedCount}</div>
      <div class="muted" style="margin-top:6px;">active: ${activeCount}</div>
      <div class="muted" style="margin-top:6px;">latest archived issue: ${latestIssueRef}</div>
      <div class="muted" style="margin-top:6px;">archived: ${archivedAt}</div>
      ${
        growth.issueFlowArchivedLatestReceiptPath
          ? html`<div style="margin-top:8px;">
              <a
                class="session-link"
                href=${buildGrowthFileHref(growth.issueFlowArchivedLatestReceiptPath)}
                target="_blank"
                rel="noopener noreferrer"
                >${labels.openLabel}</a
              >
            </div>`
          : null
      }
      ${
        growth.issueFlowArchiveRootPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.issueFlowArchiveRootPath}</div>`
          : null
      }
      ${
        growth.issueFlowArchivedLatestPath
          ? html`<div class="muted" style="margin-top:8px;">${growth.issueFlowArchivedLatestPath}</div>`
          : null
      }
    </div>
  `;
}

function renderGrowthRelaySummary(
  growth: GrowthFoundationSummary,
  labels: { none: string; openLabel: string },
) {
  return html`
    <div style="border:1px solid var(--border-color); border-radius:12px; padding:10px 12px;">
      <div>${growth.relayStatus || labels.none}</div>
      <div class="muted" style="margin-top:6px;">
        channel: ${growth.relayChannel ?? labels.none} · mode: ${growth.relayMode ?? labels.none}
      </div>
      <div class="muted" style="margin-top:6px;">candidates: ${growth.relayCandidateCount}</div>
      <div class="muted" style="margin-top:6px;">
        updated: ${growth.relayUpdatedAt ? toRelativeTimeLabel(growth.relayUpdatedAt) : labels.none}
      </div>
      ${
        growth.relayCurrentPath
          ? html`<div style="margin-top:8px;">
              <a
                class="session-link"
                href=${buildGrowthFileHref(growth.relayCurrentPath)}
                target="_blank"
                rel="noopener noreferrer"
                >${labels.openLabel}</a
              >
            </div>`
          : null
      }
      ${growth.relayCurrentPath ? html`<div class="muted" style="margin-top:8px;">${growth.relayCurrentPath}</div>` : null}
    </div>
  `;
}

function renderGrowthNotifications(
  items: Array<{
    id: string;
    severity: string;
    title: string;
    detail: string;
    path: string | null;
  }>,
  labels: { emptyLabel: string; openLabel: string },
) {
  if (items.length === 0) {
    return html`<div class="muted">${labels.emptyLabel}</div>`;
  }
  const tone = items.some((item) => item.severity === "danger") ? "danger" : "";
  return html`
    <div class="callout ${tone}" style="margin-top: 12px;">
      <div style="display:grid; gap:10px;">
        ${items.map(
          (item) => html`
            <div style="display:flex; gap:10px; justify-content:space-between; align-items:flex-start;">
              <div style="flex:1; min-width:0;">
                <div>${item.title}</div>
                <div class="muted" style="margin-top:4px;">${item.detail}</div>
              </div>
              ${
                item.path
                  ? html`<a
                      class="session-link"
                      href=${buildGrowthFileHref(item.path)}
                      target="_blank"
                      rel="noopener noreferrer"
                      >${labels.openLabel}</a
                    >`
                  : null
              }
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

export function renderOverview(props: OverviewProps) {
  const snapshot = props.hello?.snapshot as
    | {
        uptimeMs?: number;
        policy?: { tickIntervalMs?: number };
        authMode?: "none" | "token" | "password" | "trusted-proxy";
      }
    | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationHuman(snapshot.uptimeMs) : t("common.na");
  const tick = snapshot?.policy?.tickIntervalMs
    ? `${snapshot.policy.tickIntervalMs}ms`
    : t("common.na");
  const authMode = snapshot?.authMode;
  const isTrustedProxy = authMode === "trusted-proxy";
  const growth = props.growthFoundation;
  const growthOpenItems = growth?.thisWeekItems ?? [];
  const growthCompletedItems = growth?.completedThisWeekItems ?? [];
  const growthHistoryItems = growth?.completedHistoryItems ?? [];
  const growthNotifications = growth?.notificationItems ?? [];
  const growthCodexSmokeBackfills = growth?.codexSmokeBackfillItems ?? [];

  const pairingHint = (() => {
    if (!shouldShowPairingHint(props.connected, props.lastError, props.lastErrorCode)) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.pairing.hint")}
        <div style="margin-top: 6px">
          <span class="mono">openclaw devices list</span><br />
          <span class="mono">openclaw devices approve &lt;requestId&gt;</span>
        </div>
        <div style="margin-top: 6px; font-size: 12px;">
          ${t("overview.pairing.mobileHint")}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Device pairing docs (opens in new tab)"
            >Docs: Device pairing</a
          >
        </div>
      </div>
    `;
  })();

  const authHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    const authRequiredCodes = new Set<string>([
      ConnectErrorDetailCodes.AUTH_REQUIRED,
      ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
      ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED,
      ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED,
    ]);
    const authFailureCodes = new Set<string>([
      ...authRequiredCodes,
      ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
      ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
      ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
      ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
      ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
      ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING,
      ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING,
      ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED,
      ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH,
    ]);
    const authFailed = props.lastErrorCode
      ? authFailureCodes.has(props.lastErrorCode)
      : lower.includes("unauthorized") || lower.includes("connect failed");
    if (!authFailed) {
      return null;
    }
    const hasToken = Boolean(props.settings.token.trim());
    const hasPassword = Boolean(props.password.trim());
    const isAuthRequired = props.lastErrorCode
      ? authRequiredCodes.has(props.lastErrorCode)
      : !hasToken && !hasPassword;
    if (isAuthRequired) {
      return html`
        <div class="muted" style="margin-top: 8px">
          ${t("overview.auth.required")}
          <div style="margin-top: 6px">
            <span class="mono">openclaw dashboard --no-open</span> → tokenized URL<br />
            <span class="mono">openclaw doctor --generate-gateway-token</span> → set token
          </div>
          <div style="margin-top: 6px">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              title="Control UI auth docs (opens in new tab)"
              >Docs: Control UI auth</a
            >
          </div>
        </div>
      `;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.auth.failed", { command: "openclaw dashboard --no-open" })}
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/dashboard"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Control UI auth docs (opens in new tab)"
            >Docs: Control UI auth</a
          >
        </div>
      </div>
    `;
  })();

  const insecureContextHint = (() => {
    if (props.connected || !props.lastError) {
      return null;
    }
    const isSecureContext = typeof window !== "undefined" ? window.isSecureContext : true;
    if (isSecureContext) {
      return null;
    }
    const lower = props.lastError.toLowerCase();
    const insecureContextCode =
      props.lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
      props.lastErrorCode === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED;
    if (
      !insecureContextCode &&
      !lower.includes("secure context") &&
      !lower.includes("device identity required")
    ) {
      return null;
    }
    return html`
      <div class="muted" style="margin-top: 8px">
        ${t("overview.insecure.hint", { url: "http://127.0.0.1:18789" })}
        <div style="margin-top: 6px">
          ${t("overview.insecure.stayHttp", { config: "gateway.controlUi.allowInsecureAuth: true" })}
        </div>
        <div style="margin-top: 6px">
          <a
            class="session-link"
            href="https://docs.openclaw.ai/gateway/tailscale"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Tailscale Serve docs (opens in new tab)"
            >Docs: Tailscale Serve</a
          >
          <span class="muted"> · </span>
          <a
            class="session-link"
            href="https://docs.openclaw.ai/web/control-ui#insecure-http"
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            title="Insecure HTTP docs (opens in new tab)"
            >Docs: Insecure HTTP</a
          >
        </div>
      </div>
    `;
  })();

  const currentLocale = i18n.getLocale();

  return html`
    <section class="grid grid-cols-2">
      <div class="card">
        <div class="card-title">${t("overview.access.title")}</div>
        <div class="card-sub">${t("overview.access.subtitle")}</div>
        <div class="form-grid" style="margin-top: 16px;">
          <label class="field">
            <span>${t("overview.access.wsUrl")}</span>
            <input
              .value=${props.settings.gatewayUrl}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSettingsChange({
                  ...props.settings,
                  gatewayUrl: v,
                  token: v.trim() === props.settings.gatewayUrl.trim() ? props.settings.token : "",
                });
              }}
              placeholder="ws://100.x.y.z:18789"
            />
          </label>
          ${
            isTrustedProxy
              ? ""
              : html`
                <label class="field">
                  <span>${t("overview.access.token")}</span>
                  <input
                    .value=${props.settings.token}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      props.onSettingsChange({ ...props.settings, token: v });
                    }}
                    placeholder="OPENCLAW_GATEWAY_TOKEN"
                  />
                </label>
                <label class="field">
                  <span>${t("overview.access.password")}</span>
                  <input
                    type="password"
                    .value=${props.password}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      props.onPasswordChange(v);
                    }}
                    placeholder="system or shared password"
                  />
                </label>
              `
          }
          <label class="field">
            <span>${t("overview.access.sessionKey")}</span>
            <input
              .value=${props.settings.sessionKey}
              @input=${(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                props.onSessionKeyChange(v);
              }}
            />
          </label>
          <label class="field">
            <span>${t("overview.access.language")}</span>
            <select
              .value=${currentLocale}
              @change=${(e: Event) => {
                const v = (e.target as HTMLSelectElement).value as Locale;
                void i18n.setLocale(v);
                props.onSettingsChange({ ...props.settings, locale: v });
              }}
            >
              ${SUPPORTED_LOCALES.map((loc) => {
                const key = loc.replace(/-([a-zA-Z])/g, (_, c) => c.toUpperCase());
                return html`<option value=${loc}>${t(`languages.${key}`)}</option>`;
              })}
            </select>
          </label>
        </div>
        <div class="row" style="margin-top: 14px;">
          <button class="btn" @click=${() => props.onConnect()}>${t("common.connect")}</button>
          <button class="btn" @click=${() => props.onRefresh()}>${t("common.refresh")}</button>
          <span class="muted">${
            isTrustedProxy ? t("overview.access.trustedProxy") : t("overview.access.connectHint")
          }</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${t("overview.snapshot.title")}</div>
        <div class="card-sub">${t("overview.snapshot.subtitle")}</div>
        <div class="stat-grid" style="margin-top: 16px;">
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.status")}</div>
            <div class="stat-value ${props.connected ? "ok" : "warn"}">
              ${props.connected ? t("common.ok") : t("common.offline")}
            </div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.uptime")}</div>
            <div class="stat-value">${uptime}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.tickInterval")}</div>
            <div class="stat-value">${tick}</div>
          </div>
          <div class="stat">
            <div class="stat-label">${t("overview.snapshot.lastChannelsRefresh")}</div>
            <div class="stat-value">
              ${props.lastChannelsRefresh ? formatRelativeTimestamp(props.lastChannelsRefresh) : t("common.na")}
            </div>
          </div>
        </div>
        ${
          props.lastError
            ? html`<div class="callout danger" style="margin-top: 14px;">
              <div>${props.lastError}</div>
              ${pairingHint ?? ""}
              ${authHint ?? ""}
              ${insecureContextHint ?? ""}
            </div>`
            : html`
                <div class="callout" style="margin-top: 14px">
                  ${t("overview.snapshot.channelsHint")}
                </div>
              `
        }
      </div>
    </section>

    <section class="grid grid-cols-3" style="margin-top: 18px;">
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.instances")}</div>
        <div class="stat-value">${props.presenceCount}</div>
        <div class="muted">${t("overview.stats.instancesHint")}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.sessions")}</div>
        <div class="stat-value">${props.sessionsCount ?? t("common.na")}</div>
        <div class="muted">${t("overview.stats.sessionsHint")}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">${t("overview.stats.cron")}</div>
        <div class="stat-value">
          ${props.cronEnabled == null ? t("common.na") : props.cronEnabled ? t("common.enabled") : t("common.disabled")}
        </div>
        <div class="muted">${t("overview.stats.cronNext", { time: formatNextRun(props.cronNext) })}</div>
      </div>
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("overview.growth.title")}</div>
      <div class="card-sub">${t("overview.growth.subtitle")}</div>
      ${
        !growth || !growth.available
          ? html`<div class="callout" style="margin-top: 14px;">
              ${t("overview.growth.unavailable")}
            </div>`
          : html`
              <div class="row" style="margin-top: 14px; gap: 8px; flex-wrap: wrap;">
                <span class="pill ${growthBadgeClass(growth.alertStatus)}"
                  >${t("overview.growth.alert")}: ${growth.alertStatus}</span
                >
                <span class="pill ${growthBadgeClass(growth.actionsStatus)}"
                  >${t("overview.growth.actions")}: ${growth.actionsStatus}</span
                >
                <span class="pill ${growthBadgeClass(growth.notificationStatus)}"
                  >${t("overview.growth.notifications")}: ${growth.notificationCount}</span
                >
                <span class="pill">${t("overview.growth.reviews")}: ${growth.reviewCount}</span>
                <span class="pill"
                  >${t("overview.growth.completed")}: ${growth.completedReviewCount}</span
                >
                <span class="pill ${growthBadgeClass(growth.codexSmokeStatus)}"
                  >${t("overview.growth.codexSmoke")}: ${growth.codexSmokeStatus}</span
                >
                <span class="pill ${growthBadgeClass(growth.codexReviewSmokeStatus)}"
                  >${t("overview.growth.codexReviewSmoke")}: ${growth.codexReviewSmokeStatus}</span
                >
                <span class="pill"
                  >${t("overview.growth.backfills")}: ${growth.codexSmokeBackfillCount}</span
                >
                <span class="pill ${growthBadgeClass(growth.githubSyncStatus)}">GitHub: ${growth.githubSyncStatus}</span>
                <span class="pill ${growthBadgeClass(growth.issueFlowStatus ?? "missing")}">Issue Flow: ${growth.issueFlowStatus ?? t("overview.growth.none")}</span>
                <span class="pill">Active Flow Runs: ${growth.issueFlowActiveCount ?? 0}</span>
                <span class="pill">Recent Flow Runs: ${growth.issueFlowRecentCount ?? 0}</span>
                <span class="pill">Archived Flow Runs: ${growth.issueFlowArchivedCount ?? 0}</span>
                <span class="pill ${growthBadgeClass(growth.issueFlowVisibilityStatus ?? "missing")}">Flow Visibility: ${growth.issueFlowVisibilityStatus ?? t("overview.growth.none")}</span>
                <span class="pill ${growthBadgeClass(growth.githubWritebackStatus)}">Write-Back: ${growth.githubWritebackStatus}</span>
                <span class="pill ${growthBadgeClass(growth.relayStatus)}">Relay: ${growth.relayStatus}</span>
              </div>
              ${
                props.growthFoundationActionError
                  ? html`<div class="callout danger" style="margin-top: 12px;">
                      ${t("overview.growth.updateFailed")}: ${props.growthFoundationActionError}
                    </div>`
                  : null
              }
              ${renderGrowthNotifications(growthNotifications, {
                emptyLabel: t("overview.growth.none"),
                openLabel: t("overview.growth.openSource"),
              })}
              <div class="stat-grid" style="margin-top: 16px;">
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.project")}</div>
                  <div class="stat-value">${growth.projectId ?? t("common.na")}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.alertUpdated")}</div>
                  <div class="stat-value">${toRelativeTimeLabel(growth.alertUpdatedAt)}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.actionsUpdated")}</div>
                  <div class="stat-value">${toRelativeTimeLabel(growth.actionsUpdatedAt)}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.weeklyReview")}</div>
                  <div class="stat-value">
                    ${
                      growth.weeklyReviewPath
                        ? html`<a
                            class="session-link"
                            href=${buildGrowthFileHref(growth.weeklyReviewPath)}
                            target="_blank"
                            rel="noopener noreferrer"
                            >Open</a
                          >`
                        : t("common.na")
                    }
                  </div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.codexSmokePeriod")}</div>
                  <div class="stat-value">${growth.codexSmokePeriod ?? t("common.na")}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">${t("overview.growth.codexReviewSmokePeriod")}</div>
                  <div class="stat-value">${growth.codexReviewSmokePeriod ?? t("common.na")}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">GitHub issues</div>
                  <div class="stat-value">${growth.githubSyncIssueCount}</div>
                </div>
                <div class="stat">
                  <div class="stat-label">Relay candidates</div>
                  <div class="stat-value">${growth.relayCandidateCount}</div>
                </div>
              </div>
              <div class="note-grid" style="margin-top: 14px;">
                <div>
                  <div class="note-title">${t("overview.growth.priorityNow")}</div>
                  ${renderGrowthList(growth.priorityNow, t("overview.growth.none"))}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.thisWeek")}</div>
                  ${renderGrowthReviewItems(growthOpenItems, {
                    emptyLabel: t("overview.growth.none"),
                    action: "complete",
                    busyKey: props.growthFoundationActionBusyKey,
                    busyLabel: t("overview.growth.updating"),
                    idleLabel: t("overview.growth.complete"),
                    onSubmit: props.onGrowthReviewAction,
                  })}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.completed")}</div>
                  ${renderGrowthReviewItems(growthCompletedItems, {
                    emptyLabel: t("overview.growth.none"),
                    action: "reopen",
                    busyKey: props.growthFoundationActionBusyKey,
                    busyLabel: t("overview.growth.updating"),
                    idleLabel: t("overview.growth.reopen"),
                    onSubmit: props.onGrowthReviewAction,
                  })}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.history")}</div>
                  ${renderGrowthCompletionHistory(growthHistoryItems, t("overview.growth.none"))}
                  ${
                    growth.completedHistoryPath
                      ? html`<div class="muted" style="margin-top:8px;">${growth.completedHistoryPath}</div>`
                      : null
                  }
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.codexSmoke")}</div>
                  ${renderGrowthCodexSmoke(growth, { none: t("overview.growth.none") })}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.codexReviewSmoke")}</div>
                  ${renderGrowthCodexReviewSmoke(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.backfillHistory")}</div>
                  ${renderGrowthCodexSmokeBackfills(
                    growthCodexSmokeBackfills,
                    t("overview.growth.none"),
                  )}
                  ${
                    growth.codexSmokeBackfillStatePath
                      ? html`<div class="muted" style="margin-top:8px;">${growth.codexSmokeBackfillStatePath}</div>`
                      : null
                  }
                </div>
                <div>
                  <div class="note-title">GitHub Sync</div>
                  ${renderGrowthGithubSummary(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">GitHub Write-Back</div>
                  ${renderGrowthWritebackSummary(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">Live Issue Flow</div>
                  ${renderGrowthIssueFlowSummary(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">Recent Issue Flow Runs</div>
                  ${renderGrowthIssueFlowRecentHistory(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">Issue Flow Archive</div>
                  ${renderGrowthIssueFlowArchiveSummary(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">Relay</div>
                  ${renderGrowthRelaySummary(growth, {
                    none: t("overview.growth.none"),
                    openLabel: t("overview.growth.openSource"),
                  })}
                </div>
                <div>
                  <div class="note-title">${t("overview.growth.watch")}</div>
                  ${renderGrowthList(growth.watch, t("overview.growth.none"))}
                </div>
              </div>
            `
      }
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="card-title">${t("overview.notes.title")}</div>
      <div class="card-sub">${t("overview.notes.subtitle")}</div>
      <div class="note-grid" style="margin-top: 14px;">
        <div>
          <div class="note-title">${t("overview.notes.tailscaleTitle")}</div>
          <div class="muted">
            ${t("overview.notes.tailscaleText")}
          </div>
        </div>
        <div>
          <div class="note-title">${t("overview.notes.sessionTitle")}</div>
          <div class="muted">${t("overview.notes.sessionText")}</div>
        </div>
        <div>
          <div class="note-title">${t("overview.notes.cronTitle")}</div>
          <div class="muted">${t("overview.notes.cronText")}</div>
        </div>
      </div>
    </section>
  `;
}
