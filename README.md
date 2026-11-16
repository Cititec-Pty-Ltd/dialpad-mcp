# Dialpad MCP server

An MCP server for the [Dialpad API v2](https://developers.dialpad.com/reference). It lets Claude look up Dialpad users, offices, departments, call centers, call history, transcripts, contacts, phone numbers and analytics exports. It can also make the few changes Cititec's automations already make: contact sync, notification messages, and pausing a call event subscription.

It uses the same framework as Cititec's other MCP servers: TypeScript, `@modelcontextprotocol/sdk`, a stdio transport and a fail-closed HTTP transport, vitest tests, tsup and a Docker image.

## Tools

Reads send `GET` to a fixed path. IDs are checked and URL-encoded, and no tool accepts a free-form path. List tools return one page with a `next_cursor`. Each item is trimmed to its main fields (`full: true` returns every field), and every response is capped at 60,000 characters.

**Sensitive** tools return personal information (call logs, transcripts, contacts, exports) or internal URLs. Make them available to administrators only.

| Tool | Dialpad API | Sensitive |
|------|-------------|-----------|
| `dialpad_get_company` | `GET /company` | |
| `dialpad_list_users` | `GET /users` (email, number, name prefix, state, admin) | |
| `dialpad_get_user` | `GET /users/{id}` | |
| `dialpad_list_offices` / `dialpad_get_office` | `GET /offices`, `/offices/{id}` | |
| `dialpad_list_departments` / `dialpad_get_department` | `GET /departments`, `/departments/{id}` | |
| `dialpad_list_callcenters` / `dialpad_get_callcenter` | `GET /callcenters`, `/callcenters/{id}` | |
| `dialpad_get_callcenter_status` | `GET /callcenters/{id}/status` (live queue status) | |
| `dialpad_list_calls` | `GET /call` (start time range, target) | yes |
| `dialpad_get_call` | `GET /call/{id}` (Dialpad allows 10 a minute) | yes |
| `dialpad_get_call_transcript` | `GET /transcripts/{call_id}` | yes |
| `dialpad_get_call_ai_recap` | `GET /call/{id}/ai_recap` (about 12/min) | yes |
| `dialpad_search_calls` | `GET /call` (paged) + `GET /call/{id}/ai_recap`. Dialpad has no call text search, so it matches contact name, phone and external number client-side, and with `search_recaps` the AI recap of up to 10 more connected calls (5 s apart) | yes |
| `dialpad_list_contacts` / `dialpad_get_contact` | `GET /contacts`, `/contacts/{id}` | yes |
| `dialpad_search_contacts` | `GET /contacts/search` (name word-prefix, full phone or email) | yes |
| `dialpad_list_numbers` / `dialpad_get_number` | `GET /numbers`, `/numbers/{number}` (company admin key) | |
| `dialpad_create_stats_export` | `POST /stats`: starts a report job and changes no Dialpad data | yes |
| `dialpad_get_stats_export` | `GET /stats/{id}`: status and download link | yes |
| `dialpad_list_call_subscriptions` / `dialpad_get_call_subscription` | `GET /subscriptions/call`, `/subscriptions/call/{id}` | |
| `dialpad_list_webhooks` | `GET /webhooks`: the signing secret is never returned | yes |

### Write tools

Only the changes Cititec's N8N workflows already make are included. Each one is a single request, so on the MCP host the proposal an administrator approves is exactly what is sent.

| Tool | Dialpad API | Used by (N8N) |
|------|-------------|---------------|
| `dialpad_create_contact` | `POST /contacts` | Autotask contact sync |
| `dialpad_update_contact` | `PATCH /contacts/{id}` | Autotask contact sync |
| `dialpad_delete_contact` | `DELETE /contacts/{id}` (destructive) | Autotask webhook handler |
| `dialpad_send_sms` | `POST /sms` to a channel or up to 10 numbers | workflow alerts to a Dialpad channel; texts from the call-to-ticket workflow |
| `dialpad_update_call_subscription` | `PATCH /subscriptions/call/{id}` (`enabled`, `call_states` only) | call-to-ticket workflow |

Not included: calls, call control, users, offices, number assignment, routing and the rest of Dialpad's admin API.

### Where the endpoint details come from

Paths, methods, parameters, call states and response fields were checked against Dialpad's OpenAPI spec, `dialpad_api_spec.json` in [dialpad/dialpad-python-sdk](https://github.com/dialpad/dialpad-python-sdk) (MIT). A few filters appear only on the newer reference at developers.dialpad.com, not in that spec: `first_name`/`last_name` for users, `name_search` for offices, `name` for contacts and `area_code` for numbers. Dialpad publishes no official MCP server or TypeScript SDK.

## Authentication

Dialpad uses an API key sent as `Authorization: Bearer <key>`. Create it in Dialpad under **Admin Settings > My Company > Authentication > API keys**. The number tools need a company admin key. Dialpad has no read-only keys, so read-only access depends on which tools are exposed, not on the key.

| Transport | Where the key comes from |
|-----------|--------------------------|
| stdio (default) | `DIALPAD_API_KEY` |
| HTTP, `AUTH_MODE=env` | `DIALPAD_API_KEY` |
| HTTP, `AUTH_MODE=gateway` (the image default) | `X-Dialpad-Api-Key` header on every request; no fallback to the environment |

The HTTP transport refuses to start without a real `CONDUIT_S2S_SECRET` and checks the `X-Gateway-S2S` header on every `/mcp` request. `MCP_ALLOW_INSECURE_DEV=1` is for local development only: it skips the check and listens on 127.0.0.1. See `.env.example`.

## Rate limits

Dialpad allows 20 requests per second per company, and 1200 per minute on most endpoints. Some limits are lower: call details 10 a minute, contact create 100 a minute, SMS 100 a minute (800 on Tier 1), stats exports about 200 an hour. A 429 is reported as a rate-limit error, not as a bad key.

## Running on the Cititec MCP host

The host starts the image over stdio with the service's env file. The host adds the `cititec_change_status` tool itself and turns `write_tools` into proposals; this image does neither. Suggested `control.json` lists:

- `read_tools`: every tool in the first table. Admin-gate the sensitive ones by giving them only to users who need call and contact data.
- `write_tools`: the five write tools, with a key in the `-rw.env` file. Leave them out if Claude should only read.

## Development

```bash
npm ci
npm run lint    # type check
npm run build
npm test
```

Local run over stdio: `DIALPAD_API_KEY=... node dist/index.js`.

On Cititec workstations ThreatLocker must allow `esbuild.exe` (used by tsup and vitest) before `build` and `test` run.

## License

Apache-2.0. The HTTP transport, gateway check, logger and build setup come from WYRE Technology's `unifi-mcp`. See `NOTICE`.
