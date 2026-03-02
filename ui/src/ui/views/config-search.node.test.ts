import { describe, expect, it } from "vitest";
import {
  appendTagFilter,
  getTagFilters,
  hasTagFilter,
  removeTagFilter,
  replaceTagFilters,
  toggleTagFilter,
} from "./config-search.ts";

describe("config search tag helper", () => {
  it("adds a tag when query is empty", () => {
    expect(appendTagFilter("", "security")).toBe("tag:security");
  });

  it("appends a tag to existing text query", () => {
    expect(appendTagFilter("token", "security")).toBe("token tag:security");
  });

  it("deduplicates existing tag filters case-insensitively", () => {
    expect(appendTagFilter("token tag:Security", "security")).toBe("token tag:Security");
  });

  it("detects exact tag terms", () => {
    expect(hasTagFilter("tag:security token", "security")).toBe(true);
    expect(hasTagFilter("tag:security-hard token", "security")).toBe(false);
  });

  it("removes only the selected active tag", () => {
    expect(removeTagFilter("token tag:security tag:auth", "security")).toBe("token tag:auth");
  });

  it("toggle removes active tag and keeps text", () => {
    expect(toggleTagFilter("token tag:security", "security")).toBe("token");
  });

  it("toggle adds missing tag", () => {
    expect(toggleTagFilter("token", "channels")).toBe("token tag:channels");
  });

  it("extracts unique normalized tags from query", () => {
    expect(getTagFilters("token tag:Security tag:auth tag:security")).toEqual(["security", "auth"]);
  });

  it("replaces only tag filters and preserves free text", () => {
    expect(replaceTagFilters("token tag:security mode", ["auth", "channels"])).toBe(
      "token mode tag:auth tag:channels",
    );
  });
});
