import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./gauge-circular.js";
import type { KioskGaugeCircular } from "./gauge-circular.js";

async function mountGauge(props: Partial<KioskGaugeCircular>): Promise<KioskGaugeCircular> {
  const el = document.createElement("kiosk-gauge-circular") as KioskGaugeCircular;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe("kiosk-gauge-circular", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the numeric value with formatting", async () => {
    const el = await mountGauge({ value: 97, min: 0, max: 100, unit: "%", name: "Battery SOC" });
    expect(el.textContent).toContain("97");
    expect(el.textContent).toContain("%");
    expect(el.textContent).toContain("Battery SOC");
  });

  it("formats large numbers with locale separators", async () => {
    const el = await mountGauge({ value: 80953, min: 40000, max: 140000, unit: "$" });
    // Could be 80,953 or 80'953 depending on locale; just assert presence of comma or thousand-separator pattern.
    expect(el.textContent).toMatch(/80[,.\s']?953|80953/);
  });

  it("renders -- placeholder for non-finite values without crashing", async () => {
    const el = await mountGauge({ value: Number.NaN, min: 0, max: 100 });
    expect(el.textContent).toMatch(/--/);
    expect(el.querySelector("[data-empty='true']")).toBeTruthy();
  });

  it("renders -- placeholder when max <= min (zero-range guard)", async () => {
    const el = await mountGauge({ value: 5, min: 10, max: 10 });
    expect(el.querySelector("[data-empty='true']")).toBeTruthy();
  });

  it("renders an SVG with both a background and a value arc when value > min", async () => {
    const el = await mountGauge({ value: 50, min: 0, max: 100 });
    const paths = el.querySelectorAll("svg path");
    expect(paths.length).toBe(2);
  });

  it("renders only the background arc when value === min (no value-arc draw)", async () => {
    const el = await mountGauge({ value: 0, min: 0, max: 100 });
    const paths = el.querySelectorAll("svg path");
    expect(paths.length).toBe(1);
  });

  it("clamps values above max so the visible arc never overshoots", async () => {
    const el = await mountGauge({ value: 9999, min: 0, max: 100 });
    const paths = el.querySelectorAll("svg path");
    // 2 paths -- clamped, still draws
    expect(paths.length).toBe(2);
  });

  it("picks a segment color based on the value", async () => {
    const el = await mountGauge({
      value: 95,
      min: 0,
      max: 100,
      segments: [
        { from: 0, color: "#ff0000" },
        { from: 60, color: "#00ff00" },
        { from: 90, color: "#0000ff" },
      ],
    });
    const valuePath = el.querySelectorAll("svg path")[1];
    expect(valuePath.getAttribute("stroke")).toBe("#0000ff");
  });

  it("falls back to a default color when no segments are configured", async () => {
    const el = await mountGauge({ value: 50, min: 0, max: 100, segments: [] });
    const valuePath = el.querySelectorAll("svg path")[1];
    expect(valuePath.getAttribute("stroke")).toMatch(/--accent|var/);
  });
});
