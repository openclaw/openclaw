import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function getCronWorkspaceFormRule() {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const cssPath = path.resolve(testDir, "../../styles/components.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const match = css.match(/\.cron-workspace-form\s*\{([^}]*)\}/);
  expect(match).not.toBeNull();
  return match![1];
}

describe("cron workspace form styles", () => {
  it("keeps the new-job panel in normal flow without its own desktop scroller", () => {
    const rule = getCronWorkspaceFormRule();

    expect(rule).not.toContain("position: sticky");
    expect(rule).not.toContain("overflow-y: auto");
  });
});
