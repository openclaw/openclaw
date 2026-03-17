import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { buildMissionSnapshot } from "../mission-control/store.ts";
import { renderProvenanceSummary } from "./mission-provenance.ts";

export function renderMissionOverview(state: AppViewState) {
  const snapshot = buildMissionSnapshot(state);
  const active = snapshot.workItems[0];
  if (!snapshot.featureEnabled) {
    return html`
      <section class="callout">Mission Control is disabled by feature flag.</section>
    `;
  }
  return html`
    ${renderProvenanceSummary(Object.values(snapshot.provenance))}
    <section class="card-grid two-up">
      <article class="card"><h3>Mission Health</h3><p>${snapshot.missionHealthScore} (${snapshot.runtimeHealth.toUpperCase()}) <span class="pill">${snapshot.provenance.mission}</span></p></article>
      <article class="card"><h3>Active Phase</h3><p>${active?.stage ?? "none"}</p></article>
      <article class="card"><h3>Pending Handoffs</h3><p>${snapshot.pendingHandoffs} <span class="pill">${snapshot.provenance.handoffs}</span></p></article>
      <article class="card"><h3>Pending Approvals</h3><p>${snapshot.pendingApprovals} <span class="pill">${snapshot.provenance.approvals}</span></p></article>
      <article class="card"><h3>Review Debt</h3><p>${snapshot.workItems.filter((w) => w.reviewDebt).length} <span class="pill">${snapshot.provenance.workItems}</span></p></article>
      <article class="card"><h3>System Health</h3><p>${snapshot.runtimeHealth} <span class="pill">${snapshot.provenance.sessions}</span></p></article>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Pending Handoffs</h3>
      <ul>
        ${snapshot.handoffs.map((h) => html`<li>${h.from} → ${h.to} (${h.status}) · ${h.requiredArtifacts.join(", ")} · <em>${h.linkage}</em></li>`)}
      </ul>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Memory Records <span class="pill">${snapshot.provenance.memory}</span></h3>
      <ul>
        ${snapshot.memoryRecords.map((m) => html`<li>${m.title} · ${m.confidence} · <em>${m.linkage}</em></li>`)}
      </ul>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Timeline (handoffs + artifacts + memory)</h3>
      <ul>
        ${snapshot.timeline.map(
          (event) => html`<li>
            <strong>${event.kind}</strong> · ${event.title} · ${event.detail}
            ${event.workItemId ? ` · workItem=${event.workItemId}` : ""}
            · <span class="pill">${event.provenance}</span> · <em>${event.linkage}</em>
          </li>`,
        )}
      </ul>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Linkage Coverage</h3>
      <ul>
        <li>work items: explicit ${snapshot.linkageCoverage.workItemsExplicit} / inferred ${snapshot.linkageCoverage.workItemsInferred}</li>
        <li>handoffs: explicit ${snapshot.linkageCoverage.handoffsExplicit} / inferred ${snapshot.linkageCoverage.handoffsInferred}</li>
        <li>memory: explicit ${snapshot.linkageCoverage.memoryExplicit} / inferred ${snapshot.linkageCoverage.memoryInferred}</li>
        <li>artifacts: explicit ${snapshot.linkageCoverage.artifactsExplicit} / inferred ${snapshot.linkageCoverage.artifactsInferred}</li>
      </ul>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Adapter Notes</h3>
      <ul>
        ${
          snapshot.adapterNotes.length
            ? snapshot.adapterNotes.map((n) => html`<li>${n}</li>`)
            : html`
                <li>All configured project adapters are currently hydrated.</li>
              `
        }
      </ul>
    </section>
    <section class="callout" style="margin-top:12px;">
      <strong>Next Action:</strong> ${active?.requiredArtifact ?? "No active work item"}
    </section>
  `;
}
