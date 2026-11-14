import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_SPECS,
  ALL_TOOLS,
  READ_TOOL_NAMES,
  SENSITIVE_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  dispatchToolCall,
} from '../tools/index.js';
import { buildRequest } from '../tools/spec.js';
import { BASE_URL, parseJsonKeepingBigIds, runWithCredentials } from '../client.js';
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

function call(name: string, args: Record<string, unknown> = {}) {
  return runWithCredentials(creds, () => dispatchToolCall(name, args));
}

function lastRequest(): { url: URL; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url: new URL(url), init };
}

/** Example arguments that satisfy each tool's required parameters. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  dialpad_get_user: { id: '123' },
  dialpad_get_office: { id: '123' },
  dialpad_get_department: { id: '123' },
  dialpad_get_callcenter: { id: '123' },
  dialpad_get_callcenter_status: { id: '123' },
  dialpad_get_call: { id: '123' },
  dialpad_get_call_transcript: { call_id: '123' },
  dialpad_get_contact: { id: 'abc123' },
  dialpad_get_number: { number: '+61299999999' },
  dialpad_create_stats_export: { export_type: 'records', stat_type: 'calls' },
  dialpad_get_stats_export: { id: '123' },
  dialpad_get_call_subscription: { id: '123' },
  dialpad_create_contact: { first_name: 'Test', last_name: 'Person' },
  dialpad_update_contact: { id: 'abc123', job_title: 'Engineer' },
  dialpad_delete_contact: { id: 'abc123' },
  dialpad_send_sms: { text: 'hello', channel_hashtag: 'n8n', from_number: '+61299999999' },
  dialpad_update_call_subscription: { id: '123', enabled: false },
};

describe('tool scope', () => {
  it('exposes exactly the expected tools', () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'dialpad_get_company',
        'dialpad_list_users',
        'dialpad_get_user',
        'dialpad_list_offices',
        'dialpad_get_office',
        'dialpad_list_departments',
        'dialpad_get_department',
        'dialpad_list_callcenters',
        'dialpad_get_callcenter',
        'dialpad_get_callcenter_status',
        'dialpad_list_calls',
        'dialpad_get_call',
        'dialpad_get_call_transcript',
        'dialpad_list_contacts',
        'dialpad_get_contact',
        'dialpad_list_numbers',
        'dialpad_get_number',
        'dialpad_create_stats_export',
        'dialpad_get_stats_export',
        'dialpad_list_call_subscriptions',
        'dialpad_get_call_subscription',
        'dialpad_list_webhooks',
        'dialpad_create_contact',
        'dialpad_update_contact',
        'dialpad_delete_contact',
        'dialpad_send_sms',
        'dialpad_update_call_subscription',
      ].sort()
    );
  });

  it('pins the write tools (host write_tools) and sensitive tools (admin-gated)', () => {
    expect([...WRITE_TOOL_NAMES].sort()).toEqual([
      'dialpad_create_contact',
      'dialpad_delete_contact',
      'dialpad_send_sms',
      'dialpad_update_call_subscription',
      'dialpad_update_contact',
    ]);
    expect([...SENSITIVE_TOOL_NAMES].sort()).toEqual([
      'dialpad_create_stats_export',
      'dialpad_get_call',
      'dialpad_get_call_transcript',
      'dialpad_get_contact',
      'dialpad_get_stats_export',
      'dialpad_list_calls',
      'dialpad_list_contacts',
      'dialpad_list_webhooks',
    ]);
    expect(READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length).toBe(ALL_TOOLS.length);
  });

  it('marks write tools as not read-only and the delete as destructive', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.annotations?.readOnlyHint).toBe(!WRITE_TOOL_NAMES.includes(tool.name));
    }
    expect(ALL_TOOLS.find((t) => t.name === 'dialpad_delete_contact')?.annotations?.destructiveHint).toBe(true);
  });

  it('read tools only ever send GET (the stats export request is the one documented POST)', async () => {
    for (const spec of ALL_SPECS.filter((s) => s.kind !== 'write')) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({ items: [], cursor: null }));
      const result = await call(spec.name, SAMPLE_ARGS[spec.name] ?? {});
      expect(result.isError, `${spec.name}: ${textOf(result)}`).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = lastRequest();
      const expected = spec.kind === 'export' ? 'POST' : 'GET';
      expect(init.method, spec.name).toBe(expected);
      expect(url.href.startsWith(`${BASE_URL}/`), url.href).toBe(true);
      if (spec.kind === 'export') expect(url.pathname).toBe('/api/v2/stats');
    }
  });

  it('every tool sends the API key as a Bearer token', async () => {
    for (const spec of ALL_SPECS) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(jsonResponse({}));
      await call(spec.name, SAMPLE_ARGS[spec.name] ?? {});
      const { init } = lastRequest();
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    }
  });

  it('has a sample for every tool with required parameters', () => {
    for (const tool of ALL_TOOLS) {
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      if (required.length) expect(SAMPLE_ARGS[tool.name], tool.name).toBeDefined();
    }
  });
});

describe('input checks', () => {
  const spec = (name: string) => ALL_SPECS.find((s) => s.name === name)!;

  it('URL-encodes path IDs and rejects non-numeric IDs', () => {
    expect(() => buildRequest(spec('dialpad_get_call'), { id: '../users' })).toThrow(/numeric/);
    expect(buildRequest(spec('dialpad_get_contact'), { id: 'a/b?c' }).path).toBe('/contacts/a%2Fb%3Fc');
    expect(buildRequest(spec('dialpad_get_number'), { number: '+61299999999' }).path).toBe('/numbers/%2B61299999999');
  });

  it('rejects unknown parameters instead of passing them through', () => {
    expect(() => buildRequest(spec('dialpad_list_users'), { path: '/admin' })).toThrow(/Unknown parameter/);
  });

  it('accepts "me" only for the user tool', () => {
    expect(buildRequest(spec('dialpad_get_user'), { id: 'me' }).path).toBe('/users/me');
    expect(() => buildRequest(spec('dialpad_get_office'), { id: 'me' })).toThrow();
  });

  it('converts call time filters to epoch milliseconds', () => {
    const { query } = buildRequest(spec('dialpad_list_calls'), {
      started_after: '2026-03-15T00:00:00Z',
      started_before: 1774137599000,
    });
    expect(query).toEqual({ started_after: Date.parse('2026-03-15T00:00:00Z'), started_before: 1774137599000 });
  });

  it('requires target_type with target_id', () => {
    expect(() => buildRequest(spec('dialpad_list_calls'), { target_id: '1' })).toThrow(/target_type/);
  });

  it('checks phone numbers are E.164', () => {
    expect(() => buildRequest(spec('dialpad_create_contact'), { first_name: 'a', last_name: 'b', phones: ['0299999999'] })).toThrow(
      /E\.164/
    );
  });

  it('SMS needs exactly one destination and a sender', () => {
    const s = spec('dialpad_send_sms');
    expect(() => buildRequest(s, { text: 'x', from_number: '+61299999999' })).toThrow(/either/);
    expect(() =>
      buildRequest(s, { text: 'x', channel_hashtag: 'n8n', to_numbers: ['+61299999999'], from_number: '+61299999999' })
    ).toThrow(/either/);
    expect(() => buildRequest(s, { text: 'x', channel_hashtag: 'n8n' })).toThrow(/sender/);
    expect(() => buildRequest(s, { text: 'x', to_numbers: Array(11).fill('+61299999999'), user_id: '1' })).toThrow(/at most 10/);
  });

  it('update tools need at least one change', () => {
    expect(() => buildRequest(spec('dialpad_update_contact'), { id: 'abc' })).toThrow(/at least one/);
    expect(() => buildRequest(spec('dialpad_update_call_subscription'), { id: '1' })).toThrow(/enabled/);
  });

  it('accepts only call states from the Dialpad spec', () => {
    const s = spec('dialpad_update_call_subscription');
    expect(buildRequest(s, { id: '1', call_states: ['connected', 'hangup'] }).body).toEqual({
      call_states: ['connected', 'hangup'],
    });
    expect(() => buildRequest(s, { id: '1', call_states: ['connected', 'everything'] })).toThrow(/must be one of/);
  });

  it('takes the stats export request_id as a string', () => {
    expect(buildRequest(spec('dialpad_get_stats_export'), { id: 'abc-123' }).path).toBe('/stats/abc-123');
  });

  it('never sends the local-only full option to Dialpad', () => {
    const { query } = buildRequest(spec('dialpad_list_contacts'), { full: true, include_local: true });
    expect(query).toEqual({ include_local: true });
  });
});

describe('requests match the N8N workflows', () => {
  it('lists a window of calls like "get month of dialpad calls"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], cursor: null }));
    await call('dialpad_list_calls', { started_after: 1773532800000, started_before: 1774137599000 });
    const { url, init } = lastRequest();
    expect(init.method).toBe('GET');
    expect(url.pathname).toBe('/api/v2/call');
    expect(url.searchParams.get('started_after')).toBe('1773532800000');
    expect(url.searchParams.get('started_before')).toBe('1774137599000');
  });

  it('creates a contact with the Autotask sync fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '9007199254740993' }));
    const result = await call('dialpad_create_contact', {
      first_name: 'Test',
      last_name: 'Person ACME',
      phones: ['+61299999999'],
      company_name: 'Example Pty Ltd',
      emails: ['test@example.com'],
    });
    const { url, init } = lastRequest();
    expect(init.method).toBe('POST');
    expect(url.pathname).toBe('/api/v2/contacts');
    expect(JSON.parse(init.body as string)).toEqual({
      first_name: 'Test',
      last_name: 'Person ACME',
      phones: ['+61299999999'],
      company_name: 'Example Pty Ltd',
      emails: ['test@example.com'],
    });
    // A 16+ digit ID comes back exact, not rounded.
    expect(JSON.parse(textOf(result)).id).toBe('9007199254740993');
  });

  it('patches and deletes a contact by ID', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await call('dialpad_update_contact', { id: 'abc123', phones: ['+61299999999'] });
    expect(lastRequest().init.method).toBe('PATCH');
    expect(lastRequest().url.pathname).toBe('/api/v2/contacts/abc123');
    await call('dialpad_delete_contact', { id: 'abc123' });
    expect(lastRequest().init.method).toBe('DELETE');
    expect(lastRequest().init.body).toBeUndefined();
  });

  it('posts a channel notification like the N8N alert nodes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', message_status: 'pending' }));
    await call('dialpad_send_sms', {
      text: 'Workflow finished',
      channel_hashtag: 'n8n',
      from_number: '+61299999999',
      infer_country_code: false,
    });
    const { url, init } = lastRequest();
    expect(url.pathname).toBe('/api/v2/sms');
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Workflow finished',
      channel_hashtag: 'n8n',
      from_number: '+61299999999',
      infer_country_code: false,
    });
  });

  it('pauses the call subscription with enabled and call_states only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await call('dialpad_update_call_subscription', { id: '123', enabled: false, call_states: ['connected'] });
    const { url, init } = lastRequest();
    expect(init.method).toBe('PATCH');
    expect(url.pathname).toBe('/api/v2/subscriptions/call/123');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false, call_states: ['connected'] });
  });
});

describe('responses are trimmed', () => {
  it('trims call list items and returns the cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            call_id: '1',
            direction: 'inbound',
            duration: 12000,
            external_number: '+61299999999',
            routing_breadcrumbs: Array(50).fill({ big: 'x'.repeat(100) }),
            contact: { id: '5', name: 'Test Person', phone: '+61299999999', email: 'test@example.com' },
          },
        ],
        cursor: 'next-page',
      })
    );
    const out = JSON.parse(textOf(await call('dialpad_list_calls')));
    expect(out.count).toBe(1);
    expect(out.next_cursor).toBe('next-page');
    expect(out.items[0].routing_breadcrumbs).toBeUndefined();
    expect(out.items[0].contact).toEqual({ id: '5', name: 'Test Person', phone: '+61299999999' });
  });

  it('returns full items when asked', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: '1', extra: 'kept' }] }));
    const out = JSON.parse(textOf(await call('dialpad_list_contacts', { full: true })));
    expect(out.items[0].extra).toBe('kept');
  });

  it('never returns a webhook signing secret', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ id: '1', hook_url: 'https://hooks.example.com/x', signature: { secret: 'shh', type: 'jwt' } }] })
    );
    const text = textOf(await call('dialpad_list_webhooks'));
    expect(text).not.toContain('shh');
    expect(JSON.parse(text).items[0].signature).toBe('[withheld]');
  });

  it('limits transcript lines', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({ time: i, name: 'A', type: 'transcript', content: `line ${i}`, user_id: 'x' }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ call_id: '1', lines }));
    const out = JSON.parse(textOf(await call('dialpad_get_call_transcript', { call_id: '1', max_lines: 3 })));
    expect(out.line_count).toBe(10);
    expect(out.lines).toHaveLength(3);
    expect(out.lines[0]).toEqual({ time: 0, name: 'A', type: 'transcript', content: 'line 0' });
  });

  it('cuts very large responses', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: '1', notes: 'x'.repeat(100_000) }));
    const text = textOf(await call('dialpad_get_office', { id: '1' }));
    expect(text.length).toBeLessThan(61_000);
    expect(text).toMatch(/response cut/);
  });
});

describe('errors', () => {
  it('reports 401, 403 and 429 distinctly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    expect(textOf(await call('dialpad_get_company'))).toMatch(/rejected the API key/);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));
    expect(textOf(await call('dialpad_list_numbers'))).toMatch(/company admin key/);
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    expect(textOf(await call('dialpad_get_company'))).toMatch(/rate-limited/);
  });

  it('includes the Dialpad error message but not the query string', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'bad cursor' } }, 400));
    const text = textOf(await call('dialpad_list_calls', { started_after: 1773532800000 }));
    expect(text).toMatch(/HTTP 400 - bad cursor/);
    expect(text).not.toContain('1773532800000');
  });

  it('reports missing credentials without calling Dialpad', async () => {
    delete process.env.DIALPAD_API_KEY;
    const result = await dispatchToolCall('dialpad_get_company', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/DIALPAD_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown tools', async () => {
    expect((await call('dialpad_run_anything')).isError).toBe(true);
  });
});

describe('parseJsonKeepingBigIds', () => {
  it('keeps int64 IDs exact and leaves small numbers alone', () => {
    const parsed = parseJsonKeepingBigIds('{"id": 1234567890123456789, "items":[9007199254740993], "duration": 1200}') as {
      id: string;
      items: string[];
      duration: number;
    };
    expect(parsed.id).toBe('1234567890123456789');
    expect(parsed.items[0]).toBe('9007199254740993');
    expect(parsed.duration).toBe(1200);
  });

  it('handles an empty body (e.g. DELETE)', () => {
    expect(parseJsonKeepingBigIds('')).toEqual({});
  });
});
