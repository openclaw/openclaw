/**
 * Config presets — opinionated configuration bundles that set multiple
 * settings at once. Applied via config.patch.
 */

import { viDashboardText as uiText } from "../vi-dashboard-text.ts";

export type ConfigPresetId = "personal" | "codeAgent" | "teamBot" | "minimal";

export type ConfigPresetPatch = {
  agents: {
    defaults: {
      bootstrapMaxChars: number;
      bootstrapTotalMaxChars: number;
      contextInjection: "always" | "continuation-skip";
    };
  };
};

export type ConfigPreset = {
  id: ConfigPresetId;
  label: string;
  description: string;
  detail: string;
  impact: string;
  icon: string;
  patch: ConfigPresetPatch;
};

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "personal",
    get label() {
      return uiText("Personal Assistant", "Trợ lý cá nhân");
    },
    get description() {
      return uiText("Balanced default for daily use.", "Mặc định cân bằng cho dùng hằng ngày.");
    },
    get detail() {
      return uiText(
        "Good fit for chat, docs, and light edits without a large coding budget.",
        "Phù hợp cho chat, tài liệu và chỉnh sửa nhẹ mà không cần ngân sách context lớn.",
      );
    },
    get impact() {
      return uiText(
        "Injects bootstrap context every turn with a moderate prompt budget.",
        "Inject bootstrap context ở mỗi lượt với ngân sách prompt vừa phải.",
      );
    },
    icon: "✨",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 20_000,
          bootstrapTotalMaxChars: 150_000,
          contextInjection: "always",
        },
      },
    },
  },
  {
    id: "codeAgent",
    get label() {
      return uiText("Code Agent", "Agent code");
    },
    get description() {
      return uiText(
        "Highest context budget for repo work.",
        "Ngân sách context cao nhất cho công việc repo.",
      );
    },
    get detail() {
      return uiText(
        "Best for multi-file changes, long bootstrap docs, and code-heavy sessions.",
        "Tốt nhất cho thay đổi nhiều file, bootstrap docs dài và phiên nặng về code.",
      );
    },
    get impact() {
      return uiText(
        "Uses the largest prompt budget and reinjects context every turn.",
        "Dùng ngân sách prompt lớn nhất và reinject context ở mỗi lượt.",
      );
    },
    icon: "🛠️",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 50_000,
          bootstrapTotalMaxChars: 300_000,
          contextInjection: "always",
        },
      },
    },
  },
  {
    id: "teamBot",
    get label() {
      return uiText("Team Bot", "Bot nhóm");
    },
    get description() {
      return uiText("Lean follow-ups for shared bots.", "Follow-up gọn cho bot dùng chung.");
    },
    get detail() {
      return uiText(
        "Best for multi-channel workflows where continuity matters more than large bootstrap payloads.",
        "Phù hợp workflow nhiều kênh, khi tính liên tục quan trọng hơn payload bootstrap lớn.",
      );
    },
    get impact() {
      return uiText(
        "Keeps follow-up turns smaller by skipping safe continuation reinjection.",
        "Giữ các lượt follow-up nhỏ hơn bằng cách bỏ qua reinjection an toàn khi đang tiếp nối.",
      );
    },
    icon: "👥",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 10_000,
          bootstrapTotalMaxChars: 80_000,
          contextInjection: "continuation-skip",
        },
      },
    },
  },
  {
    id: "minimal",
    get label() {
      return uiText("Minimal", "Tối giản");
    },
    get description() {
      return uiText(
        "Smallest context budget and lowest cost.",
        "Ngân sách context nhỏ nhất và chi phí thấp nhất.",
      );
    },
    get detail() {
      return uiText(
        "Best for quick utility turns, automations, and cost-sensitive workflows.",
        "Phù hợp lượt xử lý nhanh, tự động hóa và workflow nhạy về chi phí.",
      );
    },
    get impact() {
      return uiText(
        "Uses the smallest bootstrap budget and the leanest follow-up behavior.",
        "Dùng ngân sách bootstrap nhỏ nhất và hành vi follow-up gọn nhất.",
      );
    },
    icon: "⚡",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 5_000,
          bootstrapTotalMaxChars: 30_000,
          contextInjection: "continuation-skip",
        },
      },
    },
  },
];

export function getPresetById(id: ConfigPresetId): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.id === id);
}

/**
 * Detect which preset (if any) matches the current config values.
 */
export function detectActivePreset(config: Record<string, unknown>): ConfigPresetId | null {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  if (!defaults) {
    return null;
  }
  const maxChars = defaults.bootstrapMaxChars;
  const totalMax = defaults.bootstrapTotalMaxChars;
  const contextInjection = defaults.contextInjection;
  for (const preset of CONFIG_PRESETS) {
    const presetDefaults = (preset.patch.agents as Record<string, unknown>)?.defaults as
      | Record<string, unknown>
      | undefined;
    if (!presetDefaults) {
      continue;
    }
    if (
      maxChars === presetDefaults.bootstrapMaxChars &&
      totalMax === presetDefaults.bootstrapTotalMaxChars &&
      contextInjection === presetDefaults.contextInjection
    ) {
      return preset.id;
    }
  }
  return null;
}
