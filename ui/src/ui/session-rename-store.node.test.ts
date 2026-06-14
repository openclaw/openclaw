// @vitest-environment node
// Control UI tests cover client-only session rename persistence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { resolveSessionDisplayName } from "./session-display.ts";
import {
  clearSessionRenameLabel,
  getSessionRenameLabel,
  resetSessionRenameStoreForTests,
  SESSION_RENAME_MAX_LABEL_CHARS,
  SESSION_RENAME_STORAGE_KEY,
  setSessionRenameLabel,
} from "./session-rename-store.ts";

describe("session rename store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    resetSessionRenameStoreForTests();
  });

  afterEach(() => {
    resetSessionRenameStoreForTests();
    vi.unstubAllGlobals();
  });

  it("returns null when no label has been saved", () => {
    expect(getSessionRenameLabel("agent:main:webchat:direct:abc123")).toBeNull();
  });

  it("persists a label and reads it back from storage on subsequent reads", () => {
    setSessionRenameLabel("agent:main:webchat:direct:abc123", "Customer 42");

    // First read confirms in-memory persistence.
    expect(getSessionRenameLabel("agent:main:webchat:direct:abc123")).toBe("Customer 42");

    // Confirm the underlying storage was written so a fresh mount sees it too.
    const raw = localStorage.getItem(SESSION_RENAME_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw ?? "{}") as Record<string, string>;
    expect(parsed["agent:main:webchat:direct:abc123"]).toBe("Customer 42");

    // And the store reads the same value back without retaining any in-process state.
    expect(getSessionRenameLabel("agent:main:webchat:direct:abc123")).toBe("Customer 42");
  });

  it("trims whitespace and clears an entry when the label becomes empty", () => {
    setSessionRenameLabel("session-1", "  My Label  ");
    expect(getSessionRenameLabel("session-1")).toBe("My Label");

    setSessionRenameLabel("session-1", "   ");
    expect(getSessionRenameLabel("session-1")).toBeNull();
  });

  it("clearSessionRenameLabel removes an existing entry", () => {
    setSessionRenameLabel("session-2", "Inbox");
    expect(getSessionRenameLabel("session-2")).toBe("Inbox");

    clearSessionRenameLabel("session-2");
    expect(getSessionRenameLabel("session-2")).toBeNull();
  });

  it("caps the saved label at SESSION_RENAME_MAX_LABEL_CHARS", () => {
    const long = "x".repeat(SESSION_RENAME_MAX_LABEL_CHARS + 25);
    setSessionRenameLabel("session-3", long);
    const saved = getSessionRenameLabel("session-3");
    expect(saved).not.toBeNull();
    expect(saved?.length).toBe(SESSION_RENAME_MAX_LABEL_CHARS);
  });

  it("ignores corrupted storage payloads without throwing", () => {
    localStorage.setItem(SESSION_RENAME_STORAGE_KEY, "not-json{");
    expect(getSessionRenameLabel("any")).toBeNull();
  });

  it("ignores empty session keys", () => {
    setSessionRenameLabel("", "hello");
    expect(getSessionRenameLabel("")).toBeNull();
  });
});

describe("resolveSessionDisplayName with renames", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    resetSessionRenameStoreForTests();
  });

  afterEach(() => {
    resetSessionRenameStoreForTests();
    vi.unstubAllGlobals();
  });

  it("falls back to the server-derived display when no custom label is set", () => {
    const key = "agent:main:webchat:direct:abc123";
    expect(resolveSessionDisplayName(key, { key })).toBe("Webchat · abc123");
  });

  it("falls back to the raw session key when nothing parses meaningfully", () => {
    const key = "completely-unknown-key";
    expect(resolveSessionDisplayName(key, { key })).toBe(key);
  });

  it("prefers the custom label over the server-provided label and survives a fresh read", () => {
    const key = "agent:main:webchat:direct:abc123";
    setSessionRenameLabel(key, "Acme support thread");

    const row = {
      key,
      label: "Server label",
      displayName: "Server display",
    } as Parameters<typeof resolveSessionDisplayName>[1];

    // Initial render.
    expect(resolveSessionDisplayName(key, row)).toBe("Acme support thread");

    // Simulate a fresh mount cycle: storage persists, store rereads.
    resetSessionRenameStoreForTests();
    expect(resolveSessionDisplayName(key, row)).toBe("Server label");
  });

  it("custom label still applies the Subagent typed prefix", () => {
    const key = "agent:main:subagent:worker-1";
    setSessionRenameLabel(key, "Nightly cleanup");
    expect(resolveSessionDisplayName(key, { key })).toBe("Subagent: Nightly cleanup");
  });
});
