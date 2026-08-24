## Fixes

**Hosted HTTP transport** — the key now normalizes exactly as it does over
stdio. An unexpanded config placeholder (`${WA_API_KEY}`, what Cursor and Codex
forward when nothing is set) counts as *no key* rather than a bad one, so those
callers land on the keyless surface and the onboarding text instead of "Invalid
API key format". `WA_HTTP_DEFAULT_KEY` and `WA_APPS_CHALLENGE_TOKEN` follow the
same rule.

**Hosted callers are no longer told to do something impossible.**
`AUTH_REQUIRED`, revoked-key and `check_upgrade_status` messages, the sample
audit note and the handshake instructions now name the `Authorization: Bearer` /
`X-API-Key` header on the hosted transport, instead of telling you to edit a
config file on a machine you cannot reach and restart a client that reads
nothing at startup.

**`check_upgrade_status`** settles a malformed key locally instead of spending a
request the API can only refuse, and now says where the key goes.

**Security** — `WA_DEV_TIER` is no longer inherited by hosted tenants, where it
granted a tier to any caller before the key was even checked. Bundle eviction
now drops the entry with the least to lose, so an anonymous caller can no longer
flush a subscriber's audit cache and make them re-spend quota. A box with
`WA_HTTP_DEFAULT_KEY` set no longer answers `Access-Control-Allow-Origin: *`,
which let any web page drive it as that account; `WA_HTTP_ALLOWED_ORIGINS` opts
specific origins back in.

**Boot** — an empty or malformed `WA_HTTP_PORT` no longer crashes startup or
shadows the `PORT` Cloud Run injects; a bad value now names the variable.

No breaking changes. Anyone with a working `wa_` key is unaffected.
