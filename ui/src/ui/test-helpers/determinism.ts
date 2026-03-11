/**
 * UI Test Determinism Helpers
 *
 * Provides utilities to ensure deterministic test execution:
 * - Frozen system time for reproducible timestamps
 * - Stable timezone/locale behavior
 * - Strictly typed window.open mock
 */

import { vi } from "vitest";

/**
 * Deterministic reference timestamp: 2026-02-28T12:00:00Z
 * (Frozen for all tests to ensure reproducible results)
 */
const FROZEN_TIME = new Date("2026-02-28T12:00:00Z");

/**
 * Applies determinism defaults for all UI tests:
 * 1. Freezes system time to a fixed timestamp
 * 2. Sets timezone to UTC for stable locale/date behavior
 * 3. Sets language to 'en' for consistent i18n output
 * 4. Mocks window.open with strict typing to prevent security issues
 *
 * Call this in your test setup file (beforeAll or beforeEach)
 * to ensure consistent test execution across all UI tests.
 */
export function applyDeterminismDefaults(): void {
  // Enable fake timers before setting system time
  vi.useFakeTimers();

  // Freeze time to ensure reproducible timestamps across test runs
  vi.setSystemTime(FROZEN_TIME);

  // Enforce UTC timezone for stable behavior across CI/local environments
  vi.stubEnv("TZ", "UTC");

  // Set document language to English for consistent i18n output
  document.documentElement.lang = "en";

  // Mock window.open to prevent accidental window access in tests
  // Returns null (safest behavior); restoreMocks: true handles cleanup
  vi.spyOn(window, "open").mockImplementation(() => null);

  // Mock Math.random for deterministic randomness in all UI tests
  vi.spyOn(Math, "random").mockReturnValue(0.123456789);
}

/**
* Reset determinism defaults (useful for per-test cleanup if needed).
* Typically called in afterEach hooks for isolated test state.
*/
export function resetDeterminismDefaults(): void {
 vi.useRealTimers();
 vi.unstubAllEnvs();
 document.documentElement.lang = "";
 // Note: window.open mock is restored by Vitest's restoreMocks: true config
}
