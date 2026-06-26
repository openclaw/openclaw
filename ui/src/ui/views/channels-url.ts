// Deep-link helper for the channels directory: the set of expanded channel rows
// lives in the `?channels=<csv>` query param so a selection survives reload,
// bookmarking, and shared links. The writer replaces the current history entry
// rather than adding one entry per row toggle; popstate still syncs when the user
// reaches a history entry or link with this param. Kept separate from the
// auth-sensitive URL handling in app-settings.ts.
const CHANNELS_PARAM = "channels";

export function readExpandedChannelsFromUrl(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const raw = new URLSearchParams(window.location.search).get(CHANNELS_PARAM);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function writeExpandedChannelsToUrl(ids: readonly string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (ids.length === 0) {
    url.searchParams.delete(CHANNELS_PARAM);
  } else {
    url.searchParams.set(CHANNELS_PARAM, ids.join(","));
  }
  window.history.replaceState({}, "", url.toString());
}
