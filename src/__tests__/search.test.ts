import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchToolCall } from '../tools/index.js';
import { runWithCredentials } from '../client.js';
import { RECAP_GAP_MS, callMatch, recapText, searchCalls } from '../tools/search.js';
import { DialpadApiError, DialpadAuthError } from '../types.js';
import { jsonResponse, textOf } from './test-helpers.js';

const creds = { apiKey: 'test-key' };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 16);
const noSleep = { sleep: vi.fn(async () => {}), now: () => NOW };
const trim = (c: Record<string, unknown>) => ({ call_id: c.call_id });

const calls = [
  { call_id: '1', contact: { name: 'InTouch Health', phone: '+61390000001' }, external_number: '+61390000001', date_connected: '1' },
  { call_id: '2', contact: { name: 'Acme', phone: '+61390000002' }, external_number: '+61390000002', date_connected: '1' },
  { call_id: '3', contact: { name: 'Beta' }, external_number: '+61390000003' },
  { call_id: '4', contact: { name: 'Gamma' }, external_number: '+61390000004', date_connected: '1' },
];

describe('callMatch / recapText', () => {
  it('matches contact name case-insensitively and numbers by digits', () => {
    expect(callMatch(calls[0], 'intouch', '')).toBe('contact_name');
    expect(callMatch(calls[1], 'xyz', '0390000002'.replace(/^0/, ''))).toBe('number');
    expect(callMatch(calls[1], 'xyz', '12')).toBeNull(); // fewer than 4 digits: no number match
  });

  it('joins summary, action items and purposes', () => {
    const t = recapText({ summary: { content: 'S' }, action_items: [{ content: 'A' }], purposes: [{ content: 'P' }] });
    expect(t).toBe('S\nA\nP');
  });
});

describe('searchCalls', () => {
  it('defaults to the last 30 days and pages until the cursor ends', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: calls.slice(0, 2), cursor: 'c2' })
      .mockResolvedValueOnce({ items: calls.slice(2), cursor: null });
    const out = (await searchCalls({ path: '/call', query: {} }, { query: 'InTouch' }, get, trim, noSleep)) as any;
    expect(get.mock.calls[0][1].started_after).toBe(NOW - 30 * 24 * 3600 * 1000);
    expect(get.mock.calls[1][1].cursor).toBe('c2');
    expect(out.calls_scanned).toBe(4);
    expect(out.matches).toEqual([{ call_id: '1', matched_on: 'contact_name' }]);
    expect(out.recap_reads).toBe(0);
  });

  it('matches numbers only for phone-like queries, not digits inside text', async () => {
    const items = [{ call_id: '9', contact: { name: 'Unrelated' }, external_number: '+61270011234' }];
    const get = vi.fn().mockResolvedValue({ items, cursor: null });
    const text = (await searchCalls({ path: '/call', query: {} }, { query: 'ISO 27001' }, get, trim, noSleep)) as any;
    expect(text.match_count).toBe(0);
    const phone = (await searchCalls({ path: '/call', query: {} }, { query: '(02) 7001 1234' }, get, trim, noSleep)) as any;
    expect(phone.matches).toEqual([{ call_id: '9', matched_on: 'number' }]);
  });

  it('stops at max_calls and says so', async () => {
    const get = vi.fn().mockResolvedValueOnce({ items: calls, cursor: 'more' });
    const out = (await searchCalls({ path: '/call', query: {} }, { query: 'zzz', max_calls: 2 }, get, trim, noSleep)) as any;
    expect(get).toHaveBeenCalledTimes(1);
    expect(out.calls_scanned).toBe(2);
    expect(out.notes.join(' ')).toMatch(/Stopped after 2 calls/);
  });

  it('searches recaps of unmatched connected calls, spaced out, skipping calls without a recap', async () => {
    const sleep = vi.fn(async () => {});
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: calls, cursor: null })
      // call 2 recap mentions intouch; call 4 has no recap (404)
      .mockResolvedValueOnce({ summary: { content: 'Customer asked about the InTouch rollout' } })
      .mockRejectedValueOnce(new DialpadApiError('not found', 404));
    const out = (await searchCalls(
      { path: '/call', query: {} },
      { query: 'intouch', search_recaps: true },
      get,
      trim,
      { sleep, now: () => NOW }
    )) as any;
    // call 1 matched by name; recaps read for connected, unmatched calls 2 and 4 (call 3 never connected)
    expect(get.mock.calls.slice(1).map((c) => c[0])).toEqual(['/call/2/ai_recap', '/call/4/ai_recap']);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(RECAP_GAP_MS);
    expect(out.recap_reads).toBe(2);
    expect(out.matches.map((m: any) => [m.call_id, m.matched_on])).toEqual([
      ['1', 'contact_name'],
      ['2', 'ai_recap'],
    ]);
    expect(out.matches[1].recap_summary).toContain('InTouch rollout');
  });

  it('caps recap reads and reports a missing ai_recap scope', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: calls, cursor: null })
      .mockRejectedValueOnce(new DialpadAuthError('forbidden', 403));
    const out = (await searchCalls(
      { path: '/call', query: {} },
      { query: 'nomatch', search_recaps: true, max_recap_reads: 1 },
      get,
      trim,
      noSleep
    )) as any;
    expect(get).toHaveBeenCalledTimes(2);
    expect(out.notes.join(' ')).toMatch(/ai_recap scope/);
    // The one attempted read failed, so nothing was checked: all 3 connected, unmatched calls are unchecked.
    expect(out.recaps_checked).toBe(0);
    expect(out.notes.join(' ')).toMatch(/checked for 0 of the 3 .* 3 were not checked/);
  });

  it('reports actual coverage when recap reads stop early', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: calls, cursor: null })
      .mockResolvedValueOnce({ summary: { content: 'nothing relevant' } })
      .mockRejectedValueOnce(new DialpadAuthError('forbidden', 403));
    const out = (await searchCalls(
      { path: '/call', query: {} },
      { query: 'nomatch', search_recaps: true },
      get,
      trim,
      noSleep
    )) as any;
    expect(out.recap_reads).toBe(2);
    expect(out.recaps_checked).toBe(1);
    expect(out.notes.join(' ')).toMatch(/checked for 1 of the 3 .* 2 were not checked/);
  });
});

describe('tools through dispatch', () => {
  function call(name: string, args: Record<string, unknown>) {
    return runWithCredentials(creds, () => dispatchToolCall(name, args));
  }

  it('dialpad_search_calls sends only GET /call with Dialpad filters, never the local options', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [calls[0]], cursor: null }));
    const res = await call('dialpad_search_calls', { query: 'intouch', started_after: '2026-11-01T00:00:00Z', max_calls: 50 });
    expect(res.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toMatch(/\/call$/);
    expect((init.method ?? 'GET').toUpperCase()).toBe('GET');
    expect(u.searchParams.get('started_after')).toBe(String(Date.UTC(2026, 10, 1)));
    expect(u.searchParams.has('query')).toBe(false);
    expect(u.searchParams.has('max_calls')).toBe(false);
    expect(JSON.parse(textOf(res)).match_count).toBe(1);
  });

  it('dialpad_search_calls rejects a one-character query without calling Dialpad', async () => {
    const res = await call('dialpad_search_calls', { query: 'a' });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dialpad_get_call_ai_recap trims the recap', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        call_id: 123,
        source: 'model-x',
        summary: { content: 'Summary text', format: 'medium', id: 9 },
        action_items: [{ content: 'Call back', id: 1 }],
        purposes: [{ content: 'Support', category: 'support' }],
        disposition: { content: 'Resolved', id: 2 },
      })
    );
    const res = await call('dialpad_get_call_ai_recap', { id: '123', summary_format: 'bullet' });
    const u = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(u.pathname).toMatch(/\/call\/123\/ai_recap$/);
    expect(u.searchParams.get('summary_format')).toBe('bullet');
    const out = JSON.parse(textOf(res));
    expect(out.summary.content).toBe('Summary text');
    expect(out.action_items).toEqual([{ content: 'Call back' }]);
    expect(out.source).toBeUndefined();
  });

  it('dialpad_search_contacts needs name, phone or email', async () => {
    const bad = await call('dialpad_search_contacts', {});
    expect(bad.isError).toBe(true);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: 'x', display_name: 'InTouch Health' }], cursor: null }));
    const ok = await call('dialpad_search_contacts', { name: 'intouch' });
    const u = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(u.pathname).toMatch(/\/contacts\/search$/);
    expect(u.searchParams.get('name')).toBe('intouch');
    expect(JSON.parse(textOf(ok)).items[0].display_name).toBe('InTouch Health');
  });
});

describe('searchCalls time budget', () => {
  // Fake clock: every Dialpad request takes 8 s; sleeps advance it too.
  function slowDialpad(perPage = 1) {
    let t = NOW;
    let n = 0;
    const deps = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const get = vi.fn().mockImplementation(async (path: string) => {
      t += 8000;
      if (path === '/call') {
        n++;
        return {
          items: Array.from({ length: perPage }, (_, i) => ({ call_id: `${n}-${i}`, date_started: String(NOW - n * 3600_000), date_connected: "1", contact: { name: `Caller ${n}` } })),
          cursor: 'more',
        };
      }
      return { summary: { content: 'nothing relevant' } };
    });
    return { get, deps };
  }

  it('stops listing before the host time limit and says how far back it searched', async () => {
    const { get, deps } = slowDialpad();
    const out = (await searchCalls({ path: '/call', query: {} }, { query: 'zzz' }, get, trim, deps)) as any;
    // Pages at 0, 8, 16, 24, 32 s; the next would end past 40 s.
    expect(get).toHaveBeenCalledTimes(5);
    expect(out.calls_scanned).toBe(5);
    expect(out.time_limited).toBe(true);
    expect(out.notes.join(' ')).toMatch(/time limit after 5 calls \(searched back to \d{4}-\d\d-\d\dT/);
  });

  it('leaves time for recaps and stops reading them at the limit', async () => {
    // Two calls per page: 4 recap candidates, more than the time allows.
    const { get, deps } = slowDialpad(2);
    const out = (await searchCalls(
      { path: '/call', query: {} },
      { query: 'zzz', search_recaps: true },
      get,
      trim,
      deps
    )) as any;
    const recapCalls = get.mock.calls.filter((c) => String(c[0]).endsWith('/ai_recap'));
    // Listing stops at ~20 s (2 pages); recaps at 16 s and 29 s; a third would pass 40 s.
    expect(get.mock.calls.filter((c) => c[0] === '/call')).toHaveLength(2);
    expect(recapCalls).toHaveLength(2);
    expect(out.time_limited).toBe(true);
    expect(out.notes.join(' ')).toMatch(/Stopped reading AI recaps at the time limit/);
  });

  it('does not stop a fast search', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ items: calls.slice(0, 2), cursor: 'c2' })
      .mockResolvedValueOnce({ items: calls.slice(2), cursor: null });
    const out = (await searchCalls({ path: '/call', query: {} }, { query: 'intouch' }, get, trim, noSleep)) as any;
    expect(out.time_limited).toBeUndefined();
    expect(out.calls_scanned).toBe(4);
  });
});
