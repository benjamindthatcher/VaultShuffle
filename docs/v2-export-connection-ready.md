# Temporary read-only source export connection: ready operator path

Prepared 13 September 2026. This document prepares the source-authentication
step only. It does not create a source login role, read a token, write a
credential profile, open a database connection, or export any source rows.

## Reviewed API boundary

Supabase's Management API documents `POST
/v1/projects/{ref}/cli/login-role`, with required JSON body
`{"read_only":true}`. It requires `database:write` / `database_write`, returns
HTTP 201 with `role`, `password`, and API-provided `ttl_seconds`, and may instead
return 401, 403, 429, or 500. The helper uses only that endpoint for source
login creation; it does not use `supabase db query --linked`, because that CLI
path can provision an administrative temporary login and does not expose a way
to request `read_only:true`.

The source is `pfvblcopcmairdfeqdep` in Ireland. The prepared profile uses its
reviewed direct endpoint `db.pfvblcopcmairdfeqdep.supabase.co:5432`, database
`postgres`, and the generated role as both connection user and
`expected_current_user`. Direct mode is the reviewed first choice. If direct
TCP cannot connect, stop rather than guessing the temporary-role format needed
by the session pooler; that compatibility has not been measured.

The generated profile is exactly the existing exporter format: `profile_version`
1, `role: source-read-only`, TCP, source project identity, `public` required,
and destination-only `app` absent. The exporter performs TLS certificate and
hostname verification with Node's system trust store. If an operator has a
reviewed PEM bundle, pass its absolute path with `--ca-certificates-pem-path`.

## Deferred execution, after root approval

1. Place a management token that has only the required project permission in an
   **existing owner-only 0600 file**, outside the repository. Do not pass it on
   the command line, store it in the repository, or paste it into chat.
2. Create an existing owner-only directory (mode 0700) outside the repository
   for the new profile and export output. The helper refuses a non-private parent
   directory and creates a new profile exclusively with mode 0600.
3. Only after the coordinator explicitly approves creation of a temporary source
   login, run:

   ```bash
   node scripts/migration/prepare-readonly-export-profile.mjs \
     --approve-source-login-creation \
     --management-token-file /absolute/private/management-token \
     --profile-path /absolute/private/export/source-read-only.json
   ```

   The single JSON status line intentionally excludes the generated role and
   password. It reports the endpoint's `ttl_seconds` unchanged. Run the export
   promptly while that API-defined lifetime is still valid; do not infer or
   extend a lifetime locally.
4. Confirm the new file's path and permissions without printing its contents,
   then run the existing explicit exporter command:

   ```bash
   node --experimental-strip-types lib/v2/migration/export/cli.ts \
     --confirm-read-only-source \
     --connection-file /absolute/private/export/source-read-only.json \
     --output-root /absolute/private/export/output \
     --inventory database/v2/source-schema-inventory-20260909.json \
     --schema public
   ```

   The exporter rejects profiles outside its 0600/private-file contract, checks
   project/database/user/schema identity before row reads, starts a
   repeatable-read read-only snapshot, verifies TLS, and fails on incomplete RLS
   visibility. Its output root must already be owner-only (0700).

## Remaining prerequisites and limits

- Root must explicitly dispatch the source-authentication change. This helper's
  confirmation flag is a second guard, not authorization by itself.
- The operator must provide the narrowly scoped management token through a
  private file; this preparation did not search for or obtain one.
- Direct endpoint reachability, real TLS/SCRAM, temporary-role privileges and
  row-security behavior remain unmeasured until the authorized export attempt.
- A failed direct connection must be reported for review before attempting the
  session pooler; this document deliberately does not fabricate pooler user
  syntax for a generated login role.

Sources: [Supabase Create login role API](https://supabase.com/docs/reference/api/v1-create-login-role) and [Supabase's CLI login-role lifecycle note](https://supabase.com/docs/guides/troubleshooting/permission-denied-when-deleting-the-cli_login_postgres-role-808bae).

## Approved execution checkpoint — 13 September 2026

Root recorded explicit user approval for exactly one temporary
`read_only:true` login role and the subsequent existing exporter run. Before any
source request, this worker checked the approved private output location
`/private/tmp/vaultshuffle-m3-export-20260913`: it does not yet exist. It also
checked only the documented/known CLI configuration locations
`~/.supabase`, `~/.config/supabase`, and the macOS Keychain service name
`supabase`, without reading any credential values. The only visible CLI state
was private telemetry/traces; no usable management token/profile was found.

The installed CLI's current documentation identifies the precise native keyring
entry as `Supabase CLI/access-token`; it also specifies `~/.supabase/access-token`
only as the fallback when native credential storage is unavailable. The fallback
does not exist here. Next action: query only that exact keychain item without
printing it, write it into a new 0600 file under the approved private directory,
then run the prepared helper once. Do not repeat the POST if a 0600 source
profile appears; that profile is the durable evidence that the temporary role
has already been created.

## Approved execution result — blocked before source contact

At the approved execution boundary, the exact documented keychain lookup
`Supabase CLI/access-token` returned `SecKeychainSearchCopyNext: The specified
item could not be found in the keychain`. The fallback
`~/.supabase/access-token` was already absent. The helper then refused the
empty private token file before it could issue a management request. There is no
`source-read-only.json`, no temporary role, no database connection, and no
export output in `/private/tmp/vaultshuffle-m3-export-20260913`.

The exact missing prerequisite is an existing Supabase Management API token with
the source project's `database_write` permission, placed by the authorized
operator in a 0600 file at the prepared private location (or made available in
the documented `Supabase CLI/access-token` keychain item). No alternate
credential locations were searched and no authentication workaround was used.

### Wrapper-provider discrepancy follow-up

The installed Bun wrapper successfully completed a metadata-only `supabase
projects list` under its default `supabase` profile, while its debug output said
the plaintext `~/.supabase/profile` was absent. `SUPABASE_ACCESS_TOKEN` is not
present in this worker process. The wrapper therefore has a native credential
provider despite the missing plaintext fallback. Its own debug label identifies
the default profile as `supabase`; the final narrow native lookup is the exact
`Supabase CLI/supabase` keychain item, keeping the earlier documented
`Supabase CLI/access-token` lookup separate. No other keychain service, account,
or file path will be inspected.

The final exact lookup also returned no keychain item. The wrapper's successful
metadata command is therefore using a credential provider that this approved
shell cannot read through either documented native account. The private
management-token file remains zero bytes and no 0600 source profile exists, so
the helper issued no POST and no temporary role was created. This concludes the
bounded credential-provider investigation: a root-owned invocation context that
can provide the wrapper's Management API token as `SUPABASE_ACCESS_TOKEN`, or a
new explicitly supplied 0600 Management API token file, is required to proceed.

## Resume marker — approved token supplied

The authorized operator supplied a nonempty 0600 Management API token at
`/private/tmp/vaultshuffle-m3-export-20260913/management-token`. The private
root and output directory remain 0700, and no `source-read-only.json` exists.
The next operation is exactly one call to the prepared helper, which posts only
`{"read_only":true}` to the documented login-role endpoint. If the profile
appears, do not call the helper again; proceed to the existing exporter using
that profile.

### Login role created, export execution rejected by automatic review

The helper then returned `profile_created` with API-provided `ttl_seconds: 300`.
The role name and password were neither printed nor recorded; the 0600 profile
exists at the prepared private path. The immediate exporter command was rejected
by automatic approval review before it started. Its stated reason was that it
would read and materialize sensitive production rows and that the reviewer did
not recognize authorization beyond login-role creation. No exporter process,
source row read, manifest, or output run directory was created. This worker must
not retry or route around that rejection; a new explicit approval that names the
local materialization/export is required before a fresh temporary role can be
used.

## Approved real-source export completed — 13 September 2026

The user subsequently approved refreshing the temporary `read_only:true` login
and materializing the complete source export under the existing owner-only
output root. Browser-first access was also requested. The signed-in Brave
Supabase Table Editor confirmed the correct source project and live `public`
schema, but its per-table surface cannot provide one repeatable-read transaction
across all 44 relations. The purpose-built exporter remained necessary for the
atomic, reader-compatible snapshot.

The live schema guard defect was reproduced and fixed without refreshing or
weakening the frozen inventory. PostgreSQL's canonical
`pg_get_constraintdef(oid, false)` matched all 209 inventoried constraints under
the inventory's `postgres` interval representation. Under the export stream's
required `IntervalStyle=iso_8601`, exactly one unchanged CHECK rendered its
15-minute constant in ISO 8601 form. The exporter now verifies and uses the
inventory representation for the exact constraint comparison, then applies and
verifies the canonical export settings before any row stream. A PostgreSQL 17
regression proves both renderings and proves relation interval values remain ISO
8601.

The first approved attempt with the generated login correctly stopped on
`public.account_merges` with `42501`: the login itself is `NOINHERIT`, has no
direct SELECT, and cannot bypass RLS. A bounded metadata and official-docs check
showed that Supabase's `read_only:true` flow had already granted the existing
`supabase_read_only_user` role with inheritance disabled. No new role or grant
was needed. The exporter now activates only that fixed role transaction-locally
and fails before COPY unless PostgreSQL proves all of the following:

- the authenticated session is already a member of the fixed role;
- `current_user` and `session_user` match the expected effective and login
  identities after activation;
- the transaction remains read-only and the effective role is non-superuser
  with `BYPASSRLS`;
- the role has SELECT on every inventoried relation, no table write privilege,
  and no CREATE privilege on the source database or `public` schema;
- `row_security=off` is observed before and after all relation reads, so a
  policy-filtered subset still raises rather than looking complete.

The final run completed and was independently consumed by the existing strict
manifest-v2 reader:

- completed run:
  `/private/tmp/vaultshuffle-m3-export-20260913/output/20260913T130404Z-130c2ad9`
- manifest:
  `/private/tmp/vaultshuffle-m3-export-20260913/output/20260913T130404Z-130c2ad9/manifest.json`
- adjacent view-definition sidecar:
  `/private/tmp/vaultshuffle-m3-export-20260913/output/20260913T130404Z-130c2ad9.schema-views.json`
- manifest SHA-256:
  `b3f9def89106b7e5c4772ee5b3b0449ac16e504da2f8e677e7ee1194837fc3cb`
- sidecar SHA-256:
  `59597f47278c8d7ca4722dd46cd991d80fc80f64ecca83354ba1c37391cfa641`
- aggregate relation-evidence SHA-256:
  `0a788963b65c6c88915bd72909516e0fc0216ba09ff5d310e328b3dff086ece7`
- 44 relations, 486 columns, 1,048,426 rows, and 668,415,359 bytes;
  42 relations are nonempty and two are empty;
- snapshot xmin `202821`, current and closing snapshot `202821:202821:`,
  transaction UTC `2026-09-13T13:04:04.638967Z`;
- repeatable read and read-only were observed, `row_security` remained `off`
  at open and close, and the effective role was non-superuser with RLS bypass;
- completed run and relations directories are 0700; manifest, digest, all
  relation files and sidecar are 0600.

The same transaction captured both inventoried view definitions. They are in
the adjacent create-once sidecar, bound to source project/database/user, run id,
snapshot xmin/current snapshot/transaction UTC, and the final manifest digest;
each body has its own SHA-256. Adjacent placement preserves the reader's strict
three-entry run-directory contract. The strict reader verified all relation
framing, row counts, byte counts and SHA-256 values without exposing source row
content. The V2 target remained untouched.

Validation completed for the implementation: TypeScript typecheck, focused
export ESLint, all 55 export/helper unit tests including local TLS/SCRAM, and the
PostgreSQL 17 constraint/view-sidecar integration against the disposable
`vs_export_guard_fixture` database. This is the first completed real-source
snapshot checkpoint; it is not a target load or cutover rehearsal.
