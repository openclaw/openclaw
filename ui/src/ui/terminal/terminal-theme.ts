// Maps the Control UI's light/dark surfaces onto ghostty-web's 16-color theme.
import type { ITheme } from "ghostty-web";

// ANSI palette tuned to sit on the Control UI's near-black / near-white surfaces.
// Shared 8 + bright 8; foreground/background/cursor are overridden per mode below.
const ANSI = {
  black: "#1b1e26",
  red: "#ff6b6b",
  green: "#4ec9a8",
  yellow: "#e5c07b",
  blue: "#5aa2ff",
  magenta: "#c586c0",
  cyan: "#56b6c2",
  white: "#d7dae0",
  brightBlack: "#5c6370",
  brightRed: "#ff8787",
  brightGreen: "#6fd7bd",
  brightYellow: "#f0d197",
  brightBlue: "#7cb7ff",
  brightMagenta: "#d7a3d4",
  brightCyan: "#7bd3dd",
  brightWhite: "#ffffff",
} as const;

/** Builds the terminal theme for the given Control UI color mode. */
export function terminalTheme(mode: "dark" | "light"): ITheme {
  if (mode === "light") {
    return {
      ...ANSI,
      background: "#f7f8fa",
      foreground: "#1b1e26",
      cursor: "#1b1e26",
      cursorAccent: "#f7f8fa",
      selectionBackground: "rgba(90, 162, 255, 0.30)",
      black: "#3a3f4b",
      white: "#1b1e26",
    };
  }
  return {
    ...ANSI,
    background: "#0e1015",
    foreground: "#d7dae0",
    cursor: "#ff5c5c",
    cursorAccent: "#0e1015",
    selectionBackground: "rgba(90, 162, 255, 0.32)",
  };
}
