import { i18n } from "../../i18n/index.ts";
import { VI_CONFIG_METADATA_TEXT } from "./config-form.metadata.generated.ts";

const VI_CONFIG_METADATA_OVERRIDES: Readonly<Record<string, string>> = {
  "DM Policy": "Chính sách DM",
  "Group Policy": "Chính sách nhóm",
  "Stream Mode": "Chế độ stream",
};

function normalizeConfigMetadataText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function translateConfigMetadataText(text: string | null | undefined): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  if (i18n.getLocale() !== "vi") {
    return text;
  }
  const normalized = normalizeConfigMetadataText(text);
  if (!normalized) {
    return text;
  }
  return VI_CONFIG_METADATA_OVERRIDES[normalized] ?? VI_CONFIG_METADATA_TEXT[normalized] ?? text;
}
