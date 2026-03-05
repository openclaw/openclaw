import { describe, expect, it } from "vitest";

function resolveVersionBadge(params: {
  helloVersion?: string;
  serverVersion?: string | null;
  updateCurrentVersion?: string;
}): string {
  const NA = "N/A";
  return (
    (typeof params.helloVersion === "string" && params.helloVersion.trim()) ||
    (typeof params.serverVersion === "string" && params.serverVersion.trim()) ||
    params.updateCurrentVersion ||
    NA
  );
}

describe("version badge fallback chain", () => {
  it("prefers hello.server.version when available", () => {
    expect(
      resolveVersionBadge({
        helloVersion: "2026.3.2",
        serverVersion: "2026.3.1",
        updateCurrentVersion: "2026.3.0",
      }),
    ).toBe("2026.3.2");
  });

  it("falls back to serverVersion when hello is unavailable", () => {
    expect(
      resolveVersionBadge({
        helloVersion: undefined,
        serverVersion: "2026.3.2",
        updateCurrentVersion: "2026.3.0",
      }),
    ).toBe("2026.3.2");
  });

  it("falls back to serverVersion when hello is empty string", () => {
    expect(
      resolveVersionBadge({
        helloVersion: "  ",
        serverVersion: "2026.3.2",
      }),
    ).toBe("2026.3.2");
  });

  it("falls back to updateAvailable.currentVersion when both hello and serverVersion missing", () => {
    expect(
      resolveVersionBadge({
        helloVersion: undefined,
        serverVersion: null,
        updateCurrentVersion: "2026.3.2",
      }),
    ).toBe("2026.3.2");
  });

  it("returns N/A when all sources are missing", () => {
    expect(
      resolveVersionBadge({
        helloVersion: undefined,
        serverVersion: null,
        updateCurrentVersion: undefined,
      }),
    ).toBe("N/A");
  });

  it("skips serverVersion when it is whitespace-only", () => {
    expect(
      resolveVersionBadge({
        helloVersion: undefined,
        serverVersion: "   ",
        updateCurrentVersion: "2026.3.2",
      }),
    ).toBe("2026.3.2");
  });
});
