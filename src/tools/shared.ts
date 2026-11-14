import type { DialpadCredentials } from '../types.js';
import type { CallToolResult } from './types.js';

/** Largest tool response, in characters. Bigger results are cut with a note, so one call cannot flood the conversation. */
export const MAX_RESPONSE_CHARS = 60_000;

export function textResult(value: unknown): CallToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n... [response cut at ${MAX_RESPONSE_CHARS} characters; narrow the filters or use the cursor for the next page]`;
  }
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Returns an error CallToolResult if credentials are missing, else null. */
export function requireCredentials(creds: DialpadCredentials | null): CallToolResult | null {
  if (!creds) {
    return errorResult('No Dialpad credentials configured. Set DIALPAD_API_KEY.');
  }
  return null;
}

/** Thrown for bad tool input; the message is shown to the caller as is. */
export class InputError extends Error {}

const NUMERIC_ID = /^\d{1,20}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** A Dialpad int64 ID, given as a string or a number. Returned as a string so it is never rounded. */
export function toId(value: unknown, key: string, options: { allowMe?: boolean } = {}): string {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof s !== 'string' || !(NUMERIC_ID.test(s.trim()) || (options.allowMe && s.trim() === 'me'))) {
    throw new InputError(`${key} must be a numeric Dialpad ID${options.allowMe ? " or 'me'" : ''}`);
  }
  return s.trim();
}

/** A phone number in E.164 format, e.g. +61299999999. */
export function toE164(value: unknown, key: string): string {
  if (typeof value !== 'string' || !E164.test(value.trim())) {
    throw new InputError(`${key} must be a phone number in E.164 format, e.g. +61299999999`);
  }
  return value.trim();
}

/** A time as UTC milliseconds since the epoch, from an ISO 8601 string or a millisecond number. */
export function toEpochMs(value: unknown, key: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new InputError(`${key} must be an ISO 8601 date/time (e.g. 2026-11-01T00:00:00+11:00) or milliseconds since the epoch`);
}

/** Keeps only the listed keys that are present. */
export function pick(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}
