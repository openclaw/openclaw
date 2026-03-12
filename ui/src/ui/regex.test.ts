import { describe, expect, it } from "vitest";
import { escapeRegExp } from "./regex.ts";

describe("escapeRegExp", () => {
  it("escapes square brackets in literal text", () => {
    const literal = "exec[child]*";
    const pattern = new RegExp(`^${escapeRegExp(literal)}$`);

    expect(pattern.test(literal)).toBe(true);
    expect(pattern.test("execchild*")).toBe(false);
  });
});
