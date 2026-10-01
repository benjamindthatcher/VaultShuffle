# Database architecture

Production uses the V2 PostgreSQL database in Virginia, project `vbjtbwelnhbbdfrqczyf`. V1 has been deleted. The applied schema lives in `database/v2/supabase/migrations`; use additive migrations for future changes.

## Shared catalogue and personal data

`catalog.games` stores stable internal game keys and Steam AppIDs. Shared metadata, classifications, tags, HLTB duration estimates, human review and region-specific Store data stay in the catalogue rather than being copied into every library.

`app.accounts` retains public account UUIDs alongside compact internal keys. `app.library_games` records personal ownership; Family access is separate. `app.game_activity` records the player's own observed activity, and `app.game_state` stores sparse authored decisions. Losing access does not erase completion, notes or other personal history. Lender playtime is never treated as borrower playtime.

Collections, pins, Vault state, draw history, preferences and Wishlist entries have owner-scoped relations. Wishlist remains independent of Library ownership. SteamID64 values cross JavaScript/JSON boundaries as strings; Steam AppIDs are not narrowed to signed 32-bit integers.

Blacklist is an undated boolean with manual reactivation. There is no timed Sleep or automatic restoration. Vault snoozes remain a separate timed feature. Durations use validated HLTB evidence and human overrides; missing values remain unknown, with no IGDB fallback.

## Access and connections

Next.js server repositories use parameterized SQL, verified TLS and transaction-local tenant context. Ordinary requests use the non-owner `vault_app_runtime` login/group `vault_app`; workers use a separate restricted login with group `vault_worker`. Neither role bypasses RLS or owns application objects. Forced RLS and compound foreign keys enforce tenant and parent ownership.

The server resolves the existing hashed session cookie to a principal; request bodies cannot choose an account. Missing or invalid tenant context fails closed. Database unavailability is a service failure, not a request to log out or use V1.

Production uses the transaction pooler on port 6543 with prepared statements disabled, application pool size 2 and worker pool size 1. Private schemas are not browser/Data API schemas. Credentials and CA configuration remain server-side.

## Workers and preservation

`ops` holds bounded jobs, publication generations, leases, quota/cooldown state and shared enrichment work. Complete owned-library publication is atomic and supports up to 20,000 games within the existing byte bound. Invalid or partial imports preserve the previous complete library. Five existing Vercel schedules perform bounded Steam/Store/SteamSpy and recommendation work; there is no target database cron job or hosted duration worker.

`reco` contains recommendation state. The `migration` schema retains required identity mappings, preservation evidence, cutover validation and retention controls. Completed setup code has been removed; this does not authorize deleting preserved production rows or their security boundaries.

See [operating and recovery notes](v2-cutover-runbook.md), [HLTB workflow](../supabase/README.md), [worker policy](nightly-workers.md), and [the final acceptance receipt](../database/v2/final-cutover-acceptance-20261001.json).
