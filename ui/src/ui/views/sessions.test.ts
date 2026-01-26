import { render } from "lit";
import { describe, expect, it } from "vitest";

import type { SessionsListResult } from "../types";
import { renderSessions, type SessionsProps } from "./sessions";

function createSessions(now: number): SessionsListResult {
  return {
    ts: now,
    path: "",
    count: 2,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
      thinkingDefault: "off",
      verboseDefault: "off",
      reasoningDefault: "off",
      elevatedDefault: "off",
    },
    sessions: [
      {
        key: "session-one",
        kind: "direct",
        displayName: "One",
        updatedAt: now - 2 * 60 * 60_000,
      },
      {
        key: "session-two",
        kind: "direct",
        displayName: "Two",
        updatedAt: now - 2 * 60 * 60_000,
      },
    ],
  };
}

function createProps(overrides: Partial<SessionsProps> = {}): SessionsProps {
  const now = Date.now();
  const result = createSessions(now);
  return {
    loading: false,
    result,
    error: null,
    activeMinutes: "",
    limit: "",
    includeGlobal: true,
    includeUnknown: false,
    basePath: "",
    search: "",
    sort: "updated",
    sortDir: "desc",
    kindFilter: "all",
    statusFilter: "all",
    agentLabelFilter: "",
    laneFilter: "all",
    tagFilter: [],
    viewMode: "table",
    showHidden: false,
    autoHideCompletedMinutes: 0,
    autoHideErroredMinutes: 0,
    drawerKey: null,
    drawerExpanded: false,
    drawerPreviewLoading: false,
    drawerPreviewError: null,
    drawerPreview: null,
    onDrawerOpen: () => undefined,
    onDrawerOpenExpanded: () => undefined,
    onDrawerClose: () => undefined,
    onDrawerToggleExpanded: () => undefined,
    onDrawerRefreshPreview: () => undefined,
    onSessionOpen: () => undefined,
    onFiltersChange: () => undefined,
    onSearchChange: () => undefined,
    onSortChange: () => undefined,
    onKindFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onAgentLabelFilterChange: () => undefined,
    onTagFilterChange: () => undefined,
    onLaneFilterChange: () => undefined,
    onViewModeChange: () => undefined,
    onShowHiddenChange: () => undefined,
    onAutoHideChange: () => undefined,
    onDeleteMany: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onDelete: () => undefined,
    ...overrides,
  };
}

describe("sessions view", () => {
  it("treats sessions with active tasks as active for filtering/counts", () => {
    const container = document.createElement("div");
    const now = Date.now();
    const activeTasks = new Map([
      [
        "session-two",
        [{ taskId: "run:1", taskName: "Run", status: "in-progress", startedAt: now }],
      ],
    ]);

    render(
      renderSessions(
        createProps({
          statusFilter: "active",
          activeTasks,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Active 1");
    expect(container.textContent).toContain("Two");
    expect(container.textContent).not.toContain("One");
  });
});
