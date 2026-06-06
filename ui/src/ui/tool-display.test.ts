// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveToolDisplay } from "./tool-display.ts";

describe("resolveToolDisplay labelOverride", () => {
  it("uses labelOverride for both label and title when provided", () => {
    const display = resolveToolDisplay({
      name: "web_search",
      labelOverride: "Parallel Web Search",
    });
    expect(display.label).toBe("Parallel Web Search");
    expect(display.title).toBe("Parallel Web Search");
    // Icon still comes from the static spec; only the text is overridden.
    expect(display.name).toBe("web_search");
  });

  it("falls back to the static spec label when no override is given", () => {
    const display = resolveToolDisplay({ name: "web_search" });
    expect(display.label).not.toBe("Parallel Web Search");
  });
});
