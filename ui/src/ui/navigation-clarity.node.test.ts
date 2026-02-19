import { describe, expect, it } from "vitest";
import { pathForTab, tabFromPath } from "./navigation.ts";

describe("clarityos routing", () => {
  it("round-trips the ClarityOS tab path", () => {
    const path = pathForTab("clarityos");
    expect(path).toBe("/clarityos");
    expect(tabFromPath(path)).toBe("clarityos");
  });

  it("resolves ClarityOS path when served behind a base path", () => {
    expect(tabFromPath("/control/clarityos", "/control")).toBe("clarityos");
  });
});
