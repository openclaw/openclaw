import { describe, expect, it } from "vitest";
import { normalizeToolName } from "../../../../src/agents/tool-policy.js";

describe("tool-policy browser safety", () => {
  it("normalizeToolName works in browser context without Node.js modules", () => {
    // If this import chain pulls in server-only code (node:module, node:fs, etc.)
    // the browser context will throw before reaching this assertion.
    expect(normalizeToolName("bash")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("read")).toBe("read");
  });
});
