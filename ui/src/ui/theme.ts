export type ThemeName = "claw" | "knot" | "dash";
export type ThemeScheme = "light" | "dark";
export type LegacyThemeMode = "system" | "light" | "dark";

export type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light";

export type AppearanceMode = "single" | "sync";
export type AppearancePreset =
  | "openclaw-light"
  | "openclaw-dark"
  | "github-light-default"
  | "github-light-colorblind"
  | "github-light-tritanopia"
  | "github-dark-default"
  | "github-dark-dimmed"
  | "github-dark-colorblind"
  | "github-dark-tritanopia";

export type AppearanceConfig = {
  mode: AppearanceMode;
  lightPreset: AppearancePreset;
  darkPreset: AppearancePreset;
  singleScheme: ThemeScheme;
};

export const VALID_THEME_NAMES = new Set<ThemeName>(["claw", "knot", "dash"]);
export const VALID_THEME_SCHEMES = new Set<ThemeScheme>(["light", "dark"]);
export const VALID_LEGACY_THEME_MODES = new Set<LegacyThemeMode>(["system", "light", "dark"]);
export const VALID_APPEARANCE_MODES = new Set<AppearanceMode>(["single", "sync"]);
export const VALID_LIGHT_APPEARANCE_PRESETS = new Set<AppearancePreset>([
  "openclaw-light",
  "github-light-default",
  "github-light-colorblind",
  "github-light-tritanopia",
]);
export const VALID_DARK_APPEARANCE_PRESETS = new Set<AppearancePreset>([
  "openclaw-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-colorblind",
  "github-dark-tritanopia",
]);

type ThemeSelection = { theme: ThemeName; mode: LegacyThemeMode };

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

function isThemeScheme(value: unknown): value is ThemeScheme {
  return typeof value === "string" && VALID_THEME_SCHEMES.has(value as ThemeScheme);
}

function isLightAppearancePreset(value: unknown): value is AppearancePreset {
  return typeof value === "string" && VALID_LIGHT_APPEARANCE_PRESETS.has(value as AppearancePreset);
}

function isDarkAppearancePreset(value: unknown): value is AppearancePreset {
  return typeof value === "string" && VALID_DARK_APPEARANCE_PRESETS.has(value as AppearancePreset);
}

export function prefersLightScheme(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

export function resolveSystemScheme(): ThemeScheme {
  return prefersLightScheme() ? "light" : "dark";
}

export function resolveSystemTheme(): ResolvedTheme {
  return resolveSystemScheme() === "light" ? "light" : "dark";
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: LegacyThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  const normalizedTheme = VALID_THEME_NAMES.has(theme as ThemeName)
    ? (theme as ThemeName)
    : (LEGACY_MAP[theme]?.theme ?? "claw");
  const normalizedMode = VALID_LEGACY_THEME_MODES.has(mode as LegacyThemeMode)
    ? (mode as LegacyThemeMode)
    : (LEGACY_MAP[theme]?.mode ?? "system");

  return { theme: normalizedTheme, mode: normalizedMode };
}

export function defaultAppearanceConfig(): AppearanceConfig {
  return {
    mode: "sync",
    lightPreset: "openclaw-light",
    darkPreset: "openclaw-dark",
    singleScheme: "dark",
  };
}

export function parseAppearanceConfig(
  configRaw: unknown,
  legacyModeRaw?: unknown,
): AppearanceConfig {
  const defaults = defaultAppearanceConfig();
  const config =
    typeof configRaw === "object" && configRaw !== null
      ? (configRaw as Partial<Record<keyof AppearanceConfig, unknown>>)
      : null;

  const legacyMode =
    typeof legacyModeRaw === "string" &&
    VALID_LEGACY_THEME_MODES.has(legacyModeRaw as LegacyThemeMode)
      ? (legacyModeRaw as LegacyThemeMode)
      : null;

  const mode =
    config &&
    typeof config.mode === "string" &&
    VALID_APPEARANCE_MODES.has(config.mode as AppearanceMode)
      ? (config.mode as AppearanceMode)
      : legacyMode === "system"
        ? "sync"
        : "single";

  const lightPreset =
    config && isLightAppearancePreset(config.lightPreset)
      ? config.lightPreset
      : defaults.lightPreset;
  const darkPreset =
    config && isDarkAppearancePreset(config.darkPreset) ? config.darkPreset : defaults.darkPreset;
  const singleScheme =
    config && isThemeScheme(config.singleScheme)
      ? config.singleScheme
      : legacyMode === "light"
        ? "light"
        : defaults.singleScheme;

  return { mode, lightPreset, darkPreset, singleScheme };
}

export function resolveAppearanceScheme(config: AppearanceConfig): ThemeScheme {
  if (config.mode === "sync") {
    return resolveSystemScheme();
  }
  return config.singleScheme;
}

export function resolveAppearancePreset(config: AppearanceConfig): AppearancePreset {
  const scheme = resolveAppearanceScheme(config);
  return scheme === "light" ? config.lightPreset : config.darkPreset;
}

export function resolveTheme(theme: ThemeName, scheme: ThemeScheme): ResolvedTheme {
  if (theme === "claw") {
    return scheme === "light" ? "light" : "dark";
  }
  if (theme === "knot") {
    return scheme === "light" ? "openknot-light" : "openknot";
  }
  return scheme === "light" ? "dash-light" : "dash";
}
