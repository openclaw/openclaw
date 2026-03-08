import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(session: SessionsListResult["sessions"][number]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: 1,
    defaults: { model: null, contextTokens: null },
    sessions: [session],
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    basePath: "",
    onFiltersChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onDelete: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders verbose=full without falling back to inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            verboseLevel: "full",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const verbose = selects[1] as HTMLSelectElement | undefined;
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
  });

  it("keeps unknown stored values selectable instead of forcing inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const reasoning = selects[2] as HTMLSelectElement | undefined;
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);
  });

  it("calls onOpenSession via click instead of navigating when provided", async () => {
    const onOpenSession = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
        onOpenSession,
      }),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.session-link");
    expect(link).not.toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    expect(onOpenSession).toHaveBeenCalledOnce();
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:main");
  });

  it("does not call onOpenSession for modifier-key clicks (allow browser default)", async () => {
    const onOpenSession = vi.fn();
    const container = document.createElement("div");
    render(
      renderSessions({
        ...buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
        onOpenSession,
      }),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.session-link");
    // Ctrl+click should open a new tab — must not trigger SPA navigation
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ctrlKey: true }));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("falls back to normal href navigation when onOpenSession is not provided", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const link = container.querySelector<HTMLAnchorElement>("a.session-link");
    expect(link).not.toBeNull();
    // Should still render a valid href for accessibility / middle-click / keyboard navigation
    expect(link?.getAttribute("href")).toContain("session=agent%3Amain%3Amain");
  });
});
