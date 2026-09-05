# user_game_state access safeguard

Applied to VaultShuffle (`pfvblcopcmairdfeqdep`) on 5 September 2026 as remote
migration `20260905115357_harden_user_game_state_rls`.

## Findings and change

- `user_game_state` is the backfilled staging table from the database-capacity work.
  The current app uses `user_games`; no database views, function bodies or triggers
  referencing the staging table were found during this check.
- Before the change, RLS was disabled, but `anon` and `authenticated` already lacked
  SELECT, INSERT, UPDATE and DELETE privileges, including column-level grants.
  The earlier warning did **not** establish that client data access was possible.
- Enabled RLS and explicitly revoked client/PUBLIC table privileges. Existing owner
  and service-role permissions were preserved. No data or application code changed.
- No client policies are intentional. This table is not a browser-facing API.
  Supabase's `rls_enabled_no_policy` informational notice is expected here.

## Verification

`scripts/verify-user-game-state-access.sql` is a standalone SQL script to run as
the database owner. It checks RLS, rejects client policies, tests all four CRUD
operations as both client roles using zero-row probes, and checks owner access
and the current app's service-role read/update access to `user_games`.
It rolls back its transaction and does not display user records.

All checks passed after application. The staging table retained 24,428 rows and
its previous ACL. The security advisor returned no ERROR findings; its separate
existing warnings about `enforce_family_member_limit()` were outside this change.

## Future database cutover

The staging-table creation/backfill was recorded remotely as
`backfill_user_game_state`; that prerequisite is not currently in local migrations.
Restore that migration history before attempting a clean local database rebuild.
Do not add new grants simply to silence an access error: the future cutover must
review its server access and session authorisation explicitly. Do not add an
`auth.uid()` policy unless the authentication model is deliberately changed.

Reference: [Supabase RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security).
