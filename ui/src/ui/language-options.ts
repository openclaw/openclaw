import { SUPPORTED_LOCALES, type Locale } from "../i18n/index.ts";

export const FEATURED_DASHBOARD_LOCALES: readonly Locale[] = ["en", "pt-BR", "pt-PT", "es"];

export const ORDERED_DASHBOARD_LOCALES: readonly Locale[] = [
  ...FEATURED_DASHBOARD_LOCALES,
  ...SUPPORTED_LOCALES.filter((locale) => !FEATURED_DASHBOARD_LOCALES.includes(locale)),
];

export function localeLabelKey(locale: Locale): string {
  return locale.replace(/-([a-zA-Z])/g, (_, c: string) => c.toUpperCase());
}
