import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { ClaworksHealthSnapshot } from "../claworks-health.ts";

export type ClaworksOverviewCardProps = {
  snapshot: ClaworksHealthSnapshot;
  onRefresh?: () => void;
  onOpenPluginConfig?: () => void;
};

function statusClass(status: string | undefined): string {
  if (status === "ok") {
    return "ok";
  }
  if (status === "degraded") {
    return "warn";
  }
  if (status === "unavailable") {
    return "danger";
  }
  return "";
}

export function renderClaworksOverviewCard(props: ClaworksOverviewCardProps) {
  if (!props.snapshot.enabled) {
    return nothing;
  }

  const snap = props.snapshot;
  const payload = snap.payload;
  const status = payload?.status;
  const statusLabel = snap.loading
    ? t("common.loading")
    : snap.error
      ? t("common.error")
      : status
        ? status.toUpperCase()
        : t("common.na");

  return html`
    <div class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">${t("claworks.overview.title")}</div>
          <div class="card-sub">${t("claworks.overview.subtitle")}</div>
        </div>
        <div class="row" style="gap: 8px;">
          ${props.onOpenPluginConfig
            ? html`
                <button class="btn btn--sm" @click=${props.onOpenPluginConfig}>
                  ${t("claworks.overview.configure")}
                </button>
              `
            : nothing}
          ${props.onRefresh
            ? html`
                <button class="btn btn--sm" ?disabled=${snap.loading} @click=${props.onRefresh}>
                  ${t("common.refresh")}
                </button>
              `
            : nothing}
        </div>
      </div>

      <div class="stat-grid" style="margin-top: 16px;">
        <div class="stat">
          <div class="stat-label">${t("claworks.overview.status")}</div>
          <div class="stat-value ${statusClass(status)}">${statusLabel}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("claworks.overview.robot")}</div>
          <div class="stat-value">${payload?.robot ?? t("common.na")}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("claworks.overview.role")}</div>
          <div class="stat-value">${payload?.role ?? t("common.na")}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${t("claworks.overview.kb")}</div>
          <div class="stat-value">
            ${payload?.kb_provider ?? t("common.na")}${payload?.kb_vector ? " · vector" : ""}
          </div>
        </div>
        ${payload?.kb_embed_model
          ? html`
              <div class="stat">
                <div class="stat-label">${t("claworks.overview.kbEmbed")}</div>
                <div class="stat-value mono">${payload.kb_embed_model}</div>
              </div>
            `
          : nothing}
      </div>

      ${snap.requireApiKey && !snap.hasApiKey
        ? html`
            <div class="callout warn" style="margin-top: 14px;">
              ${t("claworks.overview.missingApiKey")}
            </div>
          `
        : nothing}
      ${snap.error
        ? html`
            <div class="callout danger" style="margin-top: 14px;">
              <div>${snap.error}</div>
              <div class="muted" style="margin-top: 6px;">${t("claworks.overview.authHint")}</div>
            </div>
          `
        : nothing}
      ${!snap.error && payload?.checks && payload.checks.length > 0
        ? html`
            <ul class="muted" style="margin-top: 14px; padding-left: 18px;">
              ${payload.checks.slice(0, 5).map(
                (check) => html`
                  <li>
                    <span class="mono">${check.id}</span>:
                    <span
                      class=${check.status === "error"
                        ? "danger"
                        : check.status === "warn"
                          ? "warn"
                          : ""}
                      >${check.status}</span
                    >
                    ${check.message ? ` — ${check.message}` : nothing}
                  </li>
                `,
              )}
            </ul>
          `
        : nothing}
      ${snap.httpOrigin
        ? html`
            <div class="muted" style="margin-top: 10px;">
              ${t("claworks.overview.probeUrl")}:
              <span class="mono">${snap.httpOrigin}/v1/health</span>
            </div>
          `
        : nothing}
    </div>
  `;
}
