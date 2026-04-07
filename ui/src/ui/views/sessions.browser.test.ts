import { html, render } from "lit";
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function makeRow(overrides: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key: "session-default",
    kind: "direct",
    updatedAt: Date.now(),
    label: "",
    displayName: "",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makeProps(rows: GatewaySessionRow[]): SessionsProps {
  return {
    loading: false,
    result: {
      path: "/tmp/sessions.json",
      sessions: rows,
      defaults: {
        modelProvider: null,
        model: null,
        contextTokens: null,
      },
    } as SessionsListResult,
    error: null,
    activeMinutes: "",
    limit: "",
    includeGlobal: true,
    includeUnknown: true,
    basePath: "",
    searchQuery: "",
    sortColumn: "updated",
    sortDir: "desc",
    page: 0,
    pageSize: 10,
    selectedKeys: new Set(),
    expandedCheckpointKey: null,
    checkpointItemsByKey: {},
    checkpointLoadingKey: null,
    checkpointBusyKey: null,
    checkpointErrorByKey: {},
    onFiltersChange: () => {},
    onSearchChange: () => {},
    onSortChange: () => {},
    onPageChange: () => {},
    onPageSizeChange: () => {},
    onRefresh: () => {},
    onPatch: () => {},
    onToggleSelect: () => {},
    onSelectPage: () => {},
    onDeselectPage: () => {},
    onDeselectAll: () => {},
    onDeleteSelected: () => {},
    onNavigateToChat: () => {},
    onToggleCheckpointDetails: () => {},
    onBranchFromCheckpoint: () => {},
    onRestoreCheckpoint: () => {},
  };
}

describe("renderSessions", () => {
  it("keeps edited label attached to the same session after reorder", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    let rows: GatewaySessionRow[] = [
      makeRow({
        key: "session-a",
        label: "Alpha",
        updatedAt: 100,
      }),
      makeRow({
        key: "session-b",
        label: "Beta",
        updatedAt: 200,
      }),
    ];

    let props = makeProps(rows);

    const rerender = () => {
      render(html`${renderSessions(props)}`, host);
    };

    props.onPatch = (key, patch) => {
      rows = rows.map((row) => {
        if (row.key !== key) {
          return row;
        }

        const nextRow: GatewaySessionRow = {
          ...row,
          updatedAt: 300,
        };

        if ("label" in patch) {
          nextRow.label = patch.label ?? undefined;
        }
        if ("thinkingLevel" in patch) {
          nextRow.thinkingLevel = patch.thinkingLevel ?? undefined;
        }
        if ("fastMode" in patch) {
          nextRow.fastMode = patch.fastMode ?? undefined;
        }
        if ("verboseLevel" in patch) {
          nextRow.verboseLevel = patch.verboseLevel ?? undefined;
        }
        if ("reasoningLevel" in patch) {
          nextRow.reasoningLevel = patch.reasoningLevel ?? undefined;
        }

        return nextRow;
      });

      props = {
        ...props,
        result: {
          ...props.result!,
          sessions: rows,
        },
      };
      rerender();
    };

    rerender();
    await Promise.resolve();

    const beforeRows = Array.from(host.querySelectorAll("tbody tr"));
    expect(beforeRows).toHaveLength(2);
    expect(beforeRows[0]?.textContent).toContain("session-b");
    expect(beforeRows[1]?.textContent).toContain("session-a");

    const sessionARowBefore = beforeRows[1] as HTMLTableRowElement;
    const input = sessionARowBefore.querySelector(
      "input[placeholder='(optional)']",
    ) as HTMLInputElement;

    input.value = "Renamed A";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();

    const afterRows = Array.from(host.querySelectorAll("tbody tr"));
    expect(afterRows).toHaveLength(2);
    expect(afterRows[0]?.textContent).toContain("session-a");
    expect(afterRows[1]?.textContent).toContain("session-b");

    const sessionARowAfter = afterRows[0] as HTMLTableRowElement;
    const sessionBRowAfter = afterRows[1] as HTMLTableRowElement;

    const inputA = sessionARowAfter.querySelector(
      "input[placeholder='(optional)']",
    ) as HTMLInputElement;
    const inputB = sessionBRowAfter.querySelector(
      "input[placeholder='(optional)']",
    ) as HTMLInputElement;

    expect(inputA.value).toBe("Renamed A");
    expect(inputB.value).toBe("Beta");

    host.remove();
  });
});
