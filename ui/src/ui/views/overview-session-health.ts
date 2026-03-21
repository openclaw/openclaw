/**
 * Overview — Session Health Card
 *
 * Renders the derived SessionHealthSurface (Layer B) as a compact health
 * card in the Mission Control overview. Shows overall status + individual
 * indicators with health states (healthy/warning/critical).
 *
 * Design principles:
 * - Health states over raw counts
 * - High-signal: ~5 indicators max
 * - Warning/critical states surface as attention items
 * - Graceful when no data exists yet (collector hasn't run)
 */

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { SessionHealthSurface, SessionHealthIndicator, SessionHealthLevel } from "../types.ts";

export type OverviewSessionHealthProps = {
  surface: SessionHealthSurface | null | undefined;
};

// ---------------------------------------------------------------------------
// Level → presentation mapping
// ---------------------------------------------------------------------------

function levelIcon(level: SessionHealthLevel): string {
  switch (level) {
    case "healthy":
      return "✓";
    case "warning":
      return "⚠";
    case "critical":
      return "✗";
    case "stale_data":
      return "⏳";
    case "unknown":
      return "?";
  }
}

function levelClass(level: SessionHealthLevel): string {
  switch (level) {
    case "healthy":
      return "sh-healthy";
    case "warning":
      return "sh-warning";
    case "critical":
      return "sh-critical";
    case "stale_data":
      return "sh-stale";
    case "unknown":
      return "sh-unknown";
  }
}

function levelLabel(level: SessionHealthLevel): string {
  switch (level) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "critical":
      return "Critical";
    case "stale_data":
      return "Stale Data";
    case "unknown":
      return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Indicator row
// ---------------------------------------------------------------------------

function renderIndicator(ind: SessionHealthIndicator) {
  return html`
    <div class="sh-indicator ${levelClass(ind.level)}">
      <span class="sh-indicator__icon">${levelIcon(ind.level)}</span>
      <div class="sh-indicator__body">
        <div class="sh-indicator__label">${ind.label}</div>
        <div class="sh-indicator__summary muted">${ind.summary}</div>
      </div>
      ${ind.valueText ? html`<span class="sh-indicator__value">${ind.valueText}</span>` : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderOverviewSessionHealth(props: OverviewSessionHealthProps) {
  const { surface } = props;

  if (!surface) {
    return nothing; // No data yet — collector hasn't run
  }

  const overall = surface.overallLevel;
  const measuredAt = surface.measuredAt
    ? formatRelativeTimestamp(new Date(surface.measuredAt).getTime())
    : "";

  return html`
    <section class="card sh-card ${levelClass(overall)}">
      <div class="card-title">
        <span>Session Health</span>
        <span class="sh-badge ${levelClass(overall)}">${levelIcon(overall)} ${levelLabel(overall)}</span>
      </div>
      <div class="sh-summary muted">${surface.summary}</div>
      <div class="sh-indicators">
        ${surface.indicators.map(renderIndicator)}
      </div>
      ${measuredAt ? html`<div class="sh-measured muted">Last checked ${measuredAt}</div>` : nothing}
    </section>
  `;
}

/**
 * Extract session health attention items for the overview attention bar.
 *
 * Only surfaces warning/critical indicators — healthy/unknown don't generate
 * attention items to keep the UI high-signal.
 */
export function extractSessionHealthAttentionItems(
  surface: SessionHealthSurface | null | undefined,
): Array<{ severity: "warning" | "error"; icon: string; title: string; description: string }> {
  if (!surface) {
    return [];
  }

  const items: Array<{
    severity: "warning" | "error";
    icon: string;
    title: string;
    description: string;
  }> = [];

  // Overall stale data warning
  if (surface.overallLevel === "stale_data") {
    items.push({
      severity: "warning",
      icon: "clock",
      title: "Session health data is stale",
      description: "The session health collector may have stopped. Check gateway logs.",
    });
    return items; // Don't add per-indicator items when data is stale
  }

  for (const ind of surface.indicators) {
    if (ind.level === "critical") {
      items.push({
        severity: "error",
        icon: indicatorIcon(ind.key),
        title: `Session Health: ${ind.label}`,
        description: ind.summary + (ind.actionHint ? ` — ${ind.actionHint}` : ""),
      });
    } else if (ind.level === "warning") {
      items.push({
        severity: "warning",
        icon: indicatorIcon(ind.key),
        title: `Session Health: ${ind.label}`,
        description: ind.summary + (ind.actionHint ? ` — ${ind.actionHint}` : ""),
      });
    }
  }

  return items;
}

function indicatorIcon(key: string): string {
  switch (key) {
    case "indexHealth":
      return "database";
    case "sessionPressure":
      return "activity";
    case "storagePressure":
      return "hard-drive";
    case "growthTrend":
      return "trending-up";
    case "stalestOrphan":
      return "archive";
    default:
      return "radio";
  }
}
