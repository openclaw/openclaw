import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { buildMissionSnapshot } from "../mission-control/store.ts";
import { renderProvenanceSummary } from "./mission-provenance.ts";

export function renderMissionTeam(state: AppViewState) {
  const snapshot = buildMissionSnapshot(state);
  if (!snapshot.featureEnabled) {
    return html`
      <section class="callout">Mission Control is disabled by feature flag.</section>
    `;
  }
  return html`
    ${renderProvenanceSummary(Object.values(snapshot.provenance))}
    <section class="card" style="margin-bottom:12px;"><strong>Memory provenance:</strong> <span class="pill">${snapshot.provenance.memory}</span> · <strong>Sessions:</strong> <span class="pill">${snapshot.provenance.sessions}</span></section>
    <section class="card-grid two-up">
      ${snapshot.agents.map(
        (agent) => html`<article class="card">
          <h3>${agent.displayName}</h3>
          <p>${agent.role}</p>
          <p><strong>Mode:</strong> ${agent.currentMode ?? "n/a"}</p>
          <p><strong>Allowed:</strong> ${agent.allowedModes.join(", ")}</p>
          ${
            agent.guardrailWarnings?.length
              ? html`<p><strong>Guardrails:</strong> ${agent.guardrailWarnings.join("; ")}</p>`
              : html`
                  <p><strong>Guardrails:</strong> clear</p>
                `
          }
        </article>`,
      )}
    </section>
  `;
}
