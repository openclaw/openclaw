/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { MemoryAuditSuggestion } from "../controllers/memory-audit.ts";
import { renderMemoryAudit, type MemoryAuditProps } from "./memory-audit.ts";

function buildSuggestion(overrides: Partial<MemoryAuditSuggestion> = {}): MemoryAuditSuggestion {
  return {
    id: "audit-1",
    status: "pending",
    action: "edit",
    text: "Prefer direct operational summaries.",
    rationale: "The current MEMORY entry overstates a one-off preference.",
    confidence: 0.84,
    source: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
      startLine: 4,
      endLine: 6,
      hash: "abc123",
    },
    target: {
      surfaceId: "agent-memory:hex",
      kind: "agent-memory",
      path: "MEMORY.md",
      workspaceDir: "/workspace/hex",
      agentId: "hex",
    },
    createdAt: "2026-05-01T06:10:00.000Z",
    updatedAt: "2026-05-01T06:10:00.000Z",
    ...overrides,
  };
}

function buildProps(overrides: Partial<MemoryAuditProps> = {}): MemoryAuditProps {
  return {
    loading: false,
    error: null,
    actionId: null,
    actionMessage: null,
    suggestions: {
      agentId: "hex",
      workspaces: ["/workspace/hex"],
      total: 1,
      pending: 1,
      applied: 0,
      rejected: 0,
      conflict: 0,
      suggestions: [buildSuggestion()],
    },
    onRefresh: () => {},
    onApply: () => {},
    onReject: () => {},
    ...overrides,
  };
}

function renderInto(props: MemoryAuditProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderMemoryAudit(props), container);
  return container;
}

function text(container: Element): string {
  return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("memory audit view", () => {
  it("renders summary counts and pending suggestion details", () => {
    const container = renderInto(buildProps());

    expect(text(container)).toContain("Review Queue");
    expect(text(container)).toContain("Pending suggestions staged by memory audit runs.");
    expect(text(container)).toContain("Prefer direct operational summaries.");
    expect(text(container)).toContain("MEMORY.md:4-6");
    expect(text(container)).toContain("84%");
  });

  it("calls apply and reject handlers for pending suggestions", () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const container = renderInto(buildProps({ onApply, onReject }));
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));

    buttons.find((button) => button.textContent?.includes("Apply"))?.click();
    buttons.find((button) => button.textContent?.includes("Reject"))?.click();

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "audit-1" }));
    expect(onReject).toHaveBeenCalledWith(expect.objectContaining({ id: "audit-1" }));
  });

  it("disables actions for non-pending suggestions", () => {
    const container = renderInto(
      buildProps({
        suggestions: {
          agentId: "hex",
          workspaces: ["/workspace/hex"],
          total: 1,
          pending: 0,
          applied: 1,
          rejected: 0,
          conflict: 0,
          suggestions: [
            buildSuggestion({ status: "applied", appliedAt: "2026-05-01T06:20:00.000Z" }),
          ],
        },
      }),
    );

    const actionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter(
      (button) => button.textContent?.includes("Apply") || button.textContent?.includes("Reject"),
    );
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("disables actions while the queue is refreshing", () => {
    const container = renderInto(buildProps({ loading: true }));

    const actionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter(
      (button) => button.textContent?.includes("Apply") || button.textContent?.includes("Reject"),
    );
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("renders empty and error states", () => {
    const container = renderInto(
      buildProps({
        error: "Memory Audit is unavailable",
        suggestions: {
          workspaces: [],
          total: 0,
          pending: 0,
          applied: 0,
          rejected: 0,
          conflict: 0,
          suggestions: [],
        },
      }),
    );

    expect(text(container)).toContain("Memory Audit is unavailable");
    expect(text(container)).toContain("No pending audit suggestions");
  });
});
