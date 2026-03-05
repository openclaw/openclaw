import { describe, it, expect } from "vitest";
import { cubicBezier } from "../src/cubic-bezier";

describe("cubic-bezier", () => {
  it("should create a cubic bezier function", () => {
    const easing = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(typeof easing).toBe("function");
  });

  it("should return 0 for t=0", () => {
    const easing = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(easing(0)).toBe(0);
  });

  it("should return 1 for t=1", () => {
    const easing = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(easing(1)).toBe(1);
  });

  it("should return value between 0 and 1 for t between 0 and 1", () => {
    const easing = cubicBezier(0.25, 0.1, 0.25, 1);
    const result = easing(0.5);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("should throw error for invalid x1 or x2", () => {
    expect(() => cubicBezier(-0.1, 0, 0.5, 1)).toThrow();
    expect(() => cubicBezier(0.5, 0, 1.1, 1)).toThrow();
  });

  it("should create linear easing for (0,0,1,1)", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.5)).toBeCloseTo(0.5, 1);
  });
});
