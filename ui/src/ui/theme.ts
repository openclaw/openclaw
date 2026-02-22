export type ThemeMode = "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  return mode;
}
