import { describe, expect, it } from "vitest";
import { commandPaletteShortcutLabel } from "./keyboard-shortcuts.ts";

describe("commandPaletteShortcutLabel", () => {
  it("returns the mac shortcut on Apple user agents", () => {
    expect(
      commandPaletteShortcutLabel({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" }),
    ).toBe("⌘K");
    expect(commandPaletteShortcutLabel({ userAgent: "iPhone" })).toBe("⌘K");
  });

  it("returns the control shortcut on non-Apple user agents", () => {
    expect(
      commandPaletteShortcutLabel({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }),
    ).toBe("Ctrl+K");
    expect(commandPaletteShortcutLabel({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe(
      "Ctrl+K",
    );
  });
});
