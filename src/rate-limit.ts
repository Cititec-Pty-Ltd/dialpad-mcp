import { logger } from './utils/logger.js';

/**
 * Bounded retry for rate-limited Dialpad responses.
 *
 * Dialpad allows 20 requests per second per company (lower for some
 * endpoints) but does not document its 429 response. If it sends
 * `Retry-After` (seconds or an HTTP date) that is honoured; otherwise the
 * retry backs off 1 s, then 2 s, with jitter. A long wait is not taken: the
 * caller gets the 429 at once, so a tool call is never held for minutes.
 * A 503 is retried only when it carries Retry-After.
 *
 * Only replay-safe methods (GET/HEAD/OPTIONS) are retried (RFC 9110 9.2.2).
 * Dialpad does not document that a rate-limited write was rejected before it
 * ran, and a 503 does not prove a write had no effect, so a POST, PATCH or
 * DELETE is never sent twice: it fails at once and the error says how long
 * to wait.
 */
export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt. */
  maxRetries: 2,
  /** Longest single wait. A larger Retry-After is not waited for. */
  maxWaitMs: 10_000,
  /** Longest total wait across the retries of one request. */
  maxTotalWaitMs: 20_000,
  /** Backoff for the first retry when the response has no Retry-After; doubles each retry. */
  baseBackoffMs: 1_000,
};

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  // Otherwise it must be an HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT").
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Whole seconds from a response's Retry-After header (at least 1), or undefined. */
export function retryAfterSecondsOf(res: Response): number | undefined {
  const ms = parseRetryAfter(res.headers.get('retry-after'));
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based), or
 * undefined when the request should not be retried.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  waitedMs: number,
  random: () => number = Math.random
): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  const delay = retryAfterMs ?? RATE_LIMIT_RETRY.baseBackoffMs * 2 ** attempt + Math.floor(random() * 250);
  if (delay > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  if (waitedMs + delay > RATE_LIMIT_RETRY.maxTotalWaitMs) return undefined;
  return delay;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch() with the bounded retry above. `makeInit` is called for every
 * attempt so each one gets a fresh timeout signal. Returns the last
 * response, which may still be a 429 for the caller to report.
 */
/** Methods that may be replayed: they cannot create or change anything. */
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function fetchWithRateLimitRetry(
  url: string,
  label: string,
  makeInit: () => RequestInit
): Promise<Response> {
  const init = makeInit();
  const replaySafe = REPLAY_SAFE_METHODS.has((init.method ?? 'GET').toUpperCase());
  let res = await fetch(url, init);
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const retryable =
      replaySafe && (res.status === 429 || (res.status === 503 && retryAfterMs !== undefined));
    if (!retryable) return res;
    const delay = retryDelayMs(attempt, retryAfterMs, waitedMs);
    if (delay === undefined) return res;
    logger.warn('Dialpad asked us to slow down; retrying', { status: res.status, path: label, delayMs: delay });
    await res.body?.cancel().catch(() => undefined);
    await sleep(delay);
    waitedMs += delay;
    res = await fetch(url, makeInit());
  }
}
