import { formatDurationHuman } from "../../../src/infra/format-time/format-duration.ts";
import {
  formatRelativeTimestamp as formatRelativeTimestampBase,
  formatTimeAgo as formatTimeAgoBase,
} from "../../../src/infra/format-time/format-relative.ts";
import { stripAssistantInternalScaffolding } from "../../../src/shared/text/assistant-visible-text.js";
import { t } from "../i18n/lib/translate.ts";

export { formatRelativeTimestampBase, formatDurationHuman };

/* ⏰ 获取时间翻译 */
function getTimeTranslations() {
  return {
    justNow: t("time.justNow"),
    secondsAgo: t("time.secondsAgo"),
    minutesAgo: t("time.minutesAgo"),
    hoursAgo: t("time.hoursAgo"),
    daysAgo: t("time.daysAgo"),
    inMinutes: t("time.inMinutes"),
    inHours: t("time.inHours"),
    inDays: t("time.inDays"),
    lessThanMinute: t("time.lessThanMinute"),
    unknown: t("time.unknown"),
  };
}

/* ⏰ 格式化相对时间戳（带国际化） */
export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options?: { dateFallback?: boolean; timezone?: string; fallback?: string },
): string {
  const fallback = options?.fallback ?? t("channels.statusNa");
  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return fallback;
  }

  const trans = getTimeTranslations();
  const diff = Date.now() - timestampMs;
  const absDiff = Math.abs(diff);
  const isPast = diff >= 0;

  const sec = Math.round(absDiff / 1000);
  if (sec < 60) {
    return isPast ? trans.justNow : trans.lessThanMinute;
  }

  const min = Math.round(sec / 60);
  if (min < 60) {
    return isPast ? trans.minutesAgo.replace("{n}", String(min)) : trans.inMinutes.replace("{n}", String(min));
  }

  const hr = Math.round(min / 60);
  if (hr < 48) {
    return isPast ? trans.hoursAgo.replace("{n}", String(hr)) : trans.inHours.replace("{n}", String(hr));
  }

  const day = Math.round(hr / 24);
  if (!options?.dateFallback || day <= 7) {
    return isPast ? trans.daysAgo.replace("{n}", String(day)) : trans.inDays.replace("{n}", String(day));
  }

  // Fall back to short date display for old timestamps
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      ...(options.timezone ? { timeZone: options.timezone } : {}),
    }).format(new Date(timestampMs));
  } catch {
    return trans.daysAgo.replace("{n}", String(day));
  }
}

/* ⏰ 格式化时间前（带国际化） */
export function formatTimeAgo(
  durationMs: number | null | undefined,
  options?: { suffix?: boolean; fallback?: string },
): string {
  const suffix = options?.suffix !== false;
  const fallback = options?.fallback ?? t("time.unknown");

  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return fallback;
  }

  const trans = getTimeTranslations();
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.round(totalSeconds / 60);

  if (minutes < 1) {
    return suffix ? trans.justNow : `${totalSeconds}${t("time.secondsSuffix")}`;
  }
  if (minutes < 60) {
    return suffix
      ? trans.minutesAgo.replace("{n}", String(minutes))
      : `${minutes}${t("time.minutesSuffix")}`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return suffix
      ? trans.hoursAgo.replace("{n}", String(hours))
      : `${hours}${t("time.hoursSuffix")}`;
  }
  const days = Math.round(hours / 24);
  return suffix
    ? trans.daysAgo.replace("{n}", String(days))
    : `${days}${t("time.daysSuffix")}`;
}

export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return "n/a";
  }
  return new Date(ms).toLocaleString();
}

export function formatList(values?: Array<string | null | undefined>): string {
  if (!values || values.length === 0) {
    return "none";
  }
  return values.filter((v): v is string => Boolean(v && v.trim())).join(", ");
}

export function clampText(value: string, max = 120): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function truncateText(
  value: string,
  max: number,
): {
  text: string;
  truncated: boolean;
  total: number;
} {
  if (value.length <= max) {
    return { text: value, truncated: false, total: value.length };
  }
  return {
    text: value.slice(0, Math.max(0, max)),
    truncated: true,
    total: value.length,
  };
}

export function toNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function stripThinkingTags(value: string): string {
  return stripAssistantInternalScaffolding(value);
}

export function formatCost(cost: number | null | undefined, fallback = "$0.00"): string {
  if (cost == null || !Number.isFinite(cost)) {
    return fallback;
  }
  if (cost === 0) {
    return "$0.00";
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(tokens: number | null | undefined, fallback = "0"): string {
  if (tokens == null || !Number.isFinite(tokens)) {
    return fallback;
  }
  if (tokens < 1000) {
    return String(Math.round(tokens));
  }
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = tokens / 1_000_000;
  return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

export function formatPercent(value: number | null | undefined, fallback = "—"): string {
  if (value == null || !Number.isFinite(value)) {
    return fallback;
  }
  return `${(value * 100).toFixed(1)}%`;
}
