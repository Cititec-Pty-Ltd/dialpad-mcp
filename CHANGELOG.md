# Changelog

## Unreleased

- `dialpad_search_calls` stops itself before the MCP host's 60 s tool-call limit and returns what it found. Listing calls stops at about 40 s (about 20 s when `search_recaps` is set, leaving time for recaps), and recap reads stop before 40 s in total. The result then has `time_limited: true` and a note with how far back the listing got. Before, a wide date range ran past the host limit and returned nothing.
- New read tools for finding calls. Dialpad's API has no text search over calls, transcripts or AI recaps, so:
  - `dialpad_search_calls` lists calls in a date range (default the last 30 days, optionally one target) and matches the text against the contact name, contact phone and external number. With `search_recaps` it also reads the AI recap of up to `max_recap_reads` (default 8, at most 10) more connected calls, 5 s apart (Dialpad allows about 12 per minute; the Cititec MCP host gives each tool call 60 s), and matches the summary, action items and purposes. It reports what it did not check.
  - `dialpad_get_call_ai_recap` returns one call's AI recap (summary, action items, purposes, disposition).
  - `dialpad_search_contacts` searches contacts by name (word-prefix), full phone or email.
  All three are sensitive (call and contact data). Tool specs gain an optional `run` for GET-only multi-request read tools.
- Writes are never replayed. Dialpad does not document that a rate-limited write was rejected before it ran, and a 503 does not prove a write had no effect, so only GET/HEAD/OPTIONS are retried on a 429 or a 503 with `Retry-After`. A POST, PATCH or DELETE (including `dialpad_create_stats_export`) fails at once. A 429 without `Retry-After` now says `Try again in 60 s.` instead of "Wait a minute", and a 503 with `Retry-After` keeps the wait in the error.
- A rate-limited request (HTTP 429, or a 503 with `Retry-After`) is retried once when Dialpad sends a `Retry-After` of at most 10 s, after waiting that long; the retry gets its own timeout. With no `Retry-After`, or a longer one, it is reported at once. The error says `Try again in N s.` and `DialpadRateLimitError.retryAfterSeconds` is the same N (at least 1; 60 s without a `Retry-After`).

## 0.1.0 (unreleased)

First version.

- 22 read tools for the Dialpad API v2: company, users, offices, departments, call centers and live queue status, call history and call details, AI transcripts, contacts, phone numbers, stats exports, call event subscriptions and webhooks.
- 5 write tools matching Cititec's N8N workflows: create, update and delete a contact; send a message to a channel or to numbers; turn a call event subscription on or off.
- List results are trimmed to main fields with a cursor for the next page. Responses are capped at 60,000 characters. Large Dialpad IDs are kept exact.
- Call logs, transcripts, contacts, stats exports and webhooks are marked sensitive, for admin-gating.
- stdio and HTTP transports. HTTP fails closed without a gateway S2S secret and takes the key from `X-Dialpad-Api-Key` in gateway mode.
