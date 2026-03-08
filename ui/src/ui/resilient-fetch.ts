/**
 * Resilient fetch wrapper with timeout and exponential backoff retry.
 *
 * - Configurable timeout via AbortController (default: 30s)
 * - Exponential backoff retry with jitter (default: 3 attempts)
 * - Only retries on network errors and 5xx server responses
 * - 4xx client errors are NOT retried (they indicate a client-side issue)
 */

export interface RetryConfig {
  /** Maximum number of attempts (including the initial request).  @default 3 */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry.          @default 1000 */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds.                          @default 10000 */
  maxDelayMs?: number;
  /** Request timeout in milliseconds.                            @default 30000 */
  timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_TIMEOUT_MS = 30000;

/** Calculate delay with exponential backoff and jitter. */
function calculateDelay(attempt: number, baseMs: number, maxMs: number): number {
  // Exponential: baseMs * 2^attempt
  const exponential = baseMs * Math.pow(2, attempt);
  // Add jitter: 0-50% of the exponential value
  const jitter = exponential * Math.random() * 0.5;
  return Math.min(exponential + jitter, maxMs);
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with timeout and exponential backoff retry.
 *
 * @param input  - Fetch input (URL string or Request)
 * @param init   - Fetch init options
 * @param config - Retry and timeout configuration
 * @returns The fetch Response (from the last successful or final attempt)
 */
export async function resilientFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  config?: RetryConfig,
): Promise<Response> {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = config?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Merge caller's signal with our timeout signal
    const callerSignal = init?.signal;
    if (callerSignal?.aborted) {
      clearTimeout(timeoutId);
      throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);

      // Don't retry client errors (4xx)
      if (!isRetryableStatus(response.status)) {
        return response;
      }

      // 5xx - save response to return if all retries fail
      lastResponse = response;
      lastError = new Error(`Server error: ${response.status} ${response.statusText}`);
    } catch (err) {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", onCallerAbort);

      // Don't retry if the caller explicitly aborted
      if (callerSignal?.aborted) {
        throw err;
      }

      lastError = err;
    }

    // Wait before retrying (except on the last attempt)
    if (attempt < maxAttempts - 1) {
      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  // If the last failure was a 5xx response, return it so callers can
  // inspect the status, headers, and body of the final attempt.
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError;
}
