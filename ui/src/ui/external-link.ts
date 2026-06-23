// Control UI module implements external link behavior.
import { normalizeOptionalLowercaseString } from "./string-coerce.ts";

const REQUIRED_EXTERNAL_REL_TOKENS = ["noopener", "noreferrer"] as const;

export const EXTERNAL_LINK_TARGET = "_blank";

const DOCS_BASE_URL = "https://docs.openclaw.ai";
const LOCALIZED_DOCS_LOCALES = new Set([
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
]);

export function buildDocsHref(pathOrHref: string, locale?: string | null): string {
  const docsPath = pathOrHref.startsWith(DOCS_BASE_URL)
    ? pathOrHref.slice(DOCS_BASE_URL.length) || "/"
    : pathOrHref;
  const normalizedPath = docsPath.startsWith("/") ? docsPath : `/${docsPath}`;
  if (!locale || locale === "en" || !LOCALIZED_DOCS_LOCALES.has(locale)) {
    return `${DOCS_BASE_URL}${normalizedPath}`;
  }
  return `${DOCS_BASE_URL}/${locale}${normalizedPath}`;
}

export function buildExternalLinkRel(currentRel?: string): string {
  const extraTokens: string[] = [];
  const seen = new Set<string>(REQUIRED_EXTERNAL_REL_TOKENS);

  for (const rawToken of (currentRel ?? "").split(/\s+/)) {
    const token = normalizeOptionalLowercaseString(rawToken);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    extraTokens.push(token);
  }

  return [...REQUIRED_EXTERNAL_REL_TOKENS, ...extraTokens].join(" ");
}
