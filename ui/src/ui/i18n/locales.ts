// Internationalization support for OpenClaw UI
// Define all translatable strings with English as the default

import { en } from "./locales/en.ts";
import { pt } from "./locales/pt.ts";
import { zh } from "./locales/zh.ts";

// Default to English
export const defaultLocale = "en";

// Export individual locales
export { en, zh, pt };

// Export all locales map
export const locales = {
  en,
  zh,
  pt,
};
