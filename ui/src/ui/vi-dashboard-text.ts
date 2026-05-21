import { i18n, t } from "../i18n/index.ts";

export function viDashboardText(en: string, vi: string): string {
  return i18n.getLocale() === "vi" ? vi : en;
}

export function viDashboardI18nText(
  key: string,
  vi: string,
  params?: Record<string, string>,
): string {
  if (i18n.getLocale() !== "vi") {
    return t(key, params);
  }
  if (!params) {
    return vi;
  }
  return vi.replace(/\{(\w+)\}/g, (_, paramKey) => params[paramKey] || `{${paramKey}}`);
}
