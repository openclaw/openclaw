import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const expected =
  `import missionControlConfig from "../../../../mission-control.config.json" with { type: "json" };\n\n` +
  `type MissionControlConfig = {\n` +
  `  featureFlags?: { missionControl?: boolean };\n` +
  `  workflow?: { stages?: string[]; guardrails?: string[] };\n` +
  `  team?: {\n` +
  `    agents?: Array<{ id: string; displayName: string; role: string; allowedModes: string[]; defaultMode?: string }>;\n` +
  `  };\n` +
  `  scoringWeights?: Record<string, number>;\n` +
  `};\n\n` +
  `export const MC_CONFIG = missionControlConfig as MissionControlConfig;\n`;

describe("generated config drift control", () => {
  it("generated-config.ts matches expected derived wrapper", () => {
    const p = join(process.cwd(), "src/ui/mission-control/generated-config.ts");
    const actual = readFileSync(p, "utf8");
    expect(actual).toBe(expected);
  });
});
