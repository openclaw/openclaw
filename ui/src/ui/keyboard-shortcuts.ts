export type NavigatorFingerprint = Pick<Navigator, "userAgent">;

export function commandPaletteShortcutLabel(
  nav: NavigatorFingerprint | undefined = globalThis.navigator,
): string {
  const fingerprint = (nav?.userAgent ?? "").toLowerCase();
  return fingerprint.includes("mac") ||
    fingerprint.includes("iphone") ||
    fingerprint.includes("ipad")
    ? "⌘K"
    : "Ctrl+K";
}
