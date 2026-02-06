import { configureLocalization } from "@lit/localize";

const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const { getLocale, setLocale } = configureLocalization({
  sourceLocale: "en",
  targetLocales: ["zh-CN"],
  loadLocale: async (locale: string) => {
    switch (locale) {
      case "zh-CN":
        return import("../locales/zh-CN.js");
      case "en":
      default:
        return import("../locales/en.js");
    }
  },
});

export function normalizeLocale(next: string | null | undefined): SupportedLocale {
  if (next === "zh-CN") {
    return "zh-CN";
  }
  return "en";
}

export const supportedLocales = SUPPORTED_LOCALES;
