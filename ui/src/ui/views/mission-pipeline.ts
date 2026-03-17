import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { buildMissionSnapshot } from "../mission-control/store.ts";
import { renderProvenanceSummary } from "./mission-provenance.ts";

export function renderMissionPipeline(state: AppViewState) {
  const snapshot = buildMissionSnapshot(state);
  if (!snapshot.featureEnabled) {
    return html`
      <section class="callout">Mission Control is disabled by feature flag.</section>
    `;
  }
  return html`
    ${renderProvenanceSummary(Object.values(snapshot.provenance))}
    <section class="card">
      <h3>Pipeline</h3>
      <div class="pill-row">
        ${snapshot.stages.map((stage) => {
          const count = snapshot.workItems.filter((w) => w.stage === stage).length;
          return html`<span class="pill">${stage} (${count})</span>`;
        })}
      </div>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Work Items <span class="pill">${snapshot.provenance.workItems}</span></h3>
      <ul>
        ${snapshot.workItems.map(
          (w) => html`<li>
            <strong>${w.title}</strong> · ${w.stage} · owner=${w.owner}${w.nextOwner ? ` → ${w.nextOwner}` : ""}
            · artifact=${w.requiredArtifact ?? "n/a"}${w.requiredArtifactId ? `#${w.requiredArtifactId}` : ""} (${w.artifactLinkage ?? "inferred"}) · blocker=${w.blocked ? "yes" : "no"}
          </li>`,
        )}
      </ul>
    </section>
  `;
}
