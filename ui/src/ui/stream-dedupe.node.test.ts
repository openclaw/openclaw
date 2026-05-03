import { describe, expect, it } from "vitest";
import {
  appendUniqueText,
  getCommittedText,
  getIncrementalStreamText,
  getLiveStreamPreviewText,
} from "./stream-dedupe.ts";

describe("stream-dedupe", () => {
  it("appends only the non-overlapping suffix", () => {
    expect(appendUniqueText("hello", "lo world")).toBe("hello world");
  });

  it("reconstructs committed text from incremental segments", () => {
    expect(getCommittedText([{ text: "abc" }, { text: "def" }])).toBe("abcdef");
  });

  it("does not collapse repeated incremental segments", () => {
    expect(getCommittedText([{ text: "abc" }, { text: "abc" }])).toBe("abcabc");
  });

  it("extracts only the new suffix from a cumulative stream", () => {
    expect(getIncrementalStreamText([{ text: "abc" }, { text: "abc" }], "abcabcdef")).toBe(
      "def",
    );
  });

  it("returns empty when the cumulative stream adds nothing new", () => {
    expect(getIncrementalStreamText([{ text: "abc" }, { text: "abc" }], "abcabc")).toBe("");
  });

  it("uses the same dedupe rule for live preview text", () => {
    expect(getLiveStreamPreviewText([{ text: "abc" }, { text: "abc" }], "abcabcdef")).toBe(
      "def",
    );
  });
});
