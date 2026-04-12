import { formatDurationHuman } from "../../../src/infra/format-time/format-duration.ts";
import { formatRelativeTimestamp } from "../../../src/infra/format-time/format-relative.ts";
import { stripAssistantInternalScaffolding } from "../../../src/shared/text/assistant-visible-text.js";
import { t } from "../i18n/index.ts";

export { formatRelativeTimestamp, formatDurationHuman };

export function formatUnknownText(
  value: unknown,
  opts: { fallback?: string; pretty?: boolean } = {},
): string {
  const fallback = opts.fallback ?? "";
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  try {
    const serialized = JSON.stringify(value, null, opts.pretty ? 2 : undefined);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back when value is not JSON-serializable.
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  return Object.prototype.toString.call(value);
}

export function formatMs(ms?: number | null): string {
  if (!ms && ms !== 0) {
    return t("common.na");
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

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Convert a 5-field cron expression to a short human-readable description.
 * Handles common patterns; falls back to the raw expression for anything exotic.
 */
export function describeCronExpression(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return expr;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every N minutes: *\/N * * * *
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const stepMatch = minute.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const n = Number(stepMatch[1]);
      if (n === 0) {
        return expr;
      }
      return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }
    if (minute === "*") {
      return "Every minute";
    }
  }

  // Every N hours: 0 *\/N * * *  (minute must be a plain number, not a step)
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const hourStep = hour.match(/^\*\/(\d+)$/);
    if (hourStep && /^\d+$/.test(minute)) {
      const n = Number(hourStep[1]);
      if (n === 0) {
        return expr;
      }
      return n === 1 ? "Every hour" : `Every ${n} hours`;
    }
    if (hour === "*" && /^\d+$/.test(minute)) {
      // minute is fixed, hour is *, e.g. "30 * * * *"
      return `Every hour at :${minute.padStart(2, "0")}`;
    }
  }

  // Daily at H:MM — M H * * *
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const h = Number(hour);
    const m = Number(minute);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Daily at ${displayHour}:${String(m).padStart(2, "0")} ${period}`;
    }
  }

  // Weekly on DAY at H:MM — M H * * D
  if (dayOfMonth === "*" && month === "*") {
    const h = Number(hour);
    const m = Number(minute);
    const d = Number(dayOfWeek);
    if (
      Number.isInteger(h) &&
      Number.isInteger(m) &&
      Number.isInteger(d) &&
      h >= 0 &&
      h <= 23 &&
      m >= 0 &&
      m <= 59 &&
      d >= 0 &&
      d <= 7
    ) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `Weekly ${WEEKDAY_NAMES[d % 7]} at ${displayHour}:${String(m).padStart(2, "0")} ${period}`;
    }
  }

  return expr;
}
