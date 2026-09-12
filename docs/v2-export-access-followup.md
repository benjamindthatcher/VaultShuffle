# Export access: bounded coordinator follow-up

9 September 2026. Complements `v2-export-access.md`; no credential was obtained,
no source CLI command was run and no authentication role was changed.

The installed `/opt/homebrew/bin/supabase --version` reports **2.115.0**. Its
Cellar package contains both `supabase` and `supabase-go`; the outer command is
Bun-based. The observed help difference therefore does not establish that the
installed version changed. `db query --help` describes `--linked` as Management
API access. `db dump --help` describes remote pg_dump, with direct URL or linked
project, password, schema and data-only/COPY options. Its `--dry-run` prints a
script and is not appropriate for exposing a credential-bearing invocation.
No dump or dry-run was invoked. `stream-json` is a CLI output format, not proof
of a database snapshot streaming protocol.

An alternative to a production-password reset exists in the official API:
[Create login role](https://supabase.com/docs/reference/api/v1-create-login-role)
accepts `POST /v1/projects/{ref}/cli/login-role` with required boolean
`read_only`, returning a role, temporary password and TTL. The endpoint requires
database-write scope because it changes authentication state. This is a candidate
for a tightly bounded read-only export login; it has **not** been called or
verified for this source. It is not a read-only metadata request merely because
the requested role would be read-only.

The [CLI role documentation](https://supabase.com/docs/guides/troubleshooting/permission-denied-when-deleting-the-cli_login_postgres-role-808bae)
confirms managed temporary role creation and expiration. Coordinator metadata
inspection found existing source `cli_login_postgres`, expired on 3 September;
there is no evidence of a still-valid credential for it. Refresh/provisioning
would cross the development source-authentication freeze and must be treated as
a concrete operational exception, not silently run by a helper command. A
production database-password reset is neither necessary nor approved on current
evidence.

Current reachable management SQL has proved schema/aggregate audit access, not
the exporter's continuous authenticated PG connection. No callable bulk dump or
login-role endpoint is exposed in the inspected connector tools. A suitable
existing private DB credential or a deliberately authorized temporary-login flow
is still needed. If an exception becomes necessary, first finish and review the
exporter, its private connection-file workflow, verified TLS and precise source
identity checks; then present the exact limited action and cleanup/expiration.
Do not ask the user to paste a secret in chat. Do not reset a password as a
shortcut, build an unbounded JSON aggregate dump, or claim independent HTTP pages
share one snapshot.

The exporter is using Node TLS rather than the SSL-less local psql for its remote
protocol. A separate TLS-capable psql build is therefore not intrinsically needed
for that exporter; the actual TLS/auth path still needs meaningful tests and
coordinator review. Local Unix-socket integration cannot prove it.
