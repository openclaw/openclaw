import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resilientFetch } from "./resilient-fetch.ts";

describe("resilient-fetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns successful response on first attempt", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const result = await resilientFetch("https://example.com");
    expect(result.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 4xx client errors", async () => {
    const mockResponse = new Response("bad request", { status: 400 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const result = await resilientFetch("https://example.com", undefined, {
      maxAttempts: 3,
      baseDelayMs: 10,
    });
    expect(result.status).toBe(400);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx server errors", async () => {
    const error500 = new Response("error", { status: 500 });
    const ok200 = new Response("ok", { status: 200 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(error500)
      .mockResolvedValueOnce(ok200);

    const promise = resilientFetch("https://example.com", undefined, {
      maxAttempts: 3,
      baseDelayMs: 100,
    });

    // Advance timer to trigger retry
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on network errors", async () => {
    const ok200 = new Response("ok", { status: 200 });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok200);

    const promise = resilientFetch("https://example.com", undefined, {
      maxAttempts: 3,
      baseDelayMs: 100,
    });

    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all retries on network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const promise = resilientFetch("https://example.com", undefined, {
      maxAttempts: 2,
      baseDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).rejects.toThrow("Failed to fetch");
  });

  it("returns last 5xx Response after exhausting all retries", async () => {
    const error503 = new Response("service unavailable", { status: 503 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(error503);

    const promise = resilientFetch("https://example.com", undefined, {
      maxAttempts: 2,
      baseDelayMs: 50,
    });

    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    expect(result.status).toBe(503);
  });
});
