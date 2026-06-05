import { afterEach, describe, expect, it } from "vitest";
import {
  getTimezone,
  setTimezone,
  toLocaleDateString,
  toLocaleString,
  toLocaleTimeString,
} from "./timezone.ts";

describe("timezone", () => {
  afterEach(() => {
    setTimezone(undefined);
  });

  it("returns undefined when no timezone is configured", () => {
    expect(getTimezone()).toBeUndefined();
  });

  it("stores and retrieves a configured timezone", () => {
    setTimezone("America/New_York");
    expect(getTimezone()).toBe("America/New_York");
  });

  it("clears timezone when set to undefined", () => {
    setTimezone("Europe/Berlin");
    setTimezone(undefined);
    expect(getTimezone()).toBeUndefined();
  });

  it("toLocaleTimeString applies configured timezone", () => {
    const date = new Date("2026-06-05T12:00:00Z");
    setTimezone("America/New_York");
    const result = toLocaleTimeString(date, "en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    expect(result).toContain("08:00");
  });

  it("toLocaleTimeString works without configured timezone", () => {
    const date = new Date("2026-06-05T12:00:00Z");
    const result = toLocaleTimeString(date, undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("toLocaleDateString applies configured timezone", () => {
    const date = new Date("2026-06-05T03:00:00Z");
    setTimezone("America/New_York");
    const result = toLocaleDateString(date, "en-US", { weekday: "short" });
    expect(result).toBe("Thu");
  });

  it("toLocaleString applies configured timezone", () => {
    const date = new Date("2026-06-05T12:00:00Z");
    setTimezone("Asia/Tokyo");
    const result = toLocaleString(date, "en-US");
    expect(result).toContain("9:00");
  });
});
