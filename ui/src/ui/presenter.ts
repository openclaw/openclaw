import type { CronJob, GatewaySessionRow, PresenceEntry } from "./types.ts";
import { t } from "../i18n/i18n";
import { formatAgo, formatDurationMs, formatMs } from "./format.ts";

export function formatPresenceSummary(entry: PresenceEntry): string {
  const host = entry.host ?? t("instances.unknown");
  const ip = entry.ip ? `(${entry.ip})` : "";
  const mode = entry.mode ?? "";
  const version = entry.version ?? "";
  return `${host} ${ip} ${mode} ${version}`.trim();
}

export function formatPresenceAge(entry: PresenceEntry): string {
  const ts = entry.ts ?? null;
  return ts ? formatAgo(ts) : t("common.n_a");
}

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.n_a");
  }
  return `${formatMs(ms)} (${formatAgo(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.n_a");
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
    // oxlint-disable typescript/no-base-to-string
    return String(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.n_a");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.n_a");
  const status = state.lastStatus ?? t("common.n_a");
  return `${status} · next ${next} · last ${last}`;
}

export function formatCronSchedule(job: CronJob) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return Number.isFinite(atMs)
      ? `${t("cron.schedule_at")} ${formatMs(atMs)}`
      : `${t("cron.schedule_at")} ${s.at}`;
  }
  if (s.kind === "every") {
    return `${t("cron.schedule_every")} ${formatDurationMs(s.everyMs)}`;
  }
  return `${t("cron.schedule_cron")} ${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  if (p.kind === "systemEvent") {
    return `${t("cron.payload_system")}: ${p.text}`;
  }
  const base = `${t("cron.payload_agent")}: ${p.message}`;
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.channel || delivery.to
        ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
        : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
