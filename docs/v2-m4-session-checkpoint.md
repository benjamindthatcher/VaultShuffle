# M4 session/database foundation checkpoint

## Scope and status

This checkpoint records the bounded M4 runtime foundation only. It does not
claim M4 is complete: the authenticated bootstrap and the Library, detail,
dashboard, and collection repository/API slices remain future integration work.
No legacy route, provider, cookie attachment, or authentication-flow behavior
was changed in this batch.

The five earlier immutable v2 migrations were inspected. The runtime implementation
uses the deployed M1 `app.resolve_session(bytea, text)` contract exactly:
`session_id`, internal `account_id`, public UUID, account/session kinds,
verified flag, and expiry. It relies on the function's SECURITY DEFINER
boundary for digest matching, database-clock expiry, revocation, active-account
linkage, and the verified Steam-profile invariant. M2 requires the Supabase
PGMQ extension, so the disposable session fixture applies M1, which is the
migration that defines this session contract; it does not alter an applied
migration or emulate the resolver with application SQL.

## Delivered files

- `lib/v2/db/config.ts` parses an explicitly injected connection configuration.
  It does not scan the environment or files for runtime credentials. Pool size
  is bounded to 1–5 (default 4), an optional Supabase CA PEM is injected rather
  than loaded from a path, and local Unix sockets are an explicit fixture option.
- `lib/v2/db/client.ts` creates the request client with `postgres.js`,
  `prepare: false`, a bounded pool, and TLS verification (`rejectUnauthorized:
  true`) for every TCP connection. An injected CA PEM augments the system trust
  store for Supabase chains that require the official Root2021 CA. It provides a
  transaction helper that sets
  `app.account_id` with transaction-local `set_config`; the setting cannot
  survive commit or rollback on a reused pooled connection.
- `database/v2/supabase/migrations/20260913191021_m4_manual_session_touch.sql`
  is the approved additive M4 migration. Its SHA-256 is
  `7b993f3e0f7978ea48975cee7c9787de17097f4dcb422a2d2bd07258cd8677bd`.
  It creates the narrow `SECURITY DEFINER` manual-session touch function with
  `pg_catalog` search path, verifies that its owner matches the M1 resolver,
  explicitly revokes every existing app/runtime grant, then grants execute to
  `vault_app` alone. It is applied only in the disposable local fixture and is
  **unapplied to the target**.
- `lib/v2/repositories/session.ts` is the server-only repository boundary.
  `session-core.ts` hashes the full cookie value with HMAC-SHA256, including
  `manual.`, selects the expected session kind from that prefix, and calls only
  `app.resolve_session` to establish a principal. It returns no raw cookie,
  digest, secret, DSN, or database-internal session state.
- Manual sessions await a best-effort, narrow database touch of only the
  resolved session when its database `last_seen_at` is at least one hour old.
  The repository uses the returned database expiry so a serverless response
  cannot lose a fire-and-forget renewal. Verified sessions are never renewed.
  A resolver/database failure becomes `DatabaseUnavailableError`
  (`code: database_unavailable`, `retryable: true`); a zero-row resolver result
  is the only anonymous result.
- `lib/v2/repositories/session.integration.test.ts` creates its own PG17 data
  directory, Unix socket, and port. It covers HMAC prefix compatibility,
  expiry/revocation/wrong-kind rejection, non-owner access, the runtime role's
  lack of direct session-table access, manual versus fixed renewal, and pooled
  transaction context cleanup.

`postgres` 3.4.9 was added to `package.json` and `package-lock.json` because
the repository did not previously have the planned PostgreSQL runtime client.

## Validation

The following completed successfully:

```sh
npm run typecheck
npm run lint -- --quiet
node --experimental-strip-types --test lib/v2/repositories/session.integration.test.ts
```

The focused suite passed 3/3. It applies M1 and the new M4 touch migration only
to its own PG17 data directory, short Unix socket, and port. It covers injected
bounded configuration/TLS CA, HMAC prefix compatibility, expiry, revocation,
wrong session kind, wrong digest/session ID, inactive account, raw session-table
denial for the runtime role, manual 365-day renewal and hourly no-op behavior,
fixed verified expiry, transaction commit/rollback context cleanup, and
database-failure versus anonymous behavior.

`supabase migration list --local` was also attempted. It correctly stayed
local, but this workspace has no Supabase Docker database listening on
`127.0.0.1:54322`, so that CLI inventory could not run. The direct disposable
PG17 migration replay above is the applicable local validation for this batch.

## Session-touch boundary

M1 intentionally grants `vault_app` only execute on `app.resolve_session`; it
has no direct `app.sessions` write grant. The new definer function is therefore
the only manual renewal path. It receives a digest plus the already-resolved
session ID, validates manual kind, active account, live/unrevoked session and
the database-clock hourly gate, and returns only `expires_at`. A second call
inside the hourly window returns the existing expiry without writing. The
repository awaits it and uses that returned expiry; failures are still
best-effort and retain the successful resolver result.

## Security boundary and next integration

The runtime credential is expected to have `vault_app` membership only; there
is no admin/service-role fallback in this code. Session input is a cookie value
and a server-held secret supplied by the composition root, never an account ID
from a request body. Tenant repositories should accept only the principal
returned by `SessionRepository`, call `database.withPrincipal`, and retain an
explicit `account_id` predicate in each tenant query.

The next M4 integration slice should compose an injected `DatabaseConfig` and
server-held `SESSION_SECRET`, read `vault_session` with the existing host-only
cookie behavior, map `DatabaseUnavailableError` to the established retriable
503 path, and preserve the existing manual cookie refresh attachment. It can
then migrate one small authenticated bootstrap/read repository at a time; it
must not add a full-library bootstrap or broaden the resolver/function grants.
