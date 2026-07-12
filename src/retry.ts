export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  retries?: number;
  /** Backoff before the first retry, in ms (default 500). Doubles each retry. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff, in ms (default 4000). */
  maxDelayMs?: number;
  /** Decide whether an error is worth retrying (default: HTTP 429 / 5xx). */
  isRetryable?: (err: unknown) => boolean;
  /** Pull a server-suggested wait (ms) out of an error (default: Retry-After). */
  retryAfterMs?: (err: unknown) => number | undefined;
}

/** Read a numeric `status`/`statusCode` off an unknown error, if present. */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown; statusCode?: unknown } | null)?.status;
  if (typeof s === "number") return s;
  const sc = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof sc === "number" ? sc : undefined;
}

/** Read a string `code` off an unknown error, if present. */
function codeOf(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

// Transient network/DNS/socket failures (node-fetch surfaces the OS errno as
// `code`) and the Notion SDK's own request-timeout code. These carry no numeric
// HTTP status, so the status check below never catches them — yet an intermittent
// DNS blip or socket reset is exactly what a retry should ride out. Without this
// a transient failure isn't retried, and with a pre-advanced watermark a
// delivery-status write can be dropped rather than merely delayed.
const RETRYABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "notionhq_client_request_timeout",
]);

/**
 * Default policy: retry rate limits (429), transient server errors (5xx), and
 * transient network/timeout failures (which carry a string `code`, not a status).
 */
function defaultIsRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429 || (typeof status === "number" && status >= 500)) return true;
  const code = codeOf(err);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/** Default Retry-After reader: honor a `retry-after` header (seconds → ms). */
function defaultRetryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers;
  if (!headers) return undefined;
  const raw =
    headers instanceof Headers
      ? headers.get("retry-after")
      : (headers as Record<string, unknown>)["retry-after"];
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff. Honors a
 * server `Retry-After` when present. Non-retryable errors (and the final
 * attempt) propagate unchanged. Used to wrap Notion `databases.query` /
 * `pages.update` so a burst from several inboxes can't trip Notion's rate limit.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const retryAfterMs = opts.retryAfterMs ?? defaultRetryAfterMs;

  let delay = baseDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      // Honor a server-suggested Retry-After verbatim (it knows better than our
      // backoff); cap only the local exponential branch with maxDelayMs.
      const serverWait = retryAfterMs(err);
      await sleep(serverWait ?? Math.min(delay, maxDelayMs));
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}
