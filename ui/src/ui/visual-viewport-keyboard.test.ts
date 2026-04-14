import { describe, expect, it } from "vitest";
import {
  computeVisualViewportKeyboardInsetPx,
  shouldApplyKeyboardInset,
} from "./visual-viewport-keyboard.ts";

describe("computeVisualViewportKeyboardInsetPx", () => {
  it("returns 0 when the visual viewport fills the layout viewport", () => {
    expect(computeVisualViewportKeyboardInsetPx(800, 800, 0)).toBe(0);
  });

  it("returns the obscured height when the keyboard shrinks the visual viewport", () => {
    expect(computeVisualViewportKeyboardInsetPx(800, 500, 0)).toBe(300);
  });

  it("accounts for a positive visual viewport offset (e.g. chrome shifts)", () => {
    expect(computeVisualViewportKeyboardInsetPx(800, 500, 40)).toBe(260);
  });

  it("never returns negative values", () => {
    expect(computeVisualViewportKeyboardInsetPx(800, 900, 0)).toBe(0);
  });
});

describe("shouldApplyKeyboardInset", () => {
  it("returns true only when scale is 1 and an editable element is focused", () => {
    expect(shouldApplyKeyboardInset(1, true)).toBe(true);
    expect(shouldApplyKeyboardInset(1.1, true)).toBe(false);
    expect(shouldApplyKeyboardInset(1, false)).toBe(false);
  });
});
