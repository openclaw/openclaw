import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./tile-toggle.js";
import type { KioskTileToggle, TileTapDetail } from "./tile-toggle.js";

async function mountTile(props: Partial<KioskTileToggle>): Promise<KioskTileToggle> {
  const el = document.createElement("kiosk-tile-toggle") as KioskTileToggle;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("kiosk-tile-toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders name + state label", async () => {
    const el = await mountTile({
      entityId: "switch.gate_main",
      name: "Main Gate",
      state: "off",
    });
    expect(el.textContent).toContain("Main Gate");
    expect(el.textContent).toContain("off");
  });

  it("emits a tile-tap event with domain/service/entity_id on click", async () => {
    const el = await mountTile({
      entityId: "switch.gate_main",
      domain: "switch",
      service: "toggle",
      state: "off",
    });
    const seen: TileTapDetail[] = [];
    el.addEventListener("tile-tap", (ev) => seen.push((ev as CustomEvent<TileTapDetail>).detail));

    el.querySelector("button")?.click();

    expect(seen).toEqual([{ entityId: "switch.gate_main", domain: "switch", service: "toggle" }]);
  });

  it("does not emit when entityId is empty (the tile is disabled)", async () => {
    const el = await mountTile({ entityId: "", name: "Unwired", state: "off" });
    const seen: unknown[] = [];
    el.addEventListener("tile-tap", (ev) => seen.push(ev));

    el.querySelector("button")?.click();

    expect(seen).toHaveLength(0);
  });

  it("reflects pending and error attributes for CSS to style", async () => {
    const el = await mountTile({
      entityId: "switch.geyser",
      name: "Geyser",
      state: "on",
      pending: true,
    });
    let btn = el.querySelector("button")!;
    expect(btn.getAttribute("data-pending")).toBe("true");

    el.pending = false;
    el.error = true;
    el.errorMessage = "service-denied";
    await el.updateComplete;
    btn = el.querySelector("button")!;
    expect(btn.getAttribute("data-error")).toBe("true");
    expect(btn.getAttribute("title")).toBe("service-denied");
  });

  it("renders an n/a label for unavailable state without crashing", async () => {
    const el = await mountTile({
      entityId: "switch.unavailable_for_now",
      name: "Stale",
      state: "unavailable",
    });
    expect(el.textContent).toContain("n/a");
  });

  it("uses an explicit icon when provided", async () => {
    const el = await mountTile({
      entityId: "switch.gate_main",
      name: "Gate",
      state: "off",
      icon: "G",
    });
    expect(el.querySelector(".kiosk-tile__icon")?.textContent?.trim()).toBe("G");
  });
});
