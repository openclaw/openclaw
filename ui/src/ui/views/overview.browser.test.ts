/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderOverview, type OverviewProps } from "./overview.ts";

function createProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    connected: true,
    hello: null,
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "system",
      locale: "en",
      chatFocusMode: false,
      chatShowThinking: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    password: "",
    lastError: null,
    lastErrorCode: null,
    presenceCount: 1,
    sessionsCount: 2,
    cronEnabled: true,
    cronNext: null,
    lastChannelsRefresh: null,
    growthFoundation: null,
    growthFoundationActionBusyKey: null,
    growthFoundationActionError: null,
    onSettingsChange: () => undefined,
    onPasswordChange: () => undefined,
    onSessionKeyChange: () => undefined,
    onConnect: () => undefined,
    onRefresh: () => undefined,
    onGrowthReviewAction: () => undefined,
    ...overrides,
  };
}

describe("renderOverview growth foundation panel", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the growth foundation summary when available", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T17:40:00+09:00"));
    const container = document.createElement("div");
    render(
      renderOverview(
        createProps({
          growthFoundation: {
            available: true,
            projectId: "2026-03-06_growth-foundation",
            alertStatus: "clear",
            alertTransition: "steady-clear",
            alertUpdatedAt: "2026-03-06T13:54:36+09:00",
            actionsStatus: "actionable",
            actionsUpdatedAt: "2026-03-06T13:54:16+09:00",
            priorityNow: [],
            thisWeek: ["Run human review for queue output"],
            thisWeekItems: [
              {
                key: "job-open",
                text: "Run human review for queue output",
                display: "Run human review for queue output",
                completedAt: null,
                source: null,
              },
            ],
            completedThisWeekItems: [
              {
                key: "job-done",
                text: "Finished review for queue output",
                display: "Finished review for queue output",
                completedAt: "2026-03-06T14:00:00+09:00",
                source: "mission-control",
              },
            ],
            completedHistoryItems: [
              {
                timestamp: "2026-03-06T14:00:00+09:00",
                action: "complete",
                itemKey: "job-done",
                weekly: "2026-03-06-weekly-review.md",
                weeklyPath:
                  "memory/projects/2026-03-06_growth-foundation/weekly/2026-03-06-weekly-review.md",
                source: "mission-control",
                text: "Finished review for queue output",
              },
            ],
            notificationStatus: "attention",
            notificationCount: 2,
            notificationItems: [
              {
                id: "reviews-open",
                severity: "warning",
                title: "1 review item(s) pending",
                detail: "Run human review for queue output",
                path: "memory/projects/2026-03-06_growth-foundation/weekly/2026-03-06-weekly-review.md",
                source: "weekly",
              },
              {
                id: "watch-open",
                severity: "info",
                title: "1 watch item(s) open",
                detail: "Follow queue latency drift",
                path: "memory/projects/2026-03-06_growth-foundation/actions/current.md",
                source: "actions",
              },
            ],
            watch: ["Follow queue latency drift"],
            reviewCount: 1,
            completedReviewCount: 1,
            alertsPath: "memory/projects/2026-03-06_growth-foundation/alerts/current.md",
            actionsPath: "memory/projects/2026-03-06_growth-foundation/actions/current.md",
            completedHistoryPath:
              "memory/projects/2026-03-06_growth-foundation/actions/completed/2026-03-06.md",
            heartbeatPath: "memory/projects/2026-03-06_growth-foundation/heartbeat/2026-03-06.md",
            weeklyReviewPath:
              "memory/projects/2026-03-06_growth-foundation/weekly/2026-03-06-weekly-review.md",
            codexSmokeStatus: "scheduled",
            codexSmokePeriod: "2026-W10",
            codexSmokeJobId: "scheduled-codex-patch-20260306",
            codexSmokeUpdatedAt: "2026-03-06T15:10:00+09:00",
            codexSmokeStatePath:
              "memory/projects/2026-03-06_growth-foundation/automation/codex-patch-smoke-state.json",
            codexReviewSmokeStatus: "scheduled",
            codexReviewSmokePeriod: "2026-W10",
            codexReviewSmokeJobId: "scheduled-codex-review-20260306",
            codexReviewSmokeSourceJobId: "scheduled-codex-patch-20260306",
            codexReviewSmokeUpdatedAt: "2026-03-06T15:40:00+09:00",
            codexReviewSmokeStatePath:
              "memory/projects/2026-03-06_growth-foundation/automation/codex-patch-smoke-review-state.json",
            codexReviewSmokeDiffPath:
              "projects/2026-03-06_growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch",
            codexReviewSmokeBackfillCount: 1,
            codexReviewSmokeBackfillItems: [
              {
                period: "2026-W08",
                jobId: "manual-backfill-codex-review-2026w08",
                requestedAt: "2026-03-06T16:05:00+09:00",
                reason: "WSL downtime skipped the reviewer timer",
                sourceJobId: "manual-backfill-codex-patch-2026w08",
                sourceOrigin: "patch-backfill",
                diffRelpath:
                  "projects/2026-03-06_growth-foundation/evidence/2026-03-06_manual-backfill-codex-review-smoke/manual-backfill-codex-patch-2026w08.diff.patch",
                jobPath: "queue/jobs/queued/manual-backfill-codex-review-2026w08.json",
                evidencePath: null,
              },
            ],
            codexReviewSmokeBackfillStatePath:
              "memory/projects/2026-03-06_growth-foundation/automation/codex-patch-smoke-review-backfill-state.json",
            codexSmokeBackfillCount: 1,
            codexSmokeBackfillItems: [
              {
                period: "2026-W08",
                jobId: "manual-backfill-codex-patch-2026w08",
                requestedAt: "2026-03-06T15:30:00+09:00",
                reason: "WSL downtime skipped the weekly timer",
                jobPath: "queue/jobs/queued/manual-backfill-codex-patch-2026w08.json",
                evidencePath: null,
              },
            ],
            codexSmokeBackfillStatePath:
              "memory/projects/2026-03-06_growth-foundation/automation/codex-patch-smoke-backfill-state.json",
            githubSyncStatus: "synced",
            githubSyncIssueCount: 1,
            githubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
            githubSyncCurrentPath: "memory/projects/2026-03-06_growth-foundation/github/current.md",
            githubProjectStatus: "synced",
            githubProjectTitle: "Growth Foundation",
            githubProjectUrl: "https://github.com/users/yui-stingray/projects/1",
            githubProjectItemCount: 1,
            githubPrWatchStatus: "ready-for-merge",
            githubPrWatchPullCount: 1,
            githubPrWatchReadyCount: 1,
            githubPrWatchAttentionCount: 0,
            githubPrWatchUpdatedAt: "2026-03-06T17:30:00+09:00",
            githubPrWatchFreshnessStatus: "fresh",
            githubPrWatchAgeMinutes: 10,
            githubPrWatchItems: [
              {
                repo: "yui-stingray/ai-company",
                number: 4,
                issueRef: "yui-stingray/ai-company#4",
                title: "fix: queue output handling",
                url: "https://github.com/yui-stingray/ai-company/pull/4",
                watchStatus: "ready-for-merge",
                readyForMerge: true,
                reason: "All visible checks are complete; manual merge gate can proceed.",
                checkRunTotal: 4,
                checkRunPending: 0,
                checkRunFailing: 0,
                commitStatusState: "success",
              },
            ],
            githubPrWatchCurrentPath:
              "memory/projects/2026-03-06_growth-foundation/github-pr-watch/current.md",
            githubPrWatchStatePath:
              "memory/projects/2026-03-06_growth-foundation/github-pr-watch/state.json",
            githubWritebackStatus: "applied",
            githubWritebackIssueRef: "yui-stingray/growth-foundation#10",
            githubWritebackActions: ["comment"],
            githubWritebackCloseIssue: false,
            githubWritebackOperator: "yui",
            githubWritebackProposalUpdatedAt: "2026-03-06T17:15:00+09:00",
            githubWritebackReceiptAppliedAt: "2026-03-06T17:20:00+09:00",
            githubWritebackProposalPath:
              "memory/projects/2026-03-06_growth-foundation/github-writeback/current-proposal.json",
            githubWritebackReceiptPath:
              "memory/projects/2026-03-06_growth-foundation/github-writeback/receipts/2026-03-06-issue-10.json",
            issueFlowStatus: "needs-review",
            issueFlowStage: "outcome",
            issueFlowIssueNumber: 17,
            issueFlowIssueRef: "yui-stingray/growth-foundation#17",
            issueFlowUpdatedAt: "2026-03-07T21:47:50+09:00",
            issueFlowDirectoryPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17",
            issueFlowPreflightStatus: "synced",
            issueFlowDraftStatus: "approved-for-proposal",
            issueFlowProposalStatus: "ready-for-manual-enqueue",
            issueFlowEnqueueStatus: "enqueued",
            issueFlowOutcomeStatus: "needs-review",
            issueFlowPreflightPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17/preflight.json",
            issueFlowDraftPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17/orchestrator-draft.json",
            issueFlowProposalPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17/queue-proposal.json",
            issueFlowReceiptPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17/enqueue-receipt.json",
            issueFlowOutcomePath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-17/outcome-bundle.json",
            issueFlowPrimaryResultPath: "queue/results/issue-17-live-operator-run-v2.json",
            issueFlowActiveCount: 2,
            issueFlowRecentCount: 1,
            issueFlowRecentItems: [
              {
                issueNumber: 16,
                issueRef: "yui-stingray/growth-foundation#16",
                stage: "outcome",
                status: "delivered",
                updatedAt: "2026-03-07T20:47:50+09:00",
                directoryPath: "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-16",
                preflightStatus: "synced",
                draftStatus: "approved-for-proposal",
                proposalStatus: "missing",
                enqueueStatus: "missing",
                outcomeStatus: "delivered",
                preflightPath:
                  "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-16/preflight.json",
                draftPath:
                  "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-16/orchestrator-draft.json",
                proposalPath: null,
                receiptPath: null,
                outcomePath:
                  "memory/projects/2026-03-06_growth-foundation/issue-flow/issue-16/outcome-bundle.json",
                primaryResultPath: "queue/results/issue-16-live-operator-run-v1.json",
              },
            ],
            issueFlowArchivedCount: 1,
            issueFlowArchiveRootPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/archive",
            issueFlowArchivedLatestIssueRef: "yui-stingray/growth-foundation#15",
            issueFlowArchivedLatestArchivedAt: "2026-03-06T20:00:00+09:00",
            issueFlowArchivedLatestPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/archive/issue-15--20260306T000000Z",
            issueFlowArchivedLatestReceiptPath:
              "memory/projects/2026-03-06_growth-foundation/issue-flow/archive/issue-15--20260306T000000Z/archive-receipt.json",
            issueFlowVisibilityStatus: "state-drift",
            issueFlowVisibilityReason:
              "The latest issue-flow issue is absent from the current open-issue sync.",
            issueFlowVisibilityOpenIssue: false,
            issueFlowVisibilityGithubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
            relayStatus: "approval-required",
            relayChannel: "discord",
            relayMode: "approval-required",
            relayCandidateCount: 1,
            relayUpdatedAt: "2026-03-06T17:05:00+09:00",
            relayCurrentPath: "memory/projects/2026-03-06_growth-foundation/relay/current.md",
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Growth Foundation");
    expect(container.textContent).toContain("2026-03-06_growth-foundation");
    expect(container.textContent).toContain("Attention");
    expect(container.textContent).toContain("Run human review for queue output");
    expect(container.textContent).toContain("Follow queue latency drift");
    expect(container.textContent).toContain("Run human review for queue output");
    expect(container.textContent).toContain("Finished review for queue output");
    expect(container.textContent).toContain("Queue reviews");
    expect(container.textContent).toContain("Completed History");
    expect(container.textContent).toContain("Codex Smoke");
    expect(container.textContent).toContain("Review Smoke");
    expect(container.textContent).toContain("GitHub Sync");
    expect(container.textContent).toContain("GitHub PR Watch");
    expect(container.textContent).toContain("PR Watch: ready-for-merge");
    expect(container.textContent).toContain("Ready PRs: 1");
    expect(container.textContent).toContain("PR Attention: 0");
    expect(container.textContent).toContain("PR Freshness: fresh");
    expect(container.textContent).toContain("freshness: fresh");
    expect(container.textContent).toContain("10m");
    expect(container.textContent).toContain("Issue Flow");
    expect(container.textContent).toContain("Active Flow Runs");
    expect(container.textContent).toContain("Recent Issue Flow Runs");
    expect(container.textContent).toContain("Archived Flow Runs");
    expect(container.textContent).toContain("Issue Flow Archive");
    expect(container.textContent).toContain("Flow Visibility");
    expect(container.textContent).toContain("GitHub Write-Back");
    expect(container.textContent).toContain("applied");
    expect(container.textContent).toContain("yui-stingray/growth-foundation#10");
    expect(container.textContent).toContain("needs-review");
    expect(container.textContent).toContain("yui-stingray/growth-foundation#17");
    expect(container.textContent).toContain("delivered");
    expect(container.textContent).toContain("yui-stingray/growth-foundation#16");
    expect(container.textContent).toContain("yui-stingray/growth-foundation#15");
    expect(container.textContent).toContain("state-drift");
    expect(container.textContent).toContain("Growth Foundation");
    expect(container.textContent).toContain(
      "All visible checks are complete; manual merge gate can proceed.",
    );
    expect(container.textContent).toContain("Relay");
    expect(container.textContent).toContain("approval-required");
    expect(container.textContent).toContain("discord");
    expect(container.textContent).toContain("Backfill History");
    expect(container.textContent).toContain("2026-W10");
    expect(container.textContent).toContain("scheduled-codex-review-20260306");
    expect(container.textContent).toContain("manual-backfill-codex-review-2026w08");
    expect(container.textContent).toContain("manual-backfill-codex-patch-2026w08");
    expect(container.textContent).toContain("Complete");
    expect(container.textContent).toContain("Reopen");
    const links = Array.from(container.querySelectorAll("a")).map((node) =>
      node.getAttribute("href"),
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Fweekly%2F2026-03-06-weekly-review.md",
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Factions%2Fcurrent.md",
    );
    expect(links).toContain("https://github.com/users/yui-stingray/projects/1");
    expect(links).toContain("https://github.com/yui-stingray/ai-company/pull/4");
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Fgithub-writeback%2Fcurrent-proposal.json",
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Fgithub-writeback%2Freceipts%2F2026-03-06-issue-10.json",
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Fissue-flow%2Fissue-17%2Foutcome-bundle.json",
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Fissue-flow%2Farchive%2Fissue-15--20260306T000000Z%2Farchive-receipt.json",
    );
    expect(links).toContain(
      "./__openclaw/growth-foundation/file?path=memory%2Fprojects%2F2026-03-06_growth-foundation%2Frelay%2Fcurrent.md",
    );
  });

  it("renders an unavailable message when the summary is missing", () => {
    const container = document.createElement("div");
    render(renderOverview(createProps()), container);

    expect(container.textContent).toContain("Growth Foundation");
    expect(container.textContent).toContain("No growth foundation snapshot found");
  });

  it("disables all growth review actions while one update is in flight", () => {
    const container = document.createElement("div");
    render(
      renderOverview(
        createProps({
          growthFoundationActionBusyKey: "job-open",
          growthFoundation: {
            available: true,
            projectId: "2026-03-06_growth-foundation",
            alertStatus: "clear",
            alertTransition: "steady-clear",
            alertUpdatedAt: "2026-03-06T13:54:36+09:00",
            actionsStatus: "actionable",
            actionsUpdatedAt: "2026-03-06T13:54:16+09:00",
            priorityNow: [],
            thisWeek: ["Run human review for queue output"],
            thisWeekItems: [
              {
                key: "job-open",
                text: "Run human review for queue output",
                display: "Run human review for queue output",
                completedAt: null,
                source: null,
              },
            ],
            completedThisWeekItems: [
              {
                key: "job-done",
                text: "Finished review for queue output",
                display: "Finished review for queue output",
                completedAt: "2026-03-06T14:00:00+09:00",
                source: "mission-control",
              },
            ],
            completedHistoryItems: [],
            notificationStatus: "clear",
            notificationCount: 0,
            notificationItems: [],
            watch: [],
            reviewCount: 1,
            completedReviewCount: 1,
            alertsPath: null,
            actionsPath: null,
            completedHistoryPath: null,
            heartbeatPath: null,
            weeklyReviewPath: null,
            codexSmokeStatus: "missing",
            codexSmokePeriod: null,
            codexSmokeJobId: null,
            codexSmokeUpdatedAt: null,
            codexSmokeStatePath: null,
            codexReviewSmokeStatus: "missing",
            codexReviewSmokePeriod: null,
            codexReviewSmokeJobId: null,
            codexReviewSmokeSourceJobId: null,
            codexReviewSmokeUpdatedAt: null,
            codexReviewSmokeStatePath: null,
            codexReviewSmokeDiffPath: null,
            codexReviewSmokeBackfillCount: 0,
            codexReviewSmokeBackfillItems: [],
            codexReviewSmokeBackfillStatePath: null,
            codexSmokeBackfillCount: 0,
            codexSmokeBackfillItems: [],
            codexSmokeBackfillStatePath: null,
            githubSyncStatus: "missing",
            githubSyncIssueCount: 0,
            githubSyncUpdatedAt: null,
            githubSyncCurrentPath: null,
            githubProjectStatus: "missing",
            githubProjectTitle: null,
            githubProjectUrl: null,
            githubProjectItemCount: 0,
            githubWritebackStatus: "missing",
            githubWritebackIssueRef: null,
            githubWritebackActions: [],
            githubWritebackCloseIssue: false,
            githubWritebackOperator: null,
            githubWritebackProposalUpdatedAt: null,
            githubWritebackReceiptAppliedAt: null,
            githubWritebackProposalPath: null,
            githubWritebackReceiptPath: null,
            issueFlowStatus: "missing",
            issueFlowStage: null,
            issueFlowIssueNumber: null,
            issueFlowIssueRef: null,
            issueFlowUpdatedAt: null,
            issueFlowDirectoryPath: null,
            issueFlowPreflightStatus: "missing",
            issueFlowDraftStatus: "missing",
            issueFlowProposalStatus: "missing",
            issueFlowEnqueueStatus: "missing",
            issueFlowOutcomeStatus: "missing",
            issueFlowPreflightPath: null,
            issueFlowDraftPath: null,
            issueFlowProposalPath: null,
            issueFlowReceiptPath: null,
            issueFlowOutcomePath: null,
            issueFlowPrimaryResultPath: null,
            issueFlowActiveCount: 0,
            issueFlowRecentCount: 0,
            issueFlowRecentItems: [],
            issueFlowArchivedCount: 0,
            issueFlowArchiveRootPath: null,
            issueFlowArchivedLatestIssueRef: null,
            issueFlowArchivedLatestArchivedAt: null,
            issueFlowArchivedLatestPath: null,
            issueFlowArchivedLatestReceiptPath: null,
            issueFlowVisibilityStatus: "missing",
            issueFlowVisibilityReason: null,
            issueFlowVisibilityOpenIssue: null,
            issueFlowVisibilityGithubSyncUpdatedAt: null,
            relayStatus: "missing",
            relayChannel: null,
            relayMode: null,
            relayCandidateCount: 0,
            relayUpdatedAt: null,
            relayCurrentPath: null,
          },
        }),
      ),
      container,
    );

    const buttons = Array.from(container.querySelectorAll("button.btn--sm"));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((node) => node.disabled)).toBe(true);
    expect(buttons[0]?.textContent).toContain("Updating");
    expect(buttons[1]?.textContent).toContain("Reopen");
  });

  it("shows pr watch remediation guidance when freshness is lagging", () => {
    const container = document.createElement("div");
    render(
      renderOverview(
        createProps({
          growthFoundation: {
            available: true,
            projectId: "2026-03-06_growth-foundation",
            alertStatus: "clear",
            alertTransition: "steady-clear",
            alertUpdatedAt: null,
            actionsStatus: "actionable",
            actionsUpdatedAt: null,
            priorityNow: [],
            thisWeek: [],
            thisWeekItems: [],
            completedThisWeekItems: [],
            completedHistoryItems: [],
            notificationStatus: "attention",
            notificationCount: 1,
            notificationItems: [
              {
                id: "github-pr-watch-stale",
                severity: "danger",
                title: "PR watch refresh is lagging",
                detail:
                  "Latest PR watch snapshot is 1h 40m old; refresh may be stalled. Run openclaw-sync-github-pr-watch or inspect openclaw-growth-github-pr-watch.timer.",
                path: "memory/projects/2026-03-06_growth-foundation/github-pr-watch/current.md",
                source: "github-pr-watch",
              },
            ],
            watch: [],
            reviewCount: 0,
            completedReviewCount: 0,
            alertsPath: null,
            actionsPath: null,
            completedHistoryPath: null,
            heartbeatPath: null,
            weeklyReviewPath: null,
            codexSmokeStatus: "missing",
            codexSmokePeriod: null,
            codexSmokeJobId: null,
            codexSmokeUpdatedAt: null,
            codexSmokeStatePath: null,
            codexReviewSmokeStatus: "missing",
            codexReviewSmokePeriod: null,
            codexReviewSmokeJobId: null,
            codexReviewSmokeSourceJobId: null,
            codexReviewSmokeUpdatedAt: null,
            codexReviewSmokeStatePath: null,
            codexReviewSmokeDiffPath: null,
            codexReviewSmokeBackfillCount: 0,
            codexReviewSmokeBackfillItems: [],
            codexReviewSmokeBackfillStatePath: null,
            codexSmokeBackfillCount: 0,
            codexSmokeBackfillItems: [],
            codexSmokeBackfillStatePath: null,
            githubSyncStatus: "synced",
            githubSyncIssueCount: 0,
            githubSyncUpdatedAt: null,
            githubSyncCurrentPath: null,
            githubProjectStatus: "synced",
            githubProjectTitle: "Growth Foundation",
            githubProjectUrl: null,
            githubProjectItemCount: 0,
            githubPrWatchStatus: "waiting-checks",
            githubPrWatchPullCount: 1,
            githubPrWatchReadyCount: 0,
            githubPrWatchAttentionCount: 0,
            githubPrWatchUpdatedAt: "2026-03-06T16:00:00+09:00",
            githubPrWatchFreshnessStatus: "lagging",
            githubPrWatchAgeMinutes: 100,
            githubPrWatchItems: [],
            githubPrWatchCurrentPath:
              "memory/projects/2026-03-06_growth-foundation/github-pr-watch/current.md",
            githubPrWatchStatePath:
              "memory/projects/2026-03-06_growth-foundation/github-pr-watch/state.json",
            githubPrWatchLastSyncSource: "control-ui",
            githubPrWatchLastSyncStatus: "attention",
            githubPrWatchLastSyncFinishedAt: "2026-03-06T15:45:00+09:00",
            githubPrWatchLastSyncError:
              "yui-stingray/ai-company#5: combined status is still pending.",
            githubPrWatchLastSyncErrorCount: 1,
            githubWritebackStatus: "missing",
            githubWritebackIssueRef: null,
            githubWritebackActions: [],
            githubWritebackCloseIssue: false,
            githubWritebackOperator: null,
            githubWritebackProposalUpdatedAt: null,
            githubWritebackReceiptAppliedAt: null,
            githubWritebackProposalPath: null,
            githubWritebackReceiptPath: null,
            issueFlowStatus: "missing",
            issueFlowStage: null,
            issueFlowIssueNumber: null,
            issueFlowIssueRef: null,
            issueFlowUpdatedAt: null,
            issueFlowDirectoryPath: null,
            issueFlowPreflightStatus: "missing",
            issueFlowDraftStatus: "missing",
            issueFlowProposalStatus: "missing",
            issueFlowEnqueueStatus: "missing",
            issueFlowOutcomeStatus: "missing",
            issueFlowPreflightPath: null,
            issueFlowDraftPath: null,
            issueFlowProposalPath: null,
            issueFlowReceiptPath: null,
            issueFlowOutcomePath: null,
            issueFlowPrimaryResultPath: null,
            issueFlowActiveCount: 0,
            issueFlowRecentCount: 0,
            issueFlowRecentItems: [],
            issueFlowArchivedCount: 0,
            issueFlowArchiveRootPath: null,
            issueFlowArchivedLatestIssueRef: null,
            issueFlowArchivedLatestArchivedAt: null,
            issueFlowArchivedLatestPath: null,
            issueFlowArchivedLatestReceiptPath: null,
            issueFlowVisibilityStatus: "missing",
            issueFlowVisibilityReason: null,
            issueFlowVisibilityOpenIssue: null,
            issueFlowVisibilityGithubSyncUpdatedAt: null,
            relayStatus: "missing",
            relayChannel: null,
            relayMode: null,
            relayCandidateCount: 0,
            relayUpdatedAt: null,
            relayCurrentPath: null,
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("PR Freshness: lagging");
    expect(text).toContain("openclaw-sync-github-pr-watch");
    expect(text).toContain("openclaw-growth-github-pr-watch.timer");
    expect(text).toContain("Sync PR Watch");
    expect(text).toContain("last sync: control-ui");
    expect(text).toContain(
      "last sync note: yui-stingray/ai-company#5: combined status is still pending.",
    );
  });
});
