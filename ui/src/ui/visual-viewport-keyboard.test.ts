import { describe, expect, it } from "vitest";
import {
  computeVisualViewportKeyboardInsetPx,
  isTextEditableElement,
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

describe("isTextEditableElement", () => {
  it("accepts text-entry inputs and textareas", () => {
    const textInput = document.createElement("input");
    textInput.type = "text";
    const emailInput = document.createElement("input");
    emailInput.type = "email";
    const numberInput = document.createElement("input");
    numberInput.type = "number";
    const textarea = document.createElement("textarea");

    expect(isTextEditableElement(textInput)).toBe(true);
    expect(isTextEditableElement(emailInput)).toBe(true);
    expect(isTextEditableElement(numberInput)).toBe(true);
    expect(isTextEditableElement(textarea)).toBe(true);
  });

  it("rejects non-text input controls", () => {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    const checkboxInput = document.createElement("input");
    checkboxInput.type = "checkbox";
    const rangeInput = document.createElement("input");
    rangeInput.type = "range";

    expect(isTextEditableElement(fileInput)).toBe(false);
    expect(isTextEditableElement(checkboxInput)).toBe(false);
    expect(isTextEditableElement(rangeInput)).toBe(false);
  });

  it("rejects readonly and disabled text-entry inputs", () => {
    const readonlyInput = document.createElement("input");
    readonlyInput.type = "text";
    readonlyInput.readOnly = true;
    const disabledInput = document.createElement("input");
    disabledInput.type = "search";
    disabledInput.disabled = true;

    expect(isTextEditableElement(readonlyInput)).toBe(false);
    expect(isTextEditableElement(disabledInput)).toBe(false);
  });
});
