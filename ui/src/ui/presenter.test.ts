import { describe, it, expect, vi, afterEach } from "vitest";
import { formatNextRun } from "./presenter.ts";

describe("formatNextRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns n/a for falsy input", () => {
    expect(formatNextRun(null)).toBe("n/a");
    expect(formatNextRun(undefined)).toBe("n/a");
    expect(formatNextRun(0)).toBe("n/a");
  });

  it("uses runtime locale (undefined), not a hardcoded locale", () => {
    const spy = vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Mon");
    const ms = new Date("2025-01-06T00:00:00Z").getTime();
    formatNextRun(ms);
    expect(spy).toHaveBeenCalledWith(undefined, expect.objectContaining({ weekday: "short" }));
  });

  it("includes the weekday in the formatted output", () => {
    vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Mon");
    const ms = new Date("2025-01-06T00:00:00Z").getTime();
    const result = formatNextRun(ms);
    expect(result).toMatch(/^Mon,/);
  });
});
