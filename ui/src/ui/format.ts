import { formatDurationHuman } from "../../../src/infra/format-time/format-duration.ts";
import { formatRelativeTimestamp as formatRelativeTimestampBase } from "../../../src/infra/format-time/format-relative.ts";
import { stripReasoningTagsFromText } from "../../../src/shared/text/reasoning-tags.js";
import { getLocale, t } from "./i18n/index.js";

export { formatDurationHuman };

export function formatRelativeTimestamp(
  timestampMs: number | null | undefined,
  options?: Parameters<typeof formatRelativeTimestampBase>[1],
): string {
  const value = formatRelativeTimestampBase(timestampMs, options);
  if (getLocale() !== "pt-BR") {
    return value;
  }
  if (value === "just now") {
    return t("just now");
  }
  const minuteAgo = value.match(/^(\d+)m ago$/);
  if (minuteAgo) {
    return `há ${minuteAgo[1]}m`;
  }
  const hourAgo = value.match(/^(\d+)h ago$/);
  if (hourAgo) {
    return `há ${hourAgo[1]}h`;
  }
  const dayAgo = value.match(/^(\d+)d ago$/);
  if (dayAgo) {
    return `há ${dayAgo[1]}d`;
  }
  const minuteIn = value.match(/^in (\d+)m$/);
  if (minuteIn) {
    return `em ${minuteIn[1]}m`;
  }
  const hourIn = value.match(/^in (\d+)h$/);
  if (hourIn) {
    return `em ${hourIn[1]}h`;
  }
  const dayIn = value.match(/^in (\d+)d$/);
  if (dayIn) {
    return `em ${dayIn[1]}d`;
  }
  if (value === "in <1m") {
    return "em <1m";
  }
  return value;
}

export function translateUiError(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  if (message.toLowerCase() === "pairing required") {
    return t("pairing required");
  }
  return message;
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
  return stripReasoningTagsFromText(value, { mode: "preserve", trim: "start" });
}
