import { describe, expect, it } from "vitest";
import { renderProvenanceSummary } from "./mission-provenance.ts";

function asText(value: unknown) {
  return String((value as { strings?: string[] })?.strings?.join(" ") ?? "");
}

describe("mission provenance summary", () => {
  it("renders unavailable warning", () => {
    const out = renderProvenanceSummary(["unavailable"]);
    expect(asText(out)).toContain("unavailable");
  });

  it("renders stale warning", () => {
    const out = renderProvenanceSummary(["stale"]);
    expect(asText(out)).toContain("stale");
  });

  it("renders seed-backed note", () => {
    const out = renderProvenanceSummary(["seed-backed"]);
    expect(asText(out)).toContain("seed-backed");
  });

  it("renders mixed note", () => {
    const out = renderProvenanceSummary(["mixed"]);
    expect(asText(out)).toContain("non-authoritative");
  });

  it("renders live note", () => {
    const out = renderProvenanceSummary(["live"]);
    expect(asText(out)).toContain("live");
  });
});
