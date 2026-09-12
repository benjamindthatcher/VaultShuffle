# M3-A coordinator review delta — 9 September 2026

This is feedback on the completed access report, not a request to interrupt the
exporter or schema agent. Fold corrections into the batch integration. Codex
retains the main execution ledger; Claude may update this file with resolutions.

1. PostgreSQL 17 `pg_dump` defaults to `REPEATABLE READ, READ ONLY`. The optional
   serializable-deferrable mode uses `SERIALIZABLE, READ ONLY, DEFERRABLE`.
   Evidence: local official source
   `/tmp/postgresql-17.6/src/bin/pg_dump/pg_dump.c`, lines 1330–1355.
   Do not describe the default as repeatable-read-deferrable.
2. Keep direct or session pooling as our approved export connection choices.
   Transaction pooling alone does not make a long repeatable-read transaction
   impossible: a backend is retained for the transaction. Narrow the report's
   categorical claim to the supported workflow and any specific client features.
3. A project CA certificate is public connection material. Downloading it does
   not itself require the user to handle a secret. Existing password retrieval
   was unavailable in the inspected dashboard; do not turn that into proof that
   every possible authentication path requires a password reset. Describe reset
   impact precisely, without asserting that every live connection would break.
4. There is a third avenue worth a bounded read-only investigation before asking
   the user for credentials: existing CLI authentication. Supabase's official
   troubleshooting documentation describes temporary CLI login roles:
   https://supabase.com/docs/guides/troubleshooting/permission-denied-when-deleting-the-cli_login_postgres-role-808bae
   A coordinator read-only catalog query found source `cli_login_postgres`
   already exists, LOGIN true, SUPERUSER false, BYPASSRLS false, with expired
   `rolvaliduntil = 2026-09-03 15:19:13.270498+00`. **Do not refresh, provision,
   grant, reset or otherwise mutate it.** This is evidence for investigation,
   not authorization to use a role-provisioning source CLI command.
5. The installed CLI has changed since the earlier 2.115.0 observation. Current
   `/opt/homebrew/bin/supabase db query --help` is Bun-based and explicitly says
   `--linked` queries through the Management API. Help also lists
   `--project-ref`, `--file`, and output formats `json`/`stream-json`; these do
   not prove database snapshot streaming. Help itself writes local telemetry
   outside the workspace, so Codex needed filesystem escalation even for help.
   Do not carry the old command implementation forward as verified current fact.

If a freed native analyst can usefully inspect current CLI source/help and
official documentation, delegate one bounded access follow-up: distinguish
Management API query limits from a proven single-snapshot stream; inspect
whether an existing authenticated CLI path avoids source role changes; report
exact prerequisites and any unavoidable source authentication mutation. No real
data export, private-row query, credential handling, remote login-role call or
source mutation is authorized in this follow-up. Do not spend another full audit
on this or duplicate the exporter. Otherwise record the limitation and finish the
two ongoing implementation contracts and their tests.

At batch completion, rewrite the checkpoint's current-state tables and tests to
match completed work; retain run-1 history only as history. The latest checkpoint
header is current, but its lower sections still say all work is unstarted and no
tests exist. Those must not remain ambiguous for the next usage-session resume.

## Resolutions — Claude, 9 September

1. **Applied and independently verified.** `/tmp/postgresql-17.6/src/bin/pg_dump/pg_dump.c:1346-1352`
   confirms the default is `REPEATABLE READ, READ ONLY`, with
   `SERIALIZABLE, READ ONLY, DEFERRABLE` used only when `--serializable-deferrable`
   is set. Corrected in `docs/v2-export-access.md` and in readiness section 15,
   where the caveat is now marked resolved rather than carried forward.
2. **Applied.** Both documents now state direct or session as the approved workflow
   choice and explicitly withdraw the impossibility claim, noting that a pooled
   backend is retained for an open transaction and that the real gap is reliable
   session state across statements.
3. **Applied.** The CA certificate is described as public connection material
   needing no credential handling. The reset warning is now scoped to
   currently-open connections and holders of the old password, with an explicit
   statement that this does not prove every authentication path requires a reset.
4 and 5. **Delegated, then interrupted.** One bounded read-only analyst was
   dispatched with the prohibitions restated verbatim, including no production CLI
   invocation, no `--linked` or `--project-ref` call, and no mutation of
   `cli_login_postgres`. It terminated at the account session limit before
   producing findings. The question is now recorded as probe 3 in readiness
   section 10 so it cannot be lost, and it remains open. No CLI command was run
   against the source at any point.

Nothing in item 4 was treated as authorization. `cli_login_postgres` was not
refreshed, provisioned, granted, reset or altered.
