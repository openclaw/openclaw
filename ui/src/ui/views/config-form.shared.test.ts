import { describe, expect, it } from "vitest";
import { defaultValue, type JsonSchema } from "./config-form.shared.ts";

describe("defaultValue", () => {
  it("fills required string fields for new object rows (models.providers.*.models items)", () => {
    const modelItemSchema: JsonSchema = {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        reasoning: { type: "boolean" },
      },
    };
    expect(defaultValue(modelItemSchema)).toEqual({
      id: "placeholder",
      name: "placeholder",
    });
  });

  it("uses first enum string for required string when present", () => {
    const schema: JsonSchema = {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["a", "b"] },
      },
    };
    expect(defaultValue(schema)).toEqual({ mode: "a" });
  });

  it("returns empty object when object has no required list", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
      },
    };
    expect(defaultValue(schema)).toEqual({});
  });

  it("returns const when set", () => {
    const schema: JsonSchema = { const: "fixed" };
    expect(defaultValue(schema)).toBe("fixed");
  });
});
