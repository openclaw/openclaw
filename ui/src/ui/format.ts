import { formatDurationHuman } from "../../../src/infra/format-time/format-duration.ts";
import { formatRelativeTimestamp } from "../../../src/infra/format-time/format-relative.ts";
import { stripAssistantInternalScaffolding } from "../../../src/shared/text/assistant-visible-text.js";

export { formatRelativeTimestamp, formatDurationHuman };

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

// ANSI/control-character sanitization
//
// Tool outputs (especially CLI commands) often include ANSI escape sequences for colors,
// cursor movement, etc. Those can render as noisy "[31m" fragments in the web UI,
// and they can also confuse markdown (e.g. `src/**/*.test.ts`).
//
// We strip ANSI and normalize newlines for consistent display across OS/tooling.

export function stripAnsi(value: string): string {
  // Based on the widely-used strip-ansi patterns (CSI + OSC).
  // - CSI: ESC [ ... cmd
  // - OSC: ESC ] ... BEL or ST
  // eslint-disable-next-line no-control-regex
  const csi = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nq-uy=><]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
  return value.replace(osc, "").replace(csi, "");
}

export function normalizeTerminalText(value: string): string {
  // Normalize Windows newlines and progress-style CR updates.
  let out = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

  // First pass: remove proper ANSI sequences (ESC-prefixed).
  out = stripAnsi(out);

  // Second pass: some pipelines drop the ESC char but leave the rest of the SGR sequence,
  // resulting in noisy fragments like "[31m" in the UI. Strip those too.
  // Only remove sequences that start with '[' followed by digits/semicolons and a final letter.
  out = out.replace(/\[(?:\d{1,4}(?:;\d{0,4})*)[A-Za-z]/g, "");

  // Drop other control chars (keep \n and \t).
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "");
  return out;
}
