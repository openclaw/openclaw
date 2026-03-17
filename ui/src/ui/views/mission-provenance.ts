import { html } from "lit";
import type { MissionProvenance } from "../mission-control/types.ts";

export function renderProvenanceSummary(states: MissionProvenance[]) {
  const hasUnavailable = states.includes("unavailable");
  const hasStale = states.includes("stale");
  const hasSeedBacked = states.includes("seed-backed");
  const hasMixed = states.includes("mixed");
  const hasLive = states.includes("live");

  if (hasUnavailable) {
    return html`
      <section class="callout danger">
        Some Mission Control signals are unavailable; fallback data is being used.
      </section>
    `;
  }
  if (hasStale) {
    return html`
      <section class="callout">
        Some Mission Control signals are stale; verify before acting on them.
      </section>
    `;
  }
  if (hasSeedBacked && !hasLive && !hasMixed) {
    return html`
      <section class="callout">Mission Control is currently seed-backed.</section>
    `;
  }
  if (hasMixed) {
    return html`
      <section class="callout">
        Mission Control is running in mixed mode (combining live and non-authoritative signals).
      </section>
    `;
  }
  if (hasLive) {
    return html`
      <section class="callout">Mission Control signals are live.</section>
    `;
  }
  return null;
}
