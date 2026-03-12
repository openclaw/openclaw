import { render } from "lit";
import { describe, expect, it } from "vitest";
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
  it("shows telegram icon with username-like identifier in session key cell", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:telegram:direct:muhammedirfan00",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const platformMeta = container.querySelector(".session-platform-meta");
    expect(platformMeta?.textContent).toContain("✈️");
    expect(platformMeta?.textContent).toContain("@muhammedirfan00");
  });

  it("shows whatsapp icon with phone identifier in session key cell", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:whatsapp:direct:+919999888777",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const platformMeta = container.querySelector(".session-platform-meta");
    expect(platformMeta?.textContent).toContain("🟢");
    expect(platformMeta?.textContent).toContain("+919999888777");
  });

  it("prefers key phone for whatsapp even if displayName looks like a handle", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:whatsapp:direct:+919111222333",
            kind: "direct",
            updatedAt: Date.now(),
            displayName: "Alice",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const platformMeta = container.querySelector(".session-platform-meta");
    expect(platformMeta?.textContent).toContain("+919111222333");
    expect(platformMeta?.textContent).not.toContain("@Alice");
  });

  it("parses account-scoped direct keys for telegram", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:telegram:atlas:direct:muhammedirfan00",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const platformMeta = container.querySelector(".session-platform-meta");
    expect(platformMeta?.textContent).toContain("✈️");
    expect(platformMeta?.textContent).toContain("@muhammedirfan00");
  });

  it("shows channel icon for dm-scoped whatsapp keys", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:whatsapp:default:dm:+15551234567",
            kind: "direct",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const platformMeta = container.querySelector(".session-platform-meta");
    expect(platformMeta?.textContent).toContain("🟢");
    expect(platformMeta?.textContent).toContain("+15551234567");
  });

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
});
