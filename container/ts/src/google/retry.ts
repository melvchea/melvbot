export const GOOGLE_RETRY_LIMIT = 3;
export const GOOGLE_RETRY_BASE_MS = 250;
/** Per-request budget; well below SHEET_LOCK_STALE_MS so a hung Google call cannot outlive the sheet lock. */
export const GOOGLE_FETCH_TIMEOUT_MS = 15_000;
export const GOOGLE_RETRY_AFTER_CAP_MS = 10_000;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_STATUSES = new Set([429, 503]);

export class GoogleHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleHttpError";
    this.status = status;
  }
}

export function shouldRetryGoogleStatus(status: number, attempt: number): boolean {
  return RETRY_STATUSES.has(status) && attempt < GOOGLE_RETRY_LIMIT - 1;
}

export function googleRetryDelayMs(attempt: number): number {
  return GOOGLE_RETRY_BASE_MS * 2 ** attempt;
}

/** A timed-out fetch (AbortSignal.timeout) is retried like a retryable status. */
export function isGoogleTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Delay the server asked for on 429/503 (Retry-After as seconds or an HTTP date), capped; null when absent. */
export function googleRetryAfterMs(status: number, header: string | null, now = Date.now()): number | null {
  if (header === null || !RETRY_AFTER_STATUSES.has(status)) {
    return null;
  }
  const trimmed = header.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.min(Math.max(ms, 0), GOOGLE_RETRY_AFTER_CAP_MS);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
