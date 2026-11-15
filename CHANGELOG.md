# Changelog

## Unreleased

- Writes are never replayed. Dialpad does not document that a rate-limited write was rejected before it ran, and a 503 does not prove a write had no effect, so only GET/HEAD/OPTIONS are retried on a 429 or a 503 with `Retry-After`. A POST, PATCH or DELETE (including `dialpad_create_stats_export`) fails at once. A 429 without `Retry-After` now says `Try again in 60 s.` instead of "Wait a minute", and a 503 with `Retry-After` keeps the wait in the error.
- A rate-limited request (HTTP 429, or a 503 with `Retry-After`) is retried up to twice. It honours `Retry-After` if Dialpad sends one, or waits 1 s then 2 s with jitter. Each wait is capped at 10 s and the total at 20 s, and every attempt gets its own timeout. A longer wait is reported at once (`Try again in N s.` when Dialpad says how long).

## 0.1.0 (unreleased)

First version.

- 22 read tools for the Dialpad API v2: company, users, offices, departments, call centers and live queue status, call history and call details, AI transcripts, contacts, phone numbers, stats exports, call event subscriptions and webhooks.
- 5 write tools matching Cititec's N8N workflows: create, update and delete a contact; send a message to a channel or to numbers; turn a call event subscription on or off.
- List results are trimmed to main fields with a cursor for the next page. Responses are capped at 60,000 characters. Large Dialpad IDs are kept exact.
- Call logs, transcripts, contacts, stats exports and webhooks are marked sensitive, for admin-gating.
- stdio and HTTP transports. HTTP fails closed without a gateway S2S secret and takes the key from `X-Dialpad-Api-Key` in gateway mode.
