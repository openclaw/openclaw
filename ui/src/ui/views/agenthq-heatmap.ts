import { html, type TemplateResult } from "lit";
import type { AgentHQStatsResult } from "../types.ts";
import { renderIcon } from "../icons.ts";

export type AgentHQHeatmapProps = {
  stats: AgentHQStatsResult | null;
  loading: boolean;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getActivityLevel(count: number, maxCount: number): number {
  if (count === 0) {
    return 0;
  }
  const ratio = count / maxCount;
  if (ratio >= 0.75) {
    return 4;
  }
  if (ratio >= 0.5) {
    return 3;
  }
  if (ratio >= 0.25) {
    return 2;
  }
  return 1;
}

function generateHeatmapData(stats: AgentHQStatsResult): Array<{
  date: string;
  count: number;
  level: number;
  weekIndex: number;
  dayIndex: number;
}> {
  const activityMap = new Map<string, number>();
  const maxCount = Math.max(...stats.activityByDay.map((d) => d.count), 1);

  for (const day of stats.activityByDay) {
    activityMap.set(day.date, day.count);
  }

  // Generate last 52 weeks of data
  const today = new Date();
  const result: Array<{
    date: string;
    count: number;
    level: number;
    weekIndex: number;
    dayIndex: number;
  }> = [];

  // Go back to the start of the week containing 52 weeks ago
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364 - startDate.getDay());

  let currentDate = new Date(startDate);
  let weekIndex = 0;

  while (currentDate <= today) {
    const dateStr = currentDate.toISOString().split("T")[0];
    const count = activityMap.get(dateStr) ?? 0;
    const dayIndex = currentDate.getDay();

    result.push({
      date: dateStr,
      count,
      level: getActivityLevel(count, maxCount),
      weekIndex,
      dayIndex,
    });

    currentDate.setDate(currentDate.getDate() + 1);
    if (currentDate.getDay() === 0 && currentDate <= today) {
      weekIndex++;
    }
  }

  return result;
}

function formatDuration(firstTs: number | null, lastTs: number | null): string {
  if (!firstTs || !lastTs) {
    return "No activity";
  }
  const diff = lastTs - firstTs;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) {
    return "Today";
  }
  if (days === 1) {
    return "1 day";
  }
  if (days < 30) {
    return `${days} days`;
  }
  const months = Math.floor(days / 30);
  if (months === 1) {
    return "1 month";
  }
  if (months < 12) {
    return `${months} months`;
  }
  const years = Math.floor(months / 12);
  return years === 1 ? "1 year" : `${years} years`;
}

export function renderAgentHQHeatmap(props: AgentHQHeatmapProps): TemplateResult {
  if (props.loading) {
    return html`
      <div class="agenthq-loading">
        <div class="agenthq-loading-spinner"></div>
        <div class="agenthq-loading-text">Loading activity data...</div>
      </div>
    `;
  }

  if (!props.stats) {
    return html`
      <div class="agenthq-empty">
        ${renderIcon("calendar", "agenthq-empty-icon")}
        <div class="agenthq-empty-title">No Activity Data</div>
        <div class="agenthq-empty-desc">Activity statistics are not available for this agent.</div>
      </div>
    `;
  }

  const heatmapData = generateHeatmapData(props.stats);
  const weeks = groupByWeek(heatmapData);
  const monthLabels = getMonthLabels(heatmapData);

  return html`
    <div class="agenthq-heatmap">
      <div class="agenthq-heatmap-header">
        <div class="agenthq-heatmap-title">Activity over the past year</div>
        <div class="agenthq-heatmap-legend">
          <span>Less</span>
          <div class="agenthq-heatmap-legend-bar">
            ${[0, 1, 2, 3, 4].map(
              (level) =>
                html`<div
                  class="agenthq-heatmap-legend-cell agenthq-heatmap-day level-${level}"
                ></div>`,
            )}
          </div>
          <span>More</span>
        </div>
      </div>

      <div class="agenthq-heatmap-months">
        ${monthLabels.map((label) => html`<div class="agenthq-heatmap-month">${label.name}</div>`)}
      </div>

      <div class="agenthq-heatmap-container">
        <div class="agenthq-heatmap-weekdays">
          ${WEEKDAYS.filter((_, i) => i % 2 === 1).map(
            (day) => html`<div class="agenthq-heatmap-weekday">${day}</div>`,
          )}
        </div>

        <div class="agenthq-heatmap-grid">
          ${weeks.map(
            (week) => html`
              <div class="agenthq-heatmap-week">
                ${week.map(
                  (day) =>
                    html`<div
                      class="agenthq-heatmap-day level-${day?.level ?? 0}"
                      title="${day?.date ?? ""}: ${day?.count ?? 0} changes"
                    ></div>`,
                )}
              </div>
            `,
          )}
        </div>
      </div>

      <div class="agenthq-heatmap-stats">
        <div class="agenthq-heatmap-stat">
          <div class="agenthq-heatmap-stat-value">${props.stats.totalCommits}</div>
          <div class="agenthq-heatmap-stat-label">Total Changes</div>
        </div>
        <div class="agenthq-heatmap-stat">
          <div class="agenthq-heatmap-stat-value">
            ${Object.keys(props.stats.filesChanged).length}
          </div>
          <div class="agenthq-heatmap-stat-label">Files Modified</div>
        </div>
        <div class="agenthq-heatmap-stat">
          <div class="agenthq-heatmap-stat-value">
            ${formatDuration(props.stats.firstChangeAt, props.stats.lastChangeAt)}
          </div>
          <div class="agenthq-heatmap-stat-label">Active Period</div>
        </div>
        <div class="agenthq-heatmap-stat">
          <div class="agenthq-heatmap-stat-value">
            ${getMostActiveFile(props.stats.filesChanged)}
          </div>
          <div class="agenthq-heatmap-stat-label">Most Changed File</div>
        </div>
      </div>
    </div>
  `;
}

function groupByWeek(
  data: Array<{
    date: string;
    count: number;
    level: number;
    weekIndex: number;
    dayIndex: number;
  }>,
): Array<
  Array<{ date: string; count: number; level: number; weekIndex: number; dayIndex: number } | null>
> {
  const weeks: Array<
    Array<{
      date: string;
      count: number;
      level: number;
      weekIndex: number;
      dayIndex: number;
    } | null>
  > = [];

  for (const day of data) {
    while (weeks.length <= day.weekIndex) {
      weeks.push([null, null, null, null, null, null, null]);
    }
    weeks[day.weekIndex][day.dayIndex] = day;
  }

  return weeks;
}

function getMonthLabels(
  data: Array<{ date: string; weekIndex: number }>,
): Array<{ name: string; weekIndex: number }> {
  const labels: Array<{ name: string; weekIndex: number }> = [];
  let lastMonth = -1;

  for (const day of data) {
    const month = new Date(day.date).getMonth();
    if (month !== lastMonth) {
      labels.push({ name: MONTHS[month], weekIndex: day.weekIndex });
      lastMonth = month;
    }
  }

  return labels;
}

function getMostActiveFile(filesChanged: Record<string, number>): string {
  const entries = Object.entries(filesChanged);
  if (entries.length === 0) {
    return "None";
  }

  const sorted = entries.toSorted((a, b) => b[1] - a[1]);
  return sorted[0][0].replace(".md", "");
}
