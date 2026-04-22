import { describe, expect, it } from "vitest";
import { detectActivePreset } from "./config-presets.ts";

describe("detectActivePreset", () => {
  it("returns null when bootstrap defaults are unset", () => {
    expect(detectActivePreset({})).toBeNull();
  });

  it("returns the matching preset when all preset fields match", () => {
    expect(
      detectActivePreset({
        agents: {
          defaults: {
            bootstrapMaxChars: 50_000,
            bootstrapTotalMaxChars: 300_000,
            contextInjection: "always",
          },
        },
      }),
    ).toBe("codeAgent");
  });

  it("does not match a preset when context injection differs", () => {
    expect(
      detectActivePreset({
        agents: {
          defaults: {
            bootstrapMaxChars: 50_000,
            bootstrapTotalMaxChars: 300_000,
            contextInjection: "continuation-skip",
          },
        },
      }),
    ).toBeNull();
  });
});
