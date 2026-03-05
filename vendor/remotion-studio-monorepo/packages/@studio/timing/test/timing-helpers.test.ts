import { describe, it, expect } from "vitest";
import {
  createSegment,
  getSegmentEnd,
  isInSegment,
  getLocalFrame,
  createSequentialSegments,
  stagger,
} from "../src/timing-helpers";

describe("timing-helpers", () => {
  describe("createSegment", () => {
    it("should create a segment", () => {
      const segment = createSegment(10, 20);
      expect(segment).toEqual({ start: 10, duration: 20 });
    });
  });

  describe("getSegmentEnd", () => {
    it("should get segment end", () => {
      const segment = createSegment(10, 20);
      expect(getSegmentEnd(segment)).toBe(30);
    });
  });

  describe("isInSegment", () => {
    it("should check if frame is in segment", () => {
      const segment = createSegment(10, 20);
      expect(isInSegment(15, segment)).toBe(true);
      expect(isInSegment(5, segment)).toBe(false);
      expect(isInSegment(35, segment)).toBe(false);
    });
  });

  describe("getLocalFrame", () => {
    it("should get local frame within segment", () => {
      const segment = createSegment(10, 20);
      expect(getLocalFrame(15, segment)).toBe(5);
      expect(getLocalFrame(5, segment)).toBe(-1);
    });
  });

  describe("createSequentialSegments", () => {
    it("should create sequential segments", () => {
      const segments = createSequentialSegments([10, 20, 30]);
      expect(segments).toEqual([
        { start: 0, duration: 10 },
        { start: 10, duration: 20 },
        { start: 30, duration: 30 },
      ]);
    });

    it("should create sequential segments with custom start", () => {
      const segments = createSequentialSegments([10, 20], 100);
      expect(segments).toEqual([
        { start: 100, duration: 10 },
        { start: 110, duration: 20 },
      ]);
    });
  });

  describe("stagger", () => {
    it("should calculate staggered timing", () => {
      expect(stagger(0, 5)).toBe(0);
      expect(stagger(1, 5)).toBe(5);
      expect(stagger(2, 5)).toBe(10);
      expect(stagger(2, 5, 100)).toBe(110);
    });
  });
});
