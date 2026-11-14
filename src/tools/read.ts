import { CURSOR_PARAM, FULL_PARAM, shapePage } from './spec.js';
import type { ParamSpec, ToolSpec } from './spec.js';
import { InputError, pick } from './shared.js';

// Read tools. Each one sends GET to a fixed /api/v2 path, except
// dialpad_create_stats_export, which POSTs a report request (it starts a
// job and changes no Dialpad data).
//
// List results are trimmed to the main fields of each item (full: true
// returns every field), and every response is capped in size.

const TARGET_TYPES = [
  'callcenter',
  'callrouter',
  'channel',
  'coachinggroup',
  'coachingteam',
  'department',
  'office',
  'room',
  'staffgroup',
  'unknown',
  'user',
] as const;

const USER_FIELDS = [
  'id',
  'display_name',
  'first_name',
  'last_name',
  'emails',
  'phone_numbers',
  'extension',
  'job_title',
  'state',
  'is_admin',
  'is_super_admin',
  'office_id',
  'license',
  'on_duty_status',
] as const;

const GROUP_FIELDS = ['id', 'name', 'office_id', 'state', 'phone_numbers', 'extension', 'timezone', 'country'] as const;

const CALL_FIELDS = [
  'call_id',
  'date_started',
  'date_connected',
  'date_ended',
  'direction',
  'state',
  'duration',
  'total_duration',
  'external_number',
  'internal_number',
  'was_recorded',
  'is_transferred',
  'master_call_id',
  'entry_point_call_id',
  'labels',
] as const;

const CONTACT_FIELDS = [
  'id',
  'display_name',
  'first_name',
  'last_name',
  'company_name',
  'job_title',
  'phones',
  'emails',
  'primary_phone',
  'primary_email',
  'extension',
  'type',
  'owner_id',
] as const;

const NUMBER_FIELDS = ['number', 'type', 'status', 'area_code', 'target_id', 'target_type', 'office_id'] as const;

function trimCall(c: Record<string, unknown>): Record<string, unknown> {
  const out = pick(c, CALL_FIELDS);
  for (const key of ['contact', 'target', 'entry_point_target']) {
    const v = pick(c[key], ['id', 'name', 'type', 'phone']);
    if (Object.keys(v).length) out[key] = v;
  }
  return out;
}

/** Webhook objects carry the HMAC signing secret; never return it. */
function stripWebhookSecret(w: unknown): unknown {
  if (!w || typeof w !== 'object') return w;
  const copy: Record<string, unknown> = { ...(w as Record<string, unknown>) };
  if ('signature' in copy) copy.signature = copy.signature ? '[withheld]' : copy.signature;
  return copy;
}

function trimSubscription(s: Record<string, unknown>): Record<string, unknown> {
  const out = pick(s, ['id', 'enabled', 'call_states', 'group_calls_only', 'target_id', 'target_type']);
  const hook = pick(s.webhook, ['id', 'hook_url']);
  if (Object.keys(hook).length) out.webhook = hook;
  const ws = pick(s.websocket, ['id']);
  if (Object.keys(ws).length) out.websocket = ws;
  return out;
}

const idParam = (what: string): ParamSpec => ({
  type: 'id',
  in: 'path',
  required: true,
  description: `${what} ID (numeric).`,
});

const PII_NOTE = ' Contains personal information - admin-gated.';

export const READ_SPECS: ToolSpec[] = [
  // ---------------------------------------------------------------- company
  {
    name: 'dialpad_get_company',
    description: 'Get the Dialpad company: name, domain, country, account type, office count and AI settings.',
    kind: 'read',
    method: 'GET',
    path: '/company',
    params: {},
  },

  // ---------------------------------------------------------------- users
  {
    name: 'dialpad_list_users',
    description:
      'List Dialpad users (staff) with name, email, phone numbers, extension, office and state. Filter by email, by phone number, or by first/last name prefix. Defaults to active users.',
    kind: 'read',
    method: 'GET',
    path: '/users',
    params: {
      email: { type: 'string', in: 'query', description: 'Exact email address.' },
      number: { type: 'e164', in: 'query', description: 'A phone number assigned to the user, in E.164 format.' },
      first_name: { type: 'string', in: 'query', description: 'First-name prefix. Cannot be combined with email or number.' },
      last_name: { type: 'string', in: 'query', description: 'Last-name prefix. Cannot be combined with email or number.' },
      state: {
        type: 'string',
        in: 'query',
        enum: ['active', 'all', 'cancelled', 'deleted', 'pending', 'suspended'],
        description: 'User state (default active).',
      },
      company_admin: { type: 'boolean', in: 'query', description: 'Only company admins (true) or only non-admins (false).' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    validate: (a) => {
      if ((a.first_name || a.last_name) && (a.email || a.number)) {
        throw new InputError('first_name/last_name cannot be combined with email or number');
      }
    },
    shape: shapePage((u) => pick(u, USER_FIELDS)),
  },
  {
    name: 'dialpad_get_user',
    description: "Get one Dialpad user by ID ('me' for the API key's own user, with a user-level key).",
    kind: 'read',
    method: 'GET',
    path: '/users/{id}',
    params: { id: { type: 'user_id', in: 'path', required: true, description: "User ID (numeric) or 'me'." } },
  },

  // ---------------------------------------------------------------- offices
  {
    name: 'dialpad_list_offices',
    description: 'List Dialpad offices (sites) with ID, name, state and main numbers.',
    kind: 'read',
    method: 'GET',
    path: '/offices',
    params: {
      name_search: { type: 'string', in: 'query', description: 'Text to match in the office name.' },
      active_only: { type: 'boolean', in: 'query', description: 'Only active offices.' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    shape: shapePage((o) => pick(o, GROUP_FIELDS)),
  },
  {
    name: 'dialpad_get_office',
    description: 'Get one Dialpad office by ID, including its settings and numbers.',
    kind: 'read',
    method: 'GET',
    path: '/offices/{id}',
    params: { id: idParam('Office') },
  },

  // ---------------------------------------------------------------- departments
  {
    name: 'dialpad_list_departments',
    description: 'List departments (ring groups) across the company, optionally for one office.',
    kind: 'read',
    method: 'GET',
    path: '/departments',
    params: {
      office_id: { type: 'id', in: 'query', description: 'Only departments in this office.' },
      name_search: { type: 'string', in: 'query', description: 'Text to match in the department name.' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    shape: shapePage((d) => pick(d, GROUP_FIELDS)),
  },
  {
    name: 'dialpad_get_department',
    description: 'Get one department by ID, including its routing and hours settings.',
    kind: 'read',
    method: 'GET',
    path: '/departments/{id}',
    params: { id: idParam('Department') },
  },

  // ---------------------------------------------------------------- call centers
  {
    name: 'dialpad_list_callcenters',
    description: 'List call centers (queues) across the company, optionally for one office.',
    kind: 'read',
    method: 'GET',
    path: '/callcenters',
    params: {
      office_id: { type: 'id', in: 'query', description: 'Only call centers in this office.' },
      name_search: { type: 'string', in: 'query', description: 'Text to match in the call center name.' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    shape: shapePage((c) => pick(c, GROUP_FIELDS)),
  },
  {
    name: 'dialpad_get_callcenter',
    description: 'Get one call center by ID, including its routing, hours and alert settings.',
    kind: 'read',
    method: 'GET',
    path: '/callcenters/{id}',
    params: { id: idParam('Call center') },
  },
  {
    name: 'dialpad_get_callcenter_status',
    description:
      'Get live status for one call center: availability, operators on duty, calls waiting and longest wait time.',
    kind: 'read',
    method: 'GET',
    path: '/callcenters/{id}/status',
    params: { id: idParam('Call center') },
  },

  // ---------------------------------------------------------------- calls
  {
    name: 'dialpad_list_calls',
    description:
      'List finished calls, newest first: times, direction, duration, internal and external number, contact and target. Filter by start time range and by target (user, office, department, call center...). Returns one page; use next_cursor for more.' +
      PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/call',
    sensitive: true,
    params: {
      started_after: {
        type: 'time',
        in: 'query',
        description: 'Only calls that started after this time (ISO 8601, e.g. 2026-11-01T00:00:00+11:00, or epoch milliseconds).',
      },
      started_before: {
        type: 'time',
        in: 'query',
        description: 'Only calls that started before this time (ISO 8601 or epoch milliseconds).',
      },
      target_id: { type: 'id', in: 'query', description: 'Only calls for this target ID. Needs target_type.' },
      target_type: { type: 'string', in: 'query', enum: TARGET_TYPES, description: 'Type of target_id.' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    validate: (a) => {
      if (a.target_id !== undefined && a.target_type === undefined) {
        throw new InputError('target_type is required when target_id is set');
      }
    },
    shape: shapePage(trimCall),
  },
  {
    name: 'dialpad_get_call',
    description:
      'Get one call in detail: timings, routing, recording details, CSAT score and AI transcription text if any. Dialpad allows 10 of these per minute.' +
      PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/call/{id}',
    sensitive: true,
    params: { id: idParam('Call') },
  },
  {
    name: 'dialpad_get_call_transcript',
    description:
      'Get the Dialpad AI transcript of a call: each line with time, speaker name, type (transcript or moment) and text. Returns up to max_lines lines (default 400).' +
      PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/transcripts/{call_id}',
    sensitive: true,
    params: {
      call_id: idParam('Call'),
      max_lines: { type: 'int', in: 'local', min: 1, max: 2000, description: 'Most lines to return (default 400).' },
    },
    shape: (data, args) => {
      const d = (data ?? {}) as { call_id?: unknown; lines?: unknown[] };
      const lines = Array.isArray(d.lines) ? d.lines : [];
      const max = typeof args.max_lines === 'number' ? args.max_lines : 400;
      return {
        call_id: d.call_id,
        line_count: lines.length,
        lines: lines.slice(0, max).map((l) => pick(l, ['time', 'name', 'type', 'content'])),
        ...(lines.length > max ? { note: `Showing the first ${max} of ${lines.length} lines.` } : {}),
      };
    },
  },

  // ---------------------------------------------------------------- contacts
  {
    name: 'dialpad_list_contacts',
    description:
      'List company-shared Dialpad contacts (and local contacts with include_local), with name, company, phones and emails. Filter by name. Returns one page; use next_cursor for more.' +
      PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/contacts',
    sensitive: true,
    params: {
      name: { type: 'string', in: 'query', description: 'Text to match in the contact name.' },
      include_local: { type: 'boolean', in: 'query', description: "Also include users' local (personal) contacts." },
      owner_id: { type: 'id', in: 'query', description: "Only this user's local contacts." },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    shape: shapePage((c) => pick(c, CONTACT_FIELDS)),
  },
  {
    name: 'dialpad_get_contact',
    description: 'Get one shared or local contact by ID.' + PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/contacts/{id}',
    sensitive: true,
    params: {
      id: { type: 'string', in: 'path', required: true, maxLength: 200, description: 'Contact ID.' },
    },
  },

  // ---------------------------------------------------------------- numbers
  {
    name: 'dialpad_list_numbers',
    description:
      'List phone numbers in the company with type, status, and what each is assigned to (user, office, department, call center). Needs a company admin API key.',
    kind: 'read',
    method: 'GET',
    path: '/numbers',
    params: {
      status: { type: 'string', in: 'query', description: 'Number status filter, e.g. available or assigned.' },
      area_code: { type: 'string', in: 'query', description: 'Area code, digits only.' },
      cursor: CURSOR_PARAM,
      full: FULL_PARAM,
    },
    validate: (a) => {
      if (a.area_code !== undefined && !/^\d{1,6}$/.test(String(a.area_code).trim())) {
        throw new InputError('area_code must be digits only');
      }
    },
    shape: shapePage((n) => pick(n, NUMBER_FIELDS)),
  },
  {
    name: 'dialpad_get_number',
    description: 'Get one phone number: type, status and assignment. Needs a company admin API key.',
    kind: 'read',
    method: 'GET',
    path: '/numbers/{number}',
    params: { number: { type: 'e164', in: 'path', required: true, description: 'Phone number in E.164 format.' } },
  },

  // ---------------------------------------------------------------- stats
  {
    name: 'dialpad_create_stats_export',
    description:
      'Start a Dialpad analytics export (calls, texts, voicemails, recordings, on-duty, CSAT, dispositions) as raw records or summary stats, then poll dialpad_get_stats_export with the returned request_id for the download link. Starts a report job only; changes no Dialpad data. Dialpad allows about 200 per hour.' +
      PII_NOTE,
    kind: 'export',
    method: 'POST',
    path: '/stats',
    sensitive: true,
    params: {
      export_type: { type: 'string', in: 'body', required: true, enum: ['records', 'stats'], description: 'records = one row per item; stats = summary.' },
      stat_type: {
        type: 'string',
        in: 'body',
        required: true,
        enum: ['calls', 'csat', 'dispositions', 'onduty', 'recordings', 'screenshare', 'texts', 'voicemails'],
        description: 'What to export. csat and dispositions need target_id and target_type, and records only.',
      },
      days_ago_start: { type: 'int', in: 'body', min: 0, max: 730, description: 'Start of the range, in days ago (default 1).' },
      days_ago_end: { type: 'int', in: 'body', min: 0, max: 730, description: 'End of the range, in days ago (default 30).' },
      is_today: { type: 'boolean', in: 'body', description: 'Export today only.' },
      office_id: { type: 'id', in: 'body', description: 'Limit to one office (ignored when a target is set).' },
      target_id: { type: 'id', in: 'body', description: 'Limit to one target. Needs target_type.' },
      target_type: { type: 'string', in: 'body', enum: TARGET_TYPES, description: 'Type of target_id.' },
      group_by: { type: 'string', in: 'body', enum: ['date', 'group', 'user'], description: 'Grouping for stats exports.' },
      timezone: { type: 'string', in: 'body', maxLength: 64, description: 'Time zone name, e.g. Australia/Sydney (default UTC).' },
    },
    validate: (a) => {
      if (a.target_id !== undefined && a.target_type === undefined) {
        throw new InputError('target_type is required when target_id is set');
      }
      if ((a.stat_type === 'csat' || a.stat_type === 'dispositions') && (a.target_id === undefined || a.export_type !== 'records')) {
        throw new InputError('csat and dispositions exports need target_id, target_type and export_type records');
      }
    },
  },
  {
    name: 'dialpad_get_stats_export',
    description:
      'Check a stats export started with dialpad_create_stats_export: status (processing, complete, failed) and, when complete, a download URL for the CSV.' +
      PII_NOTE,
    kind: 'read',
    method: 'GET',
    path: '/stats/{id}',
    sensitive: true,
    params: {
      id: {
        type: 'string',
        in: 'path',
        required: true,
        maxLength: 100,
        description: 'request_id returned by dialpad_create_stats_export.',
      },
    },
  },

  // ---------------------------------------------------------------- event subscriptions
  {
    name: 'dialpad_list_call_subscriptions',
    description:
      'List call event subscriptions (which call states are sent to which webhook, and whether each is enabled). Used by the N8N call-to-ticket workflow.',
    kind: 'read',
    method: 'GET',
    path: '/subscriptions/call',
    params: {
      target_id: { type: 'id', in: 'query', description: 'Only subscriptions for this target. Needs target_type.' },
      target_type: { type: 'string', in: 'query', enum: TARGET_TYPES, description: 'Type of target_id.' },
      cursor: CURSOR_PARAM,
    },
    shape: shapePage(trimSubscription),
  },
  {
    name: 'dialpad_get_call_subscription',
    description: 'Get one call event subscription by ID.',
    kind: 'read',
    method: 'GET',
    path: '/subscriptions/call/{id}',
    params: { id: idParam('Subscription') },
    shape: (d) => trimSubscription((d ?? {}) as Record<string, unknown>),
  },
  {
    name: 'dialpad_list_webhooks',
    description:
      'List webhook endpoints registered with Dialpad (ID and URL). The signing secret is never returned. Endpoint URLs are internal - admin-gated.',
    kind: 'read',
    method: 'GET',
    path: '/webhooks',
    sensitive: true,
    params: { cursor: CURSOR_PARAM },
    shape: shapePage((w) => stripWebhookSecret(pick(w, ['id', 'hook_url', 'signature']))),
  },
];
