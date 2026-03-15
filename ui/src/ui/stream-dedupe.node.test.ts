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
    expect(getCommittedText([{ text: "我先改规则。" }, { text: "build 已经开始了。" }])).toBe(
      "我先改规则。build 已经开始了。",
    );
  });

  it("does not collapse two identical consecutive segments", () => {
    // appendUniqueText("abc", "abc") returns "abc" due to overlap detection,
    // but two incremental segments that happen to be identical must concatenate to "abcabc".
    expect(getCommittedText([{ text: "abc" }, { text: "abc" }])).toBe("abcabc");
  });

  it("extracts only the new suffix from a cumulative stream", () => {
    expect(
      getIncrementalStreamText([{ text: "我先改规则。" }], "我先改规则。build 已经开始了。"),
    ).toBe("build 已经开始了。");
  });

  it("returns empty when the cumulative stream adds nothing new", () => {
    expect(getIncrementalStreamText([{ text: "我先改规则。" }], "我先改规则。")).toBe("");
  });

  it("uses the same dedupe rule for live preview text", () => {
    expect(
      getLiveStreamPreviewText([{ text: "我先改规则。" }], "我先改规则。build 已经开始了。"),
    ).toBe("build 已经开始了。");
  });
});
