import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./badge-entity.js";
import type { KioskBadgeEntity } from "./badge-entity.js";

async function mount(props: Partial<KioskBadgeEntity>): Promise<KioskBadgeEntity> {
  const el = document.createElement("kiosk-badge-entity") as KioskBadgeEntity;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("kiosk-badge-entity", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders name and state", async () => {
    const el = await mount({ name: "Audrey iPhone", state: "87", unit: "%" });
    expect(el.textContent).toContain("Audrey iPhone");
    expect(el.textContent).toContain("87%");
  });

  it("renders n/a for unavailable state", async () => {
    const el = await mount({ name: "Wagner Alarm", state: "unavailable" });
    expect(el.textContent).toContain("n/a");
  });

  it("renders n/a for unknown state", async () => {
    const el = await mount({ name: "Audrey", state: "unknown" });
    expect(el.textContent).toContain("n/a");
  });

  it("flags unavailable state via data-unavailable for CSS", async () => {
    const el = await mount({ name: "X", state: "unavailable" });
    expect(el.querySelector("[data-unavailable='true']")).toBeTruthy();
  });

  it("falls back to the entity id when no name is set", async () => {
    const el = await mount({ entityId: "person.audrey", state: "home" });
    expect(el.textContent).toContain("person.audrey");
  });
});
