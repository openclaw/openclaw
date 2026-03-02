import { describe, expect, it } from "vitest";
import { toSortedCompat } from "./sort.ts";

describe("toSortedCompat", () => {
  it("returns a sorted copy and does not mutate the input", () => {
    const input = [3, 1, 2];

    const sorted = toSortedCompat(input, (a, b) => a - b);

    expect(sorted).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("supports default sorting without a comparator", () => {
    expect(toSortedCompat(["b", "a"])).toEqual(["a", "b"]);
  });
});
