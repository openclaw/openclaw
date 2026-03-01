import { describe, expect, it } from "vitest";
import { toSortedCompat } from "./sort-compat.ts";

describe("toSortedCompat", () => {
  it("sorts values without mutating the input array", () => {
    const input = [3, 1, 2];
    const result = toSortedCompat(input, (a, b) => a - b);
    expect(result).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("falls back to sort when toSorted is unavailable", () => {
    const input = ["b", "c", "a"];
    Object.defineProperty(input, "toSorted", {
      configurable: true,
      value: undefined,
    });

    const result = toSortedCompat(input, (a, b) => a.localeCompare(b));
    expect(result).toEqual(["a", "b", "c"]);
    expect(input).toEqual(["b", "c", "a"]);
  });
});
