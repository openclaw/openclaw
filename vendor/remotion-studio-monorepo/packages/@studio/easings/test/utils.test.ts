import { describe, it, expect } from "vitest";
import {
  reverseEasing,
  mirrorEasing,
  steps,
  combineEasings,
  scaleEasing,
  interpolate,
} from "../src/utils";
import { linear } from "../src/presets";

describe("easing utils", () => {
  describe("reverseEasing", () => {
    it("should reverse an easing function", () => {
      const reversed = reverseEasing(linear);
      expect(reversed(0)).toBe(1);
      expect(reversed(1)).toBe(0);
      expect(reversed(0.5)).toBeCloseTo(0.5, 5);
    });
  });

  describe("mirrorEasing", () => {
    it("should mirror an easing function", () => {
      const mirrored = mirrorEasing(linear);
      expect(mirrored(0)).toBe(0);
      expect(mirrored(1)).toBe(1);
      expect(mirrored(0.5)).toBeCloseTo(0.5, 5);
    });
  });

  describe("steps", () => {
    it("should create stepped easing", () => {
      const stepped = steps(4);
      expect(stepped(0)).toBe(0);
      expect(stepped(0.24)).toBeCloseTo(0, 1);
      expect(stepped(0.26)).toBeCloseTo(0.25, 1);
      expect(stepped(1)).toBe(1);
    });
  });

  describe("combineEasings", () => {
    it("should combine two easings", () => {
      const combined = combineEasings(linear, linear, 0.5);
      expect(combined(0)).toBe(0);
      expect(combined(0.5)).toBeCloseTo(0.5, 5);
      expect(combined(1)).toBe(1);
    });
  });

  describe("scaleEasing", () => {
    it("should scale easing to range", () => {
      const scaled = scaleEasing(linear, 10, 20);
      expect(scaled(0)).toBe(10);
      expect(scaled(1)).toBe(20);
      expect(scaled(0.5)).toBe(15);
    });
  });

  describe("interpolate", () => {
    it("should interpolate between values", () => {
      expect(interpolate(0, 100, 0, linear)).toBe(0);
      expect(interpolate(0, 100, 1, linear)).toBe(100);
      expect(interpolate(0, 100, 0.5, linear)).toBe(50);
    });
  });
});
