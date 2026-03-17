import { describe, expect, it } from "vitest";
import { computeGuardrailWarnings } from "./guardrails.ts";

describe("mission-control guardrail tuning", () => {
  it("suppresses scout contract warning when scout has no active work", () => {
    const warnings = computeGuardrailWarnings(
      {
        id: "scout",
        displayName: "Scout",
        role: "Research",
        allowedModes: ["research"],
      },
      [
        {
          id: "wi-1",
          title: "Execution task",
          stage: "execution",
          owner: "forge",
          updatedAt: Date.now(),
          priority: "High",
        },
      ],
      [],
    );

    expect(warnings.some((w) => w.id === "scout-contract")).toBe(false);
  });
});
