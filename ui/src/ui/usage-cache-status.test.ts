// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getUsageCacheRefreshTitle } from "./usage-cache-status.ts";

describe("getUsageCacheRefreshTitle", () => {
  it("formats non-fresh cache states for the Usage loading badge", () => {
    const refreshing = getUsageCacheRefreshTitle({
      status: "refreshing",
      cachedFiles: 4,
      pendingFiles: 2,
      staleFiles: 2,
    });
    // The exact text depends on locale; check that the numbers are present
    expect(refreshing).toContain("2");
    expect(refreshing).toContain("4");

    const partial = getUsageCacheRefreshTitle({
      status: "partial",
      cachedFiles: 4,
      pendingFiles: 1,
      staleFiles: 1,
    });
    expect(partial).toContain("1");
    expect(partial).toContain("4");

    expect(
      getUsageCacheRefreshTitle({
        status: "fresh",
        cachedFiles: 4,
        pendingFiles: 0,
        staleFiles: 0,
      }),
    ).toBeNull();
  });
});
