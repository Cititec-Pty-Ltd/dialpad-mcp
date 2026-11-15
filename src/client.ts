import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from './utils/logger.js';
import { fetchWithRateLimitRetry, retryAfterSecondsOf } from './rate-limit.js';
import { DialpadApiError, DialpadAuthError, DialpadRateLimitError } from './types.js';
import type { DialpadCredentials, HttpMethod } from './types.js';

export const BASE_URL = 'https://dialpad.com/api/v2';

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({apiKey}); getCredentials() reads from
// it. Falls back to process.env for stdio/single-tenant mode (the MCP host).
const credStore = new AsyncLocalStorage<DialpadCredentials>();

export function runWithCredentials<T>(creds: DialpadCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(): DialpadCredentials | null {
  const scoped = credStore.getStore();
  if (scoped?.apiKey) return scoped;
  const apiKey = process.env.DIALPAD_API_KEY;
  if (!apiKey) {
    logger.warn('Missing credentials', { hasApiKey: false });
    return null;
  }
  return { apiKey };
}

function buildQuery(params: Record<string, unknown> = {}): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.append(key, String(value));
  }
  return qs;
}

/**
 * Dialpad IDs are int64 and can exceed Number.MAX_SAFE_INTEGER. JSON.parse
 * would silently round them, and a rounded ID then points at the wrong
 * record. Quote any bare integer of 16 or more digits before parsing, so it
 * arrives as an exact string.
 */
export function parseJsonKeepingBigIds(text: string): unknown {
  if (text.trim() === '') return {};
  const quoted = text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  return JSON.parse(quoted);
}

export async function request<T>(
  creds: DialpadCredentials,
  method: HttpMethod,
  path: string,
  options: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  if (!path.startsWith('/')) throw new Error(`Dialpad path must start with /: ${path}`);
  const qs = options.query ? buildQuery(options.query).toString() : '';
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  // A short 429 is retried (bounded, honouring Retry-After) inside
  // fetchWithRateLimitRetry; each attempt gets its own timeout. Dialpad does
  // not process a request it rate-limits, so retrying a write is safe.
  const res = await fetchWithRateLimitRetry(url, `${method} ${path}`, () => ({
    method,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  }));

  // Paths are logged without the query string: call-history filters and
  // phone numbers stay out of the logs.
  if (res.status === 401 || res.status === 403) {
    throw new DialpadAuthError(
      res.status === 401
        ? `Dialpad rejected the API key (HTTP 401): ${method} ${path}`
        : `The Dialpad API key is not allowed to do this (HTTP 403; number tools need a company admin key): ${method} ${path}`,
      res.status
    );
  }
  if (res.status === 429) {
    const retryAfterSeconds = retryAfterSecondsOf(res);
    throw new DialpadRateLimitError(
      `Dialpad rate-limited the request (HTTP 429): ${method} ${path}.` +
        (retryAfterSeconds !== undefined ? ` Try again in ${retryAfterSeconds} s.` : ' Wait a minute and try again.'),
      retryAfterSeconds
    );
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch {
      // no JSON body
    }
    throw new DialpadApiError(
      `Dialpad ${method} ${path} failed: HTTP ${res.status}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`,
      res.status
    );
  }
  return parseJsonKeepingBigIds(await res.text()) as T;
}
