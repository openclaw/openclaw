import SHARED_TOOL_DISPLAY_JSON from "../../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import {
  defaultTitle,
  formatToolDetailText,
  normalizeToolName,
  resolveActionArg,
  resolveToolVerbAndDetail,
  type ToolDisplaySpec as ToolDisplaySpecBase,
} from "../../../src/agents/tool-display-common.js";
import type { IconName } from "./icons.ts";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  icon?: string;
};

type SharedToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

type SharedToolDisplayConfig = {
  version?: number;
  fallback?: SharedToolDisplaySpec;
  tools?: Record<string, SharedToolDisplaySpec>;
};

export type ToolDisplay = {
  name: string;
  icon: IconName;
  title: string;
  label: string;
  verb?: string;
  detail?: string;
};

const EMOJI_ICON_MAP: Record<string, IconName> = {
  "🧩": "puzzle",
  "🛠️": "wrench",
  "🧰": "wrench",
  "📖": "fileText",
  "✍️": "edit",
  "📝": "penLine",
  "📎": "paperclip",
  "🌐": "globe",
  "📺": "monitor",
  "🧾": "fileText",
  "🔐": "settings",
  "💻": "monitor",
  "🔌": "plug",
  "💬": "messageSquare",
};

const SLACK_SPEC: ToolDisplaySpec = {
  icon: "messageSquare",
  title: "Slack",
  actions: {
    react: { label: "react", detailKeys: ["channelId", "messageId", "emoji"] },
    reactions: { label: "reactions", detailKeys: ["channelId", "messageId"] },
    sendMessage: { label: "send", detailKeys: ["to", "content"] },
    editMessage: { label: "edit", detailKeys: ["channelId", "messageId"] },
    deleteMessage: { label: "delete", detailKeys: ["channelId", "messageId"] },
    readMessages: { label: "read messages", detailKeys: ["channelId", "limit"] },
    pinMessage: { label: "pin", detailKeys: ["channelId", "messageId"] },
    unpinMessage: { label: "unpin", detailKeys: ["channelId", "messageId"] },
    listPins: { label: "list pins", detailKeys: ["channelId"] },
    memberInfo: { label: "member", detailKeys: ["userId"] },
    emojiList: { label: "emoji list" },
  },
};

function iconForEmoji(emoji?: string): IconName {
  if (!emoji) {
    return "puzzle";
  }
  return EMOJI_ICON_MAP[emoji] ?? "puzzle";
}

function convertSpec(spec?: SharedToolDisplaySpec): ToolDisplaySpec {
  return {
    icon: iconForEmoji(spec?.emoji),
    title: spec?.title,
    label: spec?.label,
    detailKeys: spec?.detailKeys,
    actions: spec?.actions,
  };
}

const SHARED_TOOL_DISPLAY_CONFIG = SHARED_TOOL_DISPLAY_JSON as SharedToolDisplayConfig;
const FALLBACK = convertSpec(SHARED_TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" });
const TOOL_MAP: Record<string, ToolDisplaySpec> = Object.fromEntries(
  Object.entries(SHARED_TOOL_DISPLAY_CONFIG.tools ?? {}).map(([key, spec]) => [
    key,
    convertSpec(spec),
  ]),
);
TOOL_MAP.slack = SLACK_SPEC;

function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }

  // Browser-safe home shortening: avoid importing Node-only helpers (keeps Vite builds working in Docker/CI).
  const patterns = [
    { re: /^\/Users\/[^/]+(\/|$)/, replacement: "~$1" }, // macOS
    { re: /^\/home\/[^/]+(\/|$)/, replacement: "~$1" }, // Linux
    { re: /^C:\\Users\\[^\\]+(\\|$)/i, replacement: "~$1" }, // Windows
  ] as const;

  for (const pattern of patterns) {
    if (pattern.re.test(input)) {
      return input.replace(pattern.re, pattern.replacement);
    }
  }

  return input;
}

export function resolveToolDisplay(params: {
  name?: string;
  args?: unknown;
  meta?: string;
}): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = name.toLowerCase();
  const spec = TOOL_MAP[key];
  const icon = (spec?.icon ?? FALLBACK.icon ?? "puzzle") as IconName;
  const title = spec?.title ?? defaultTitle(name);
  const label = spec?.label ?? title;
  const action = resolveActionArg(params.args);
  let { verb, detail } = resolveToolVerbAndDetail({
    toolKey: key,
    args: params.args,
    meta: params.meta,
    action,
    spec,
    fallbackDetailKeys: FALLBACK.detailKeys,
    detailMode: "first",
    detailCoerce: { includeFalse: true, includeZero: true },
  });

  if (detail) {
    detail = shortenHomeInString(detail);
  }

  return {
    name,
    icon,
    title,
    label,
    verb,
    detail,
  };
}

export function formatToolDetail(display: ToolDisplay): string | undefined {
  return formatToolDetailText(display.detail, { prefixWithWith: true });
}

export function formatToolSummary(display: ToolDisplay): string {
  const detail = formatToolDetail(display);
  return detail ? `${display.label}: ${detail}` : display.label;
}
