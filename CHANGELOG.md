# Changelog

## 0.1.0 (unreleased)

First version.

- 22 read tools for the Dialpad API v2: company, users, offices, departments, call centers and live queue status, call history and call details, AI transcripts, contacts, phone numbers, stats exports, call event subscriptions and webhooks.
- 5 write tools matching Cititec's N8N workflows: create, update and delete a contact; send a message to a channel or to numbers; turn a call event subscription on or off.
- List results are trimmed to main fields with a cursor for the next page. Responses are capped at 60,000 characters. Large Dialpad IDs are kept exact.
- Call logs, transcripts, contacts, stats exports and webhooks are marked sensitive, for admin-gating.
- stdio and HTTP transports. HTTP fails closed without a gateway S2S secret and takes the key from `X-Dialpad-Api-Key` in gateway mode.
