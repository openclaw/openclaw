import { html } from "lit";
import type { AppViewState } from "../app-view-state.ts";
import { buildMissionSnapshot } from "../mission-control/store.ts";
import { renderProvenanceSummary } from "./mission-provenance.ts";

export function renderMissionSystems(state: AppViewState) {
  const snapshot = buildMissionSnapshot(state);
  if (!snapshot.featureEnabled) {
    return html`
      <section class="callout">Mission Control is disabled by feature flag.</section>
    `;
  }
  return html`
    ${renderProvenanceSummary(Object.values(snapshot.provenance))}
    <section class="card" style="margin-bottom:12px;">
      <strong>Session signal:</strong> <span class="pill">${snapshot.provenance.sessions}</span>
      · <strong>Approvals signal:</strong> <span class="pill">${snapshot.provenance.approvals}</span>
      · <strong>Cron signal:</strong> <span class="pill">${snapshot.provenance.cron}</span>
      · <strong>Logs signal:</strong> <span class="pill">${snapshot.provenance.logs}</span>
      · <strong>Models signal:</strong> <span class="pill">${snapshot.provenance.models}</span>
    </section>
    <section class="card-grid two-up">
      <article class="card"><h3>Gateway</h3><p>${state.connected ? "online" : "offline"} <span class="pill">${snapshot.provenance.mission}</span></p></article>
      <article class="card"><h3>Sessions</h3><p>${snapshot.systems.sessions.count} total / ${snapshot.systems.sessions.activeAgentSessions} agent <span class="pill">${snapshot.provenance.sessions}</span></p></article>
      <article class="card"><h3>Cron</h3><p>${snapshot.systems.cron.enabled === null ? "unknown" : snapshot.systems.cron.enabled ? "enabled" : "disabled"} · ${snapshot.systems.cron.jobCount} jobs · ${snapshot.systems.cron.failingJobCount} failing <span class="pill">${snapshot.provenance.cron}</span></p></article>
      <article class="card"><h3>Models</h3><p>${snapshot.systems.models.count} models / ${snapshot.systems.models.providerCount} providers <span class="pill">${snapshot.provenance.models}</span></p></article>
      <article class="card"><h3>Approvals</h3><p>${snapshot.systems.approvals.loading ? "loading" : "ready"} (${snapshot.systems.approvals.dirty ? "dirty" : "clean"}) · ${snapshot.systems.approvals.pendingCount} queued <span class="pill">${snapshot.provenance.approvals}</span></p></article>
      <article class="card"><h3>Logs</h3><p>${snapshot.systems.logs.entryCount} entries / ${snapshot.systems.logs.errorCount} errors <span class="pill">${snapshot.provenance.logs}</span></p></article>
      <article class="card"><h3>Recent Errors</h3><p>${state.lastError ? "present" : "none"}</p></article>
    </section>
    <section class="card" style="margin-top:12px;">
      <h3>Audit Trail (dashboard mutations)</h3>
      <ul>
        ${snapshot.auditTrail.map(
          (entry) => html`<li>
            <strong>${entry.action}</strong> · ${entry.summary} · <em>${entry.source}</em>
            · <span class="pill">${entry.provenance}</span>
          </li>`,
        )}
      </ul>
    </section>
  `;
}
