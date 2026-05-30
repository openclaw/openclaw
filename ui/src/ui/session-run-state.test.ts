import { describe, expect, it } from "vitest";
import { isSessionRunActive } from "./session-run-state.ts";

describe("isSessionRunActive", () => {
  it("treats an explicit inactive flag as authoritative over a stale running status", () => {
    expect(isSessionRunActive({ hasActiveRun: false, status: "running" })).toBe(false);
  });

  it("uses the run status when no explicit inactive flag is available", () => {
    expect(isSessionRunActive({ status: "running" })).toBe(true);
    expect(isSessionRunActive({ hasActiveRun: true, status: "done" })).toBe(false);
  });

  it("falls back to the active flag when no status is available", () => {
    expect(isSessionRunActive({ hasActiveRun: true })).toBe(true);
    expect(isSessionRunActive({ hasActiveRun: false })).toBe(false);
  });
});
