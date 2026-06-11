import { describe, expect, it } from "vitest";
import {
  computeMobileComposerBottomPadding,
  computeMobileKeyboardInset,
} from "./mobile-viewport.ts";

describe("mobile viewport keyboard inset", () => {
  it("stays at zero when the chat composer is not focused", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: false,
      }),
    ).toBe(0);
  });

  it("returns the covered bottom area when the mobile keyboard shrinks the visual viewport", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: true,
      }),
    ).toBe(324);
  });

  it("uses the stable layout height when Safari shrinks innerHeight with the keyboard", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 520,
        layoutHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: true,
      }),
    ).toBe(324);
  });

  it("ignores small browser chrome changes that are not keyboard coverage", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        viewportHeight: 820,
        viewportOffsetTop: 0,
        textInputFocused: true,
      }),
    ).toBe(0);
  });

  it("falls back to a conservative keyboard inset when mobile Safari gives no viewport signal", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 844,
        viewportOffsetTop: 0,
        textInputFocused: true,
        fallbackKeyboardInset: 320,
      }),
    ).toBe(320);
  });

  it("keeps the fallback inset when Safari gives no viewport signal but the composer is measurable", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 844,
        viewportOffsetTop: 0,
        textInputFocused: true,
        fallbackKeyboardInset: 320,
        composerBottom: 836,
        currentInset: 0,
        desiredGap: 8,
      }),
    ).toBe(320);
  });

  it("keeps the fallback inset after the composer has already been lifted without a viewport signal", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 844,
        viewportOffsetTop: 0,
        textInputFocused: true,
        fallbackKeyboardInset: 320,
        composerBottom: 524,
        currentInset: 320,
        desiredGap: 8,
      }),
    ).toBe(320);
  });

  it("does not double-shift the composer when Safari already keeps it above the keyboard", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: true,
        composerBottom: 510,
        currentInset: 0,
        desiredGap: 8,
      }),
    ).toBe(0);
  });

  it("moves only the covered part of the composer above the visible viewport", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: true,
        composerBottom: 820,
        currentInset: 0,
        desiredGap: 8,
      }),
    ).toBe(308);
  });

  it("accounts for the current transform before recalculating the composer position", () => {
    expect(
      computeMobileKeyboardInset({
        innerHeight: 844,
        layoutHeight: 844,
        viewportHeight: 520,
        viewportOffsetTop: 0,
        textInputFocused: true,
        composerBottom: 500,
        currentInset: 320,
        desiredGap: 8,
      }),
    ).toBe(308);
  });

  it("reserves composer, keyboard, safe area, and comfort gap below the transcript", () => {
    expect(
      computeMobileComposerBottomPadding({
        composerHeight: 148,
        keyboardInset: 320,
        safeAreaBottom: 34,
        gap: 18,
      }),
    ).toBe(520);
  });

  it("uses a conservative default composer height before the composer is measured", () => {
    expect(computeMobileComposerBottomPadding({ keyboardInset: 0, safeAreaBottom: 0 })).toBe(148);
  });
});
