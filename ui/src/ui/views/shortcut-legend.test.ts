/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderShortcutLegend } from "./shortcut-legend.ts";

function renderLegend() {
  const container = document.createElement("div");
  const onClose = vi.fn();
  document.body.append(container);
  render(html`${renderShortcutLegend({ open: true, onClose })}`, container);
  return { container, onClose };
}

describe("shortcut legend", () => {
  it("renders clean key combos and traps focus from outside the dialog", () => {
    const { container } = renderLegend();
    const backdrop = container.querySelector<HTMLElement>(".shortcut-legend__backdrop");
    const close = container.querySelector<HTMLButtonElement>(".shortcut-legend__close");

    expect(container.textContent).toContain("Ctrl+K");
    expect(container.textContent).not.toContain("+>");
    expect(backdrop).toBeInstanceOf(HTMLElement);
    expect(close).toBeInstanceOf(HTMLButtonElement);

    document.body.focus();
    backdrop!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(document.activeElement).toBe(close);
    container.remove();
  });

  it("stops Escape after closing the overlay", () => {
    const { container, onClose } = renderLegend();
    const backdrop = container.querySelector<HTMLElement>(".shortcut-legend__backdrop");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    backdrop!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    container.remove();
  });
});
