import { afterEach, describe, expect, it } from "vitest";
import { secureGet, secureRemove, secureSet, __resetForTesting } from "./secure-storage.ts";

describe("secure-storage", () => {
  afterEach(() => {
    localStorage.clear();
    __resetForTesting();
  });

  // -----------------------------------------------------------------------
  // Round-trip basics
  // -----------------------------------------------------------------------

  it("encrypts and decrypts a value round-trip", async () => {
    await secureSet("test-key", "secret-value");
    const result = await secureGet("test-key");
    expect(result).toBe("secret-value");
  });

  it("stores values with enc: prefix", async () => {
    await secureSet("test-key", "hello");
    const raw = localStorage.getItem("test-key");
    expect(raw).not.toBeNull();
    expect(raw!.startsWith("enc:")).toBe(true);
  });

  it("returns null for missing keys", async () => {
    const result = await secureGet("nonexistent");
    expect(result).toBeNull();
  });

  it("removes values", async () => {
    await secureSet("remove-me", "value");
    secureRemove("remove-me");
    const result = await secureGet("remove-me");
    expect(result).toBeNull();
  });

  it("handles empty string values", async () => {
    await secureSet("empty", "");
    const result = await secureGet("empty");
    expect(result).toBe("");
  });

  it("handles unicode values", async () => {
    const unicode = "日本語テスト 🔑🔒";
    await secureSet("unicode-key", unicode);
    const result = await secureGet("unicode-key");
    expect(result).toBe(unicode);
  });

  it("produces different ciphertexts for same value (random IV)", async () => {
    await secureSet("key1", "same-value");
    const ct1 = localStorage.getItem("key1");
    localStorage.removeItem("key1");
    await secureSet("key1", "same-value");
    const ct2 = localStorage.getItem("key1");
    expect(ct1).not.toBe(ct2);
  });

  // -----------------------------------------------------------------------
  // Migration: legacy unencrypted values
  // -----------------------------------------------------------------------

  it("returns legacy unencrypted values as-is (migration path)", async () => {
    localStorage.setItem("legacy-key", "plain-value");
    const result = await secureGet("legacy-key");
    expect(result).toBe("plain-value");
  });

  // -----------------------------------------------------------------------
  // Failure modes
  // -----------------------------------------------------------------------

  it("returns null (not ciphertext) when an enc:-prefixed value fails to decrypt", async () => {
    // Simulate corrupt ciphertext: valid prefix but garbage payload
    localStorage.setItem("bad-key", "enc:AAAA.BBBB");
    const result = await secureGet("bad-key");
    // Must NOT leak ciphertext – should return null
    expect(result).toBeNull();
  });

  it("returns null for truncated enc: values", async () => {
    localStorage.setItem("trunc-key", "enc:missing-dot");
    const result = await secureGet("trunc-key");
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Large values (regression: btoa spread crash above ~48 KiB)
  // -----------------------------------------------------------------------

  it("handles values larger than 48 KiB without crashing", async () => {
    const large = "x".repeat(100_000); // ~100 KB of plaintext
    await secureSet("large-key", large);
    const result = await secureGet("large-key");
    expect(result).toBe(large);
  });

  // -----------------------------------------------------------------------
  // Key isolation via __resetForTesting
  // -----------------------------------------------------------------------

  it("__resetForTesting clears the cached key", async () => {
    await secureSet("k", "v");
    __resetForTesting();
    // After reset the next operation fetches a fresh key from IndexedDB.
    // Since the same key is stored there, round-trip still works.
    const result = await secureGet("k");
    expect(result).toBe("v");
  });
});
