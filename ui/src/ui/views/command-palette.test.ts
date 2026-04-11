import { describe, expect, it } from "vitest";
import { getPaletteItems } from "./command-palette.ts";

describe("getPaletteItems", () => {
  it("includes runtime slash commands from the shared command catalog", () => {
    const items = getPaletteItems([
      {
        name: "help",
        textAliases: ["/help"],
        description: "Show available commands.",
        acceptsArgs: false,
        source: "native",
        scope: "both",
        category: "status",
      },
      {
        name: "office_hours",
        textAliases: ["/office_hours", "/office-hours"],
        description: "Run office hours workflow.",
        acceptsArgs: true,
        source: "skill",
        scope: "both",
        category: "tools",
      },
    ]);

    expect(items.find((item) => item.id === "slash:office_hours")).toMatchObject({
      label: "/office_hours",
      action: "/office_hours",
      description: "Run office hours workflow.",
    });
  });
});
