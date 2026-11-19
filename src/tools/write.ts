import type { ParamSpec, ToolSpec } from './spec.js';
import { InputError } from './shared.js';
import { trimSubscription } from './read.js';

// Write tools: only the changes Cititec's N8N workflows already make
// (contact sync from Autotask, notification texts, and pausing the call
// event subscription). On the MCP host these belong in `write_tools`, so a
// call becomes a proposal with its exact arguments and runs only after an
// administrator approves it. Each one is a single request with no
// follow-up calls, so what is approved is exactly what is sent.

/** Call states a call event subscription can send (Dialpad OpenAPI spec, dialpad/dialpad-python-sdk). */
const CALL_STATES = [
  'admin', 'admin_recording', 'ai_playbook', 'all', 'barge', 'blocked', 'call_transcription', 'calling',
  'connected', 'csat', 'dispositions', 'eavesdrop', 'hangup', 'hold', 'merged', 'missed', 'monitor',
  'parked', 'pcsat', 'postcall', 'preanswer', 'queued', 'recap_action_items', 'recap_outcome',
  'recap_purposes', 'recap_summary', 'recording', 'ringing', 'takeover', 'transcription', 'voicemail',
  'voicemail_uploaded',
] as const;

const CONTACT_FIELDS: Record<string, ParamSpec> = {
  first_name: { type: 'string', in: 'body', maxLength: 100, description: 'First name.' },
  last_name: {
    type: 'string',
    in: 'body',
    maxLength: 150,
    description: "Last name. The N8N sync appends the Autotask company short name, e.g. 'Smith ACME'.",
  },
  company_name: { type: 'string', in: 'body', maxLength: 200, description: 'Company name.' },
  job_title: { type: 'string', in: 'body', maxLength: 200, description: 'Job title.' },
  phones: {
    type: 'e164_list',
    in: 'body',
    maxItems: 10,
    description: 'Phone numbers in E.164 format; the first is the primary. On update, replaces the whole list.',
  },
  emails: {
    type: 'string_list',
    in: 'body',
    maxItems: 10,
    maxLength: 254,
    description: 'Email addresses; the first is the primary. On update, replaces the whole list.',
  },
  extension: { type: 'string', in: 'body', maxLength: 20, description: 'Extension.' },
  urls: { type: 'string_list', in: 'body', maxItems: 10, maxLength: 500, description: 'Web addresses. On update, replaces the whole list.' },
};

function checkEmails(args: Record<string, unknown>): void {
  if (Array.isArray(args.emails)) {
    for (const e of args.emails) {
      if (typeof e !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())) {
        throw new InputError(`Not an email address: ${String(e)}`);
      }
    }
  }
}

export const WRITE_SPECS: ToolSpec[] = [
  {
    name: 'dialpad_create_contact',
    description:
      'Create a company-shared Dialpad contact (or a local contact for one user with owner_id). Same fields the N8N Autotask contact sync sends. Proposal: an administrator must approve it before it runs.',
    kind: 'write',
    method: 'POST',
    path: '/contacts',
    params: {
      ...CONTACT_FIELDS,
      first_name: { ...CONTACT_FIELDS.first_name, required: true },
      last_name: { ...CONTACT_FIELDS.last_name, required: true },
      owner_id: { type: 'id', in: 'body', description: 'Make it a local contact of this user instead of a shared contact.' },
    },
    validate: checkEmails,
  },
  {
    name: 'dialpad_update_contact',
    description:
      'Update a Dialpad contact. Only the fields given are changed; phones, emails and urls replace the whole list. Proposal: an administrator must approve it before it runs.',
    kind: 'write',
    method: 'PATCH',
    path: '/contacts/{id}',
    params: {
      id: { type: 'string', in: 'path', required: true, maxLength: 200, description: 'Contact ID.' },
      ...CONTACT_FIELDS,
    },
    validate: (a) => {
      if (!Object.keys(CONTACT_FIELDS).some((k) => a[k] !== undefined)) {
        throw new InputError('Give at least one field to change');
      }
      checkEmails(a);
    },
  },
  {
    name: 'dialpad_delete_contact',
    description:
      'Delete a Dialpad contact (the N8N sync does this when the Autotask contact is deactivated). Cannot be undone. Proposal: an administrator must approve it before it runs.',
    kind: 'write',
    method: 'DELETE',
    path: '/contacts/{id}',
    destructive: true,
    params: {
      id: { type: 'string', in: 'path', required: true, maxLength: 200, description: 'Contact ID.' },
    },
    // Dialpad may answer with an empty body; always say what was deleted.
    shape: (data, args) => {
      const deleted = data && typeof data === 'object' && Object.keys(data).length > 0 ? { contact: data } : {};
      return { deleted: true, id: String(args.id).trim(), ...deleted };
    },
  },
  {
    name: 'dialpad_send_sms',
    description:
      'Send a text message, either to a Dialpad channel (channel_hashtag, as the N8N alerts do) or to up to 10 phone numbers. The sender is from_number, user_id or a sender group. Proposal: an administrator must approve it before it is sent.',
    kind: 'write',
    method: 'POST',
    path: '/sms',
    params: {
      text: { type: 'string', in: 'body', required: true, maxLength: 1600, description: 'Message text.' },
      channel_hashtag: { type: 'string', in: 'body', maxLength: 100, description: 'Dialpad channel to post to, e.g. n8n.' },
      to_numbers: { type: 'e164_list', in: 'body', maxItems: 10, description: 'Recipient numbers in E.164 format (up to 10).' },
      from_number: {
        type: 'e164',
        in: 'body',
        description: 'Sending number (must belong to a user or group in Dialpad). Overrides user_id and sender group.',
      },
      user_id: { type: 'id', in: 'body', description: 'Send as this user.' },
      sender_group_id: { type: 'id', in: 'body', description: 'Send as this office, department or call center. Needs sender_group_type.' },
      sender_group_type: { type: 'string', in: 'body', enum: ['callcenter', 'department', 'office'], description: 'Type of sender_group_id.' },
      infer_country_code: {
        type: 'boolean',
        in: 'body',
        description: "Accept numbers without a country code, using the sender's country.",
      },
    },
    validate: (a) => {
      const hasChannel = a.channel_hashtag !== undefined;
      const hasNumbers = a.to_numbers !== undefined;
      if (hasChannel === hasNumbers) throw new InputError('Give either channel_hashtag or to_numbers (not both)');
      if (a.from_number === undefined && a.user_id === undefined && a.sender_group_id === undefined) {
        throw new InputError('Give a sender: from_number, user_id or sender_group_id');
      }
      if ((a.sender_group_id === undefined) !== (a.sender_group_type === undefined)) {
        throw new InputError('sender_group_id and sender_group_type go together');
      }
    },
  },
  {
    name: 'dialpad_update_call_subscription',
    description:
      'Turn a call event subscription on or off, or change which call states it sends (the N8N call-to-ticket workflow pauses and resumes its subscription this way). Does not change where events are sent. Proposal: an administrator must approve it before it runs.',
    kind: 'write',
    method: 'PATCH',
    path: '/subscriptions/call/{id}',
    params: {
      id: { type: 'id', in: 'path', required: true, description: 'Subscription ID (from dialpad_list_call_subscriptions).' },
      enabled: { type: 'boolean', in: 'body', description: 'true to send events, false to pause.' },
      call_states: {
        type: 'string_list',
        in: 'body',
        enum: CALL_STATES,
        maxItems: CALL_STATES.length,
        description: 'Call states to send, e.g. ["connected"] or ["hangup","recording"]. Replaces the current list.',
      },
    },
    validate: (a) => {
      if (a.enabled === undefined && a.call_states === undefined) {
        throw new InputError('Give enabled, call_states or both');
      }
    },
    // The response includes the webhook, whose signature holds the HMAC signing secret.
    shape: (d) => trimSubscription((d ?? {}) as Record<string, unknown>),
  },
];
