import { i18n } from "../i18n/index.ts";

export function viDashboardText(en: string, vi: string): string {
  return i18n.getLocale() === "vi" ? vi : en;
}
