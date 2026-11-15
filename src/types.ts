/**
 * Dialpad API v2 authenticates with a company (or user) API key sent as
 * `Authorization: Bearer <key>`. There is no token exchange.
 *
 * A company admin key is needed for the number tools; other read tools work
 * with any company key. The key's own permissions are the only limit Dialpad
 * applies, so the MCP host decides which tools a person can call (read tools
 * with the read-only env file, write tools only as approved proposals).
 */
export interface DialpadCredentials {
  apiKey: string;
}

/** Dialpad rejected the API key (HTTP 401) or the key lacks permission (HTTP 403). */
export class DialpadAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Dialpad rate-limited the request (HTTP 429). Limit: 20 requests/second per company, lower for some endpoints. */
export class DialpadRateLimitError extends Error {
  /** Seconds Dialpad asked us to wait (Retry-After), when it said. */
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

/** Any other non-2xx response. */
export class DialpadApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** List endpoints return `items` and a `cursor` (absent or null on the last page). */
export interface DialpadPage<T = Record<string, unknown>> {
  items?: T[];
  cursor?: string | null;
  [key: string]: unknown;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
