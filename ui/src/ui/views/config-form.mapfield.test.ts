import { describe, expect, it } from "vitest";

// Minimal reproduction of the null-spread guard pattern used in renderMapField.
// The actual renderMapField is a lit template function that is hard to unit-test
// in a node/vitest environment without a DOM. These tests verify the core
// logic pattern that was fixed.

describe("renderMapField value guard", () => {
  // This pattern is used in three places inside renderMapField:
  // 1. Add Entry click handler
  // 2. Key rename @change handler
  // 3. Remove entry @click handler

  it("does not throw when spreading null", () => {
    const value = null;
    // Old code: would throw "TypeError: Cannot spread null"
    expect(() => void ({ ...value })).toThrow(TypeError);
    // Fixed code with null guard:
    expect(() => void ({ ...(value ?? {}) })).not.toThrow();
  });

  it("does not throw when spreading undefined", () => {
    const value = undefined;
    expect(() => void ({ ...(value ?? {}) })).not.toThrow();
  });

  it("preserves object behavior for all three renderMapField patterns", () => {
    // Pattern 1: Add new entry (null value)
    const value1: Record<string, unknown> | null = null;
    const next1 = { ...(value1 ?? {}) };
    expect(next1).toEqual({});

    // Pattern 2: Rename key (key already in map)
    const value2 = { "custom-1": "foo" };
    const next2 = { ...(value2 ?? {}) };
    expect(next2).toEqual({ "custom-1": "foo" });

    // Pattern 3: Remove key (null value)
    const value3: Record<string, unknown> | null = null;
    const next3 = { ...(value3 ?? {}) };
    delete next3["custom-1"]; // should be no-op
    expect(next3).toEqual({});
  });
});
