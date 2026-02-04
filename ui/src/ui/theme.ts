export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
<<<<<<< HEAD
  if (mode === "system") return getSystemTheme();
=======
  if (mode === "system") {
    return getSystemTheme();
  }
>>>>>>> upstream/main
  return mode;
}
