/**
 * OpenClaw Control UI — Internationalization (i18n)
 *
 * Lightweight, frontend-only i18n system.
 * No backend changes required. All translation happens in the browser.
 *
 * Usage:
 *   import { t, setLocale, getLocale, SUPPORTED_LOCALES } from "./i18n/index.ts";
 *   t("Save")        → "Salvar" (when locale is pt-BR)
 *   t("Save")        → "Save"   (when locale is en)
 *   setLocale("pt-BR")
 */

import { ptBR } from "./pt-BR.js";

export type LocaleCode = "en" | "pt-BR";

export const SUPPORTED_LOCALES: { code: LocaleCode; label: string }[] = [
  { code: "en", label: "English" },
  { code: "pt-BR", label: "Português (Brasil)" },
];

const dictionaries: Record<string, Record<string, string>> = {
  "pt-BR": ptBR,
};

const STORAGE_KEY = "openclaw-locale";

let currentLocale: LocaleCode = "en";

/** Listeners that fire when locale changes (for LitElement re-render) */
const listeners: Set<() => void> = new Set();

export function onLocaleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getLocale(): LocaleCode {
  return currentLocale;
}

export function setLocale(locale: LocaleCode): void {
  if (locale === currentLocale) {
    return;
  }
  currentLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // localStorage may be unavailable
  }
  listeners.forEach((cb) => cb());
}

/** Translate a string. Returns the translation or the original key. */
export function t(key: string): string {
  if (currentLocale === "en") {
    return key;
  }
  const dict = dictionaries[currentLocale];
  return dict?.[key] ?? key;
}

/** Initialize locale from localStorage or browser language */
export function initLocale(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.some((l) => l.code === stored)) {
      currentLocale = stored as LocaleCode;
      return;
    }
  } catch {
    // ignore
  }
  // Auto-detect from browser
  const browserLang = navigator.language;
  if (browserLang.startsWith("pt")) {
    currentLocale = "pt-BR";
  }
}

// Auto-initialize on import
initLocale();
