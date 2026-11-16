import { DialpadApiError, DialpadAuthError, DialpadRateLimitError } from '../types.js';
import type { DialpadPage } from '../types.js';

/**
 * Call search. Dialpad's API has no text search over calls: GET /call filters only by
 * start time and target, and AI recaps / transcripts are read one call at a time.
 * So this pages through calls in a date range and matches the text client-side
 * against the contact name, contact phone and external number. With search_recaps
 * it also reads the AI recap of up to max_recap_reads further connected calls and
 * matches the summary, action items and purposes.
 *
 * Limits: Dialpad allows about 12 AI-recap reads per minute, so recap reads are
 * spaced RECAP_GAP_MS apart. The Cititec MCP host gives each tool call 60 seconds,
 * so recap reads are capped at MAX_RECAP_READS per search.
 */

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_MAX_CALLS = 500;
export const MAX_CALLS_LIMIT = 2000;
export const DEFAULT_RECAP_READS = 8;
export const MAX_RECAP_READS = 10;
export const RECAP_GAP_MS = 5000;
/**
 * The MCP host ends a tool call after 60 s and returns nothing, so the search
 * stops itself well before that and returns what it has, saying how far it got.
 * Listing gets the whole budget, or about half when recaps are also searched.
 * Each check leaves REQUEST_RESERVE_MS for the request it is about to make.
 */
export const TIME_BUDGET_MS = 40_000;
export const LIST_BUDGET_WITH_RECAPS_MS = 20_000;
export const REQUEST_RESERVE_MS = 5_000;
/** A query made only of digits and phone punctuation (+, spaces, brackets, dots, dashes). */
export const PHONE_LIKE = /^[+\d\s().-]+$/;

export interface SearchDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: SearchDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

type Get = <T>(path: string, query?: Record<string, unknown>) => Promise<T>;
type Call = Record<string, unknown>;

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Where the search text was found in a call's list entry, or null. */
export function callMatch(call: Call, needle: string, digits: string): string | null {
  const contact = call.contact;
  if (text(field(contact, 'name')).toLowerCase().includes(needle)) return 'contact_name';
  if (digits.length >= 4) {
    // Dialpad stores E.164 (+61 2 ...); a locally written number (02 ...) has a trunk 0 to drop.
    const forms = digits.startsWith('0') && digits.length > 4 ? [digits, digits.slice(1)] : [digits];
    for (const n of [field(contact, 'phone'), call.external_number]) {
      const d = text(n).replace(/\D/g, '');
      if (forms.some((f) => d.includes(f))) return 'number';
    }
  }
  return null;
}

/** The searchable text of an AI recap: summary, action items and purposes. */
export function recapText(recap: unknown): string {
  const parts: string[] = [text(field(field(recap, 'summary'), 'content'))];
  for (const key of ['action_items', 'purposes']) {
    const list = field(recap, key);
    if (Array.isArray(list)) for (const item of list) parts.push(text(field(item, 'content')));
  }
  return parts.filter(Boolean).join('\n');
}

export async function searchCalls(
  first: { path: string; query: Record<string, unknown> },
  args: Record<string, unknown>,
  get: Get,
  trim: (c: Call) => Record<string, unknown>,
  deps: SearchDeps = defaultDeps
): Promise<unknown> {
  const raw = text(args.query).trim();
  const needle = raw.toLowerCase();
  // Match numbers by digits only when the query looks like a phone number; for text such as
  // "ISO 27001" the digits must not match unrelated phone numbers.
  const digits = PHONE_LIKE.test(raw) ? raw.replace(/\D/g, '') : '';
  const maxCalls = typeof args.max_calls === 'number' ? args.max_calls : DEFAULT_MAX_CALLS;
  const searchRecaps = args.search_recaps === true;
  const maxRecaps = typeof args.max_recap_reads === 'number' ? args.max_recap_reads : DEFAULT_RECAP_READS;

  const query: Record<string, unknown> = { ...first.query };
  delete query.query;
  delete query.max_calls;
  delete query.search_recaps;
  delete query.max_recap_reads;
  if (query.started_after === undefined) {
    query.started_after = deps.now() - DEFAULT_WINDOW_DAYS * 24 * 3600 * 1000;
  }

  const matches: Record<string, unknown>[] = [];
  const unmatchedConnected: Call[] = [];
  const notes: string[] = [];
  let scanned = 0;
  let cursor: string | null | undefined;
  let more = false;
  let outOfTime = false;
  let oldestStarted: unknown;
  const started = deps.now();
  const elapsed = () => deps.now() - started;
  const listBudget = searchRecaps ? LIST_BUDGET_WITH_RECAPS_MS : TIME_BUDGET_MS;

  do {
    if (scanned > 0 && elapsed() + REQUEST_RESERVE_MS > listBudget) {
      outOfTime = true;
      break;
    }
    const page = await get<DialpadPage<Call>>(first.path, cursor ? { ...query, cursor } : query);
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const c of items) {
      if (scanned >= maxCalls) {
        more = true;
        break;
      }
      scanned++;
      if (c.date_started !== undefined) oldestStarted = c.date_started;
      const where = callMatch(c, needle, digits);
      if (where) matches.push({ ...trim(c), matched_on: where });
      else if (c.date_connected) unmatchedConnected.push(c);
    }
    cursor = page?.cursor;
    if (scanned >= maxCalls && cursor) more = true;
  } while (cursor && scanned < maxCalls);

  if (more) {
    notes.push(
      `Stopped after ${scanned} calls (max_calls). Narrow the date range or raise max_calls (up to ${MAX_CALLS_LIMIT}) to search further.`
    );
  }
  if (outOfTime) {
    const back = typeof oldestStarted === 'number' || typeof oldestStarted === 'string'
      ? ` back to ${new Date(Number(oldestStarted)).toISOString()}` : '';
    notes.push(
      `Stopped listing at the time limit after ${scanned} calls (searched${back}; older calls in the range were not checked). ` +
        'Narrow the date range (started_after/started_before) or pick one user or call center (target_id) to search the rest.'
    );
  }

  let recapReads = 0;
  // Calls whose recap was actually checked: read successfully, or confirmed to have none (404).
  let recapChecked = 0;
  if (searchRecaps) {
    const toRead = unmatchedConnected.slice(0, maxRecaps);
    for (const c of toRead) {
      const id = c.call_id ?? c.id;
      if (id === undefined || id === null) continue;
      const gap = recapReads > 0 ? RECAP_GAP_MS : 0;
      if (elapsed() + gap + REQUEST_RESERVE_MS > TIME_BUDGET_MS) {
        notes.push('Stopped reading AI recaps at the time limit.');
        break;
      }
      if (gap) await deps.sleep(gap);
      recapReads++;
      try {
        const recap = await get<unknown>(`/call/${encodeURIComponent(String(id))}/ai_recap`);
        recapChecked++;
        const body = recapText(recap);
        if (body.toLowerCase().includes(needle)) {
          matches.push({
            ...trim(c),
            matched_on: 'ai_recap',
            recap_summary: text(field(field(recap, 'summary'), 'content')).slice(0, 600),
          });
        }
      } catch (err) {
        if (err instanceof DialpadApiError && err.status === 404) {
          recapChecked++; // no recap for this call
          continue;
        }
        if (err instanceof DialpadAuthError) {
          notes.push('AI recaps could not be read: the Dialpad API key may be missing the ai_recap scope.');
          break;
        }
        if (err instanceof DialpadRateLimitError) {
          notes.push(`Stopped reading AI recaps: Dialpad rate-limited them. Try again in ${err.retryAfterSeconds ?? 60} s.`);
          break;
        }
        throw err;
      }
    }
    const left = unmatchedConnected.length - recapChecked;
    if (left > 0) {
      notes.push(
        `AI recaps were checked for ${recapChecked} of the ${unmatchedConnected.length} connected calls that did not already match; ${left} were not checked. ` +
          `Dialpad allows about 12 recap reads per minute, so search a shorter date range, or one user or call center (target_id), to check others.`
      );
    }
  } else if (matches.length === 0) {
    notes.push('No contact name or number matched. Set search_recaps to also search the AI recap text of recent connected calls.');
  }

  return {
    query: raw,
    started_after: query.started_after,
    ...(query.started_before !== undefined ? { started_before: query.started_before } : {}),
    calls_scanned: scanned,
    ...(outOfTime || notes.includes('Stopped reading AI recaps at the time limit.') ? { time_limited: true } : {}),
    recap_reads: recapReads,
    recaps_checked: recapChecked,
    match_count: matches.length,
    matches,
    ...(notes.length ? { notes } : {}),
  };
}
