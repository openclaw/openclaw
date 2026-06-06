// Control UI module implements display-only session-name overrides.
// Labels are persisted in localStorage so they survive reload. The
// underlying session key is never modified; this is purely cosmetic.
import { getSafeLocalStorage } from "../local-storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";

const STORAGE_KEY = "openclaw.controlUi.sessionLabels.v1";
const MAX_LABEL_CHARS = 120;

type RenameMap = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readMap(): RenameMap {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return {};
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) {
    return {};
  }
  const result: RenameMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key === "string" && typeof value === "string") {
      const trimmed = value.trim().slice(0, MAX_LABEL_CHARS);
      if (key && trimmed) {
        result[key] = trimmed;
      }
    }
  }
  return result;
}

function writeMap(map: RenameMap): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort persistence; ignore quota/serialization failures.
  }
}

/** Read the persisted custom label for a session, if any. */
export function getSessionRenameLabel(sessionKey: string): string | null {
  if (!sessionKey) {
    return null;
  }
  const map = readMap();
  return normalizeOptionalString(map[sessionKey]) ?? null;
}

/**
 * Set the display-only label for `sessionKey`. Passing an empty/blank value
 * clears the override and falls back to the server-derived display name.
 */
export function setSessionRenameLabel(sessionKey: string, label: string): void {
  if (!sessionKey) {
    return;
  }
  const map = readMap();
  const trimmed = label.trim().slice(0, MAX_LABEL_CHARS);
  if (!trimmed) {
    if (sessionKey in map) {
      delete map[sessionKey];
      writeMap(map);
    }
    return;
  }
  map[sessionKey] = trimmed;
  writeMap(map);
}

/** Remove a custom label override for the given session. */
export function clearSessionRenameLabel(sessionKey: string): void {
  setSessionRenameLabel(sessionKey, "");
}

/** Test-only helper; wipes all persisted rename entries. */
export function resetSessionRenameStoreForTests(): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export const SESSION_RENAME_STORAGE_KEY = STORAGE_KEY;
export const SESSION_RENAME_MAX_LABEL_CHARS = MAX_LABEL_CHARS;
