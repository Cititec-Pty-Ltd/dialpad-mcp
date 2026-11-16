import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getCredentials, request } from '../client.js';
import type { DialpadPage, HttpMethod } from '../types.js';
import type { CallToolResult } from './types.js';
import { InputError, errorResult, requireCredentials, textResult, toE164, toEpochMs, toId } from './shared.js';

/**
 * Every tool is a row in a table: a fixed method and path, and typed
 * parameters that go into the path, the query string or the JSON body.
 * No tool takes a free-form path, and IDs are validated and URL-encoded
 * before they reach the path.
 */

export type ParamType =
  | 'string'
  | 'boolean'
  | 'id' // numeric Dialpad ID
  | 'user_id' // numeric ID or 'me'
  | 'e164' // phone number
  | 'e164_list'
  | 'string_list'
  | 'time' // ISO 8601 or epoch ms -> epoch ms
  | 'int';

export interface ParamSpec {
  type: ParamType;
  /** local: used by this server only (output options), never sent to Dialpad. */
  in: 'path' | 'query' | 'body' | 'local';
  description: string;
  required?: boolean;
  enum?: readonly string[];
  /** Name sent to Dialpad, when it differs from the tool parameter name. */
  apiName?: string;
  min?: number;
  max?: number;
  maxItems?: number;
  maxLength?: number;
}

/**
 * - read: GET only.
 * - export: POST that starts a report job and changes no Dialpad data (stats export).
 * - write: changes Dialpad data. On the MCP host these go in write_tools, so each call is a proposal an administrator approves.
 */
export type ToolKind = 'read' | 'export' | 'write';

export interface ToolSpec {
  name: string;
  description: string;
  kind: ToolKind;
  method: HttpMethod;
  /** Path under /api/v2 with {param} placeholders filled from `in: 'path'` params. */
  path: string;
  params: Record<string, ParamSpec>;
  /** Returns PII (call logs, transcripts, contacts) or secrets-adjacent data: admin-gate on the host. */
  sensitive?: boolean;
  destructive?: boolean;
  /** Extra checks across parameters (e.g. "one of A or B"). */
  validate?: (args: Record<string, unknown>) => void;
  /** Trims the Dialpad response. Receives the parsed body and the tool arguments. */
  shape?: (data: unknown, args: Record<string, unknown>) => unknown;
  /**
   * For read tools that need several requests (e.g. a search that pages through calls).
   * Gets the validated request built from `params` plus a GET-only fetcher; the
   * method and path above are the first request it makes. Only allowed with kind 'read'.
   */
  run?: (
    first: { path: string; query: Record<string, unknown> },
    args: Record<string, unknown>,
    get: <T>(path: string, query?: Record<string, unknown>) => Promise<T>
  ) => Promise<unknown>;
}

const LIST_TYPES: ParamType[] = ['e164_list', 'string_list'];

function jsonSchemaFor(p: ParamSpec): Record<string, unknown> {
  const description = p.description;
  switch (p.type) {
    case 'boolean':
      return { type: 'boolean', description };
    case 'int':
      return {
        type: 'integer',
        description,
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
      };
    case 'time':
      return { type: ['string', 'integer'], description };
    case 'id':
    case 'user_id':
      return { type: ['string', 'integer'], description };
    case 'e164_list':
    case 'string_list':
      return {
        type: 'array',
        items: { type: 'string', ...(p.enum ? { enum: [...p.enum] } : {}) },
        description,
        ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
      };
    default:
      return {
        type: 'string',
        description,
        ...(p.enum ? { enum: [...p.enum] } : {}),
        ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
      };
  }
}

export function buildTool(spec: ToolSpec): Tool {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(spec.params)) {
    properties[key] = jsonSchemaFor(p);
    if (p.required) required.push(key);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: {
      readOnlyHint: spec.kind !== 'write',
      destructiveHint: spec.destructive === true,
      idempotentHint: spec.method === 'GET' || spec.method === 'DELETE',
      openWorldHint: true,
    },
  };
}

function convert(key: string, p: ParamSpec, value: unknown): unknown {
  switch (p.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new InputError(`${key} must be true or false`);
      return value;
    case 'int': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new InputError(`${key} must be a whole number`);
      if (p.min !== undefined && n < p.min) throw new InputError(`${key} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new InputError(`${key} must be at most ${p.max}`);
      return n;
    }
    case 'id':
      return toId(value, key);
    case 'user_id':
      return toId(value, key, { allowMe: true });
    case 'e164':
      return toE164(value, key);
    case 'time':
      return toEpochMs(value, key);
    case 'e164_list':
    case 'string_list': {
      if (!Array.isArray(value) || value.length === 0) throw new InputError(`${key} must be a non-empty list`);
      if (p.maxItems !== undefined && value.length > p.maxItems) {
        throw new InputError(`${key} can have at most ${p.maxItems} entries`);
      }
      return value.map((v, i) => {
        if (p.type === 'e164_list') return toE164(v, `${key}[${i}]`);
        if (typeof v !== 'string' || v.trim() === '') throw new InputError(`${key}[${i}] must be text`);
        const s = v.trim();
        if (p.enum && !p.enum.includes(s)) throw new InputError(`${key}[${i}] must be one of: ${p.enum.join(', ')}`);
        if (p.maxLength !== undefined && s.length > p.maxLength) {
          throw new InputError(`${key}[${i}] is longer than ${p.maxLength} characters`);
        }
        return s;
      });
    }
    default: {
      if (typeof value !== 'string') throw new InputError(`${key} must be text`);
      const s = p.in === 'body' ? value : value.trim();
      if (s.trim() === '') throw new InputError(`${key} must not be empty`);
      if (p.enum && !p.enum.includes(s)) throw new InputError(`${key} must be one of: ${p.enum.join(', ')}`);
      if (p.maxLength !== undefined && s.length > p.maxLength) {
        throw new InputError(`${key} is longer than ${p.maxLength} characters`);
      }
      return s;
    }
  }
}

/** Validates the arguments and returns the request the tool would send. Exported for tests. */
export function buildRequest(
  spec: ToolSpec,
  args: Record<string, unknown>
): { path: string; query: Record<string, unknown>; body?: Record<string, unknown> } {
  for (const key of Object.keys(args)) {
    if (!(key in spec.params)) throw new InputError(`Unknown parameter: ${key}`);
  }
  let path = spec.path;
  const query: Record<string, unknown> = {};
  const body: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    const raw = args[key];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (p.required) throw new InputError(`${key} is required`);
      continue;
    }
    const value = convert(key, p, raw);
    if (p.in === 'local') continue;
    const apiName = p.apiName ?? key;
    if (p.in === 'path') {
      path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
    } else if (p.in === 'query') {
      if (LIST_TYPES.includes(p.type)) throw new Error(`List parameter ${key} cannot be sent in the query`);
      query[apiName] = value;
    } else {
      body[apiName] = value;
    }
  }
  if (/\{[a-z_]+\}/i.test(path)) throw new Error(`Unfilled path parameter in ${path}`);
  spec.validate?.(args);
  return { path, query, ...(spec.method === 'POST' || spec.method === 'PATCH' ? { body } : {}) };
}

export async function runSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
  const creds = getCredentials();
  const missing = requireCredentials(creds);
  if (missing) return missing;
  try {
    const { path, query, body } = buildRequest(spec, args);
    if (spec.run) {
      if (spec.kind !== 'read' || spec.method !== 'GET') throw new Error(`${spec.name}: run is only allowed for GET read tools`);
      const get = <T>(p: string, q?: Record<string, unknown>) => request<T>(creds!, 'GET', p, { query: q });
      return textResult(await spec.run({ path, query }, args, get));
    }
    const data = await request<unknown>(creds!, spec.method, path, { query, body });
    return textResult(spec.shape ? spec.shape(data, args) : data);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

/** Shapes a list page: trims each item and keeps the cursor for the next page. */
export function shapePage(trim: (item: Record<string, unknown>) => unknown) {
  return (data: unknown, args: Record<string, unknown>): unknown => {
    const page = (data ?? {}) as DialpadPage;
    const items = Array.isArray(page.items) ? page.items : [];
    return {
      count: items.length,
      items: args.full === true ? items : items.map(trim),
      next_cursor: page.cursor ?? null,
      ...(page.cursor ? { note: 'More results: call again with cursor set to next_cursor.' } : {}),
    };
  };
}

/** Shared parameters for list tools. */
export const CURSOR_PARAM: ParamSpec = {
  type: 'string',
  in: 'query',
  description: 'Cursor from next_cursor of the previous page, to get the next page.',
};

/** Not sent to Dialpad: when true, list items are returned in full instead of trimmed to the main fields. */
export const FULL_PARAM: ParamSpec = {
  type: 'boolean',
  in: 'local',
  description: 'Return every field of each item instead of the main fields only. Larger output; use only when needed.',
};
