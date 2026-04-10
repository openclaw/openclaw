import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  const root = process.cwd();
  return readFileSync(path.resolve(root, relativePath), "utf8");
}

function pickVars(css: string, vars: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of vars) {
    const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
    out[name] = m?.[1]?.trim() ?? null;
  }
  return out;
}

describe("styles visual baseline", () => {
  it("keeps critical design tokens stable", () => {
    const css = read("src/styles/base.css");
    const dark = pickVars(css, [
      "--bg",
      "--card",
      "--text",
      "--muted",
      "--border",
      "--accent",
      "--warn",
      "--danger",
      "--radius-xl",
      "--shadow-card",
    ]);

    expect(dark).toMatchInlineSnapshot(`
      {
        "--accent": "#4f8ff7",
        "--bg": "#0b0f14",
        "--border": "#273447",
        "--card": "#121a25",
        "--danger": "#f87171",
        "--muted": "#8ea0b8",
        "--radius-xl": "24px",
        "--shadow-card": "var(--shadow-md)",
        "--text": "#cdd8e8",
        "--warn": "#fbbf24",
      }
    `);
  });

  it("keeps layout grid conventions for config and overview", () => {
    const configCss = read("src/styles/config.css");
    const componentsCss = read("src/styles/components.css");

    expect(configCss).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(configCss).toContain(".config-form--modern .config-section-card--half");
    expect(componentsCss).toContain(".ov-cards > .ov-card");
    expect(componentsCss).toContain(".ov-bottom-grid > .card");
  });

  it("keeps agents/list/table layout contracts", () => {
    const componentsCss = read("src/styles/components.css");
    expect(componentsCss).toContain(".agents-layout");
    expect(componentsCss).toContain("grid-template-columns: repeat(12, minmax(0, 1fr));");
    expect(componentsCss).toContain(".agents-sidebar");
    expect(componentsCss).toContain(".agents-main");
    expect(componentsCss).toContain(".list-item-selected");
    expect(componentsCss).toContain(".table-row:hover");
  });

  it("keeps chat panel and tool-card visual contracts", () => {
    const chatLayoutCss = read("src/styles/chat/layout.css");
    const chatSidebarCss = read("src/styles/chat/sidebar.css");
    const chatToolCardsCss = read("src/styles/chat/tool-cards.css");

    expect(chatLayoutCss).toContain(".agent-chat__input");
    expect(chatLayoutCss).toContain("border-radius: var(--radius-xl);");
    expect(chatSidebarCss).toContain(".chat-sidebar");
    expect(chatToolCardsCss).toContain(".chat-tool-card");
    expect(chatToolCardsCss).toContain("border-radius: var(--radius-lg);");
  });

  it("keeps data-table and config control-state contracts", () => {
    const componentsCss = read("src/styles/components.css");
    const configCss = read("src/styles/config.css");

    expect(componentsCss).toContain(".data-table-wrapper");
    expect(componentsCss).toContain(".data-table-search input:focus");
    expect(componentsCss).toContain(".data-table-pagination__controls button:disabled");
    expect(configCss).toContain(".cfg-input:focus");
    expect(configCss).toContain(".cfg-toggle-row.disabled");
    expect(configCss).toContain(".cfg-select:hover:not(:focus)");
  });
});
