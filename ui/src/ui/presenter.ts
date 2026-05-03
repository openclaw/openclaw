import { t } from "../i18n/index.ts";
import {
  formatRelativeTimestamp,
  formatDurationHuman,
  formatMs,
  formatUnknownText,
} from "./format.ts";
import type { CronJob, GatewaySessionRow, PresenceEntry } from "./types.ts";

export function formatPresenceSummary(entry: PresenceEntry): string {
  const host = entry.host ?? "unknown";
  const ip = entry.ip ? `(${entry.ip})` : "";
  const mode = entry.mode ?? "";
  const version = entry.version ?? "";
  return `${host} ${ip} ${mode} ${version}`.trim();
}

export function formatPresenceAge(entry: PresenceEntry): string {
  const ts = entry.ts ?? null;
  return ts ? formatRelativeTimestamp(ts) : t("common.na");
}

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.na");
  }
  const weekday = new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.na");
  }
  const total = row.totalTokens ?? 0;
  const ctx = row.contextTokens ?? 0;
  return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatEventPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return formatUnknownText(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.na");
  const status = state.lastStatus ?? t("common.na");
  return `${status} · next ${next} · last ${last}`;
}

function parsePositiveCronStep(field: string): number | null {
  const match = field.match(/^\*\/([1-9]\d*)$/);
  if (!match) {
    return null;
  }
  const step = Number(match[1]);
  return Number.isSafeInteger(step) ? step : null;
}

function formatCronIntervalUnit(value: number, unit: "minute" | "hour"): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function formatCommonCronExpression(expr: string): string | null {
  const [minute, hour, dayOfMonth, month, dayOfWeek, extra] = expr.trim().split(/\s+/);
  if (extra !== undefined || !minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    return null;
  }
  if (minute === "0") {
    if (hour === "*") {
      return `Every ${formatCronIntervalUnit(1, "hour")}`;
    }
    const hourStep = parsePositiveCronStep(hour);
    if (hourStep !== null) {
      return `Every ${formatCronIntervalUnit(hourStep, "hour")}`;
    }
  }
  if (hour === "*") {
    const minuteStep = parsePositiveCronStep(minute);
    if (minuteStep !== null) {
      return `Every ${formatCronIntervalUnit(minuteStep, "minute")}`;
    }
  }
  return null;
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs) ? `At ${formatMs(atMs)}` : `At ${s.at}`;
  }
  if (s.kind === "every") {
    return `Every ${formatDurationHuman(s.everyMs)}`;
  }
  const commonCron = formatCommonCronExpression(s.expr);
  if (commonCron) {
    return `${commonCron}${s.tz ? ` (${s.tz})` : ""}`;
  }
  return `Cron ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  if (p.kind === "systemEvent") {
    return `System: ${p.text}`;
  }
  const base = `Agent: ${p.message}`;
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
