export type ThemeMode = "dark" | "light" | "openknot" | "fieldmanual" | "clawdash";
export type ResolvedTheme = ThemeMode;

export const VALID_THEMES = new Set<ThemeMode>([
  "dark",
  "light",
  "openknot",
  "fieldmanual",
  "clawdash",
]);

const LEGACY_MAP: Record<string, ThemeMode> = {
  defaultTheme: "dark",
  docsTheme: "light",
  lightTheme: "openknot",
  landingTheme: "openknot",
  newTheme: "openknot",
};

export function resolveTheme(mode: string): ResolvedTheme {
  if (VALID_THEMES.has(mode as ThemeMode)) {
    return mode as ThemeMode;
  }
  return LEGACY_MAP[mode] ?? "dark";
}
