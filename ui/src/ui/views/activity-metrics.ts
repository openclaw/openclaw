import { html, nothing } from "lit";
import type { ActivityMetrics } from "../activity/activity-types.ts";

function renderSparkline(data: number[]) {
  if (data.length < 2) {
    return nothing;
  }

  const max = Math.max(...data, 1);
  const width = 60;
  const height = 20;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - (v / max) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return html`
    <svg class="activity-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${points}" />
    </svg>
  `;
}

export type ActivityMetricsBarProps = {
  metrics: ActivityMetrics;
  toolCallsHistory: number[];
  errorsHistory: number[];
  activeRunsHistory: number[];
};

function renderMetricCard(
  label: string,
  value: number | string,
  sparklineData: number[],
  active = false,
  isError = false,
) {
  return html`
    <div
      class="activity-metric-card ${active ? "activity-metric-card--active" : ""} ${isError
        ? "activity-metric-card--error"
        : ""}"
    >
      <div class="activity-metric-card__top">
        <span class="activity-metric-card__value">${value}</span>
        ${renderSparkline(sparklineData)}
      </div>
      <span class="activity-metric-card__label muted">${label}</span>
    </div>
  `;
}

export function renderActivityMetrics(props: ActivityMetricsBarProps) {
  const { metrics } = props;

  return html`
    <div class="activity-metrics-bar">
      ${renderMetricCard(
        "Active Runs",
        metrics.activeRuns,
        props.activeRunsHistory,
        metrics.activeRuns > 0,
      )}
      ${renderMetricCard(
        "Tool Calls",
        metrics.totalToolCalls,
        props.toolCallsHistory,
        metrics.activeTools > 0,
      )}
      ${renderMetricCard(
        "Errors",
        metrics.totalErrors,
        props.errorsHistory,
        false,
        metrics.totalErrors > 0,
      )}
      ${renderMetricCard("Completed", metrics.completedNodes, [], false)}
    </div>
  `;
}
