import { describe, expect, it } from "vitest";
import { formatGatewayError } from "./gateway.ts";

describe("formatGatewayError", () => {
  it("returns message when details are absent", () => {
    expect(formatGatewayError({ code: "invalid_config", message: "invalid config" })).toBe(
      "invalid config",
    );
  });

  it("appends object details as JSON", () => {
    const message = formatGatewayError({
      code: "invalid_config",
      message: "invalid config",
      details: [
        { path: "models.providers.openai.models.0.maxTokens", message: "expected number" },
      ],
    });
    expect(message).toContain("invalid config:");
    expect(message).toContain("maxTokens");
  });
});
