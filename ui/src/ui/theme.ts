export type ThemeName = "claw" | "knot" | "dash";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light";

export const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "knot", "dash"]);
export const VALID_THEME_MODES = new Set<ThemeMode>(["system", "light", "dark"]);

type ThemeSelection = { theme: ThemeName; mode: ThemeMode };

const LEGACY_MAP: Record<string, ThemeSelection> = {
  defaultTheme: { theme: "claw", mode: "dark" },
  docsTheme: { theme: "claw", mode: "light" },
  lightTheme: { theme: "knot", mode: "dark" },
  landingTheme: { theme: "knot", mode: "dark" },
  newTheme: { theme: "knot", mode: "dark" },
  dark: { theme: "claw", mode: "dark" },
  light: { theme: "claw", mode: "light" },
  openknot: { theme: "knot", mode: "dark" },
  fieldmanual: { theme: "dash", mode: "dark" },
  clawdash: { theme: "dash", mode: "light" },
  system: { theme: "claw", mode: "system" },
};

export function prefersLightScheme(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

export function resolveSystemTheme(): ResolvedTheme {
  return prefersLightScheme() ? "light" : "dark";
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  const normalizedTheme = VALID_THEME_NAMES.has(theme as ThemeName)
    ? (theme as ThemeName)
    : (LEGACY_MAP[theme]?.theme ?? "claw");
  const normalizedMode = VALID_THEME_MODES.has(mode as ThemeMode)
    ? (mode as ThemeMode)
    : (LEGACY_MAP[theme]?.mode ?? "system");

  return { theme: normalizedTheme, mode: normalizedMode };
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return prefersLightScheme() ? "light" : "dark";
  }
  return mode;
}

function normalizeThemeArgs(
  themeOrMode: ThemeName | ThemeMode,
  mode: ThemeMode | undefined,
): { theme: ThemeName; mode: ThemeMode } {
  if (VALID_THEME_NAMES.has(themeOrMode as ThemeName)) {
    return {
      theme: themeOrMode as ThemeName,
      mode: mode ?? "system",
    };
  }
  return {
    theme: "claw",
    mode: themeOrMode as ThemeMode,
  };
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme;
export function resolveTheme(theme: ThemeName, mode?: ThemeMode): ResolvedTheme;
export function resolveTheme(themeOrMode: ThemeName | ThemeMode, mode?: ThemeMode): ResolvedTheme {
  const normalized = normalizeThemeArgs(themeOrMode, mode);
  const resolvedMode = resolveMode(normalized.mode);
  if (normalized.theme === "claw") {
    return resolvedMode === "light" ? "light" : "dark";
  }
  if (normalized.theme === "knot") {
    return resolvedMode === "light" ? "openknot-light" : "openknot";
  }
  return resolvedMode === "light" ? "dash-light" : "dash";
}

export function colorSchemeForTheme(theme: ResolvedTheme): "light" | "dark" {
  return theme === "light" || theme === "openknot-light" || theme === "dash-light"
    ? "light"
    : "dark";
}

export function dataThemeForTheme(theme: ResolvedTheme): ResolvedTheme | "light" {
  return colorSchemeForTheme(theme) === "light" ? "light" : theme;
}
