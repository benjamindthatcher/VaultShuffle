# Claude ownership return — 10 September, 13:17 UTC

> Ownership superseded at **13:44 UTC**: Claude allowance exhausted, all 64
> native tasks finished, auto-continue remains off, and a no-overlap message is
> verified queued. Existing max Luna database/manifest workers resume these
> paths; exporter worker advances to `docs/v2-m3-c-reader-batch.md`. Exporter's
> RLS layer passed 81 unit / 29 actual PG tests and coordinator review. Do not
> restart Claude implementers before reconciling the latest execution ledger.

The user reports Claude allowance is back. Codex verified exporter Luna is
completed, and database/manifest Lunas errored at their allowance limit. No Luna
is writing. This supersedes the 03:29 stop message and ownership banners in the
earlier resume file. Return the three disjoint scopes to native Claude agents,
Opus 5 / max, keeping the parent Opus 5 / Ultracode. Let each finish a meaningful
batch autonomously. Root owns integration signoff, ledger, plan and remote work.

Read the actual saved files. Checkpoints are uneven: the database checkpoint
still says an implemented migration is empty. Do not restart from its old table.
The earlier `v2-claude-resume-20260910.md`, M3-B batch and capability decision
remain acceptance requirements, with the updates below.

## Exporter: one remaining correctness gate

Own `lib/v2/migration/export/**`, `lib/v2/migration/shared/**`, export contract
and exporter checkpoint. Latest completed result: **74 unit tests, 21 actual
fresh-PG integration tests, typecheck and targeted lint passed**. Auth ordering,
SCRAM proof checks, freeform server-error suppression, full public inventory
drift checks and mid-COPY failure passed. Preserve these completed layers.

Root review found that `REQUIRED_SESSION_SETTINGS` does not set `row_security`
and source role validation does not otherwise prove complete visibility. A
SELECT/COPY under a restricted non-owner can silently return a policy-filtered
subset while the run publishes a valid-looking manifest. Checking the table's
RLS flag is not enough. Set and verify **transaction-local `row_security=off`**
before source reads: this does not bypass RLS; it makes a filtered query error.
PostgreSQL uses this for complete backups:
[PG17 row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html),
[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html).

Add actual synthetic tests with a NOSUPERUSER/NOBYPASSRLS non-owner and a
selective policy, plus default-deny/FORCE RLS, proving a partial or empty export
cannot finalize. Retain a positive full-visibility case. Do not grant source
BYPASSRLS or modify any remote role/table. Record the setting in the manifest.
The existing auth/privacy gates remain required. Finish this bounded fix and
updated real integration, then return the exporter for signoff; no real export.

## Database: finish the physical gate, including preservation and deletion

Own `database/v2/M3-contract.md`, the single existing migration
`20260909214501_m3_preservation_schema.sql`, `database/v2/tests/m3*.sql` and
`database/v2/M3-checkpoint.md`. Marker fix is now present; keep `m1`. Scope grants
to named new objects and prove old runtime ACLs unchanged. Do not add a second
migration or modify M1/M2. Final fresh replay is still unaccepted.

Root found a concrete unresolved M3-B requirement in the current contract's
retention table: it still says auth intents 90 days, merge/purge archives for
feature lifetime, catalogue/queue evidence until equivalent history or M7,
library evidence M3 plus a release cycle. These conflict with plan 13 and M3-B
binding rule 12. Reconcile actual DDL and contract together: raw migration
staging/export evidence is bounded to 30 days after validated cutover; useful
lasting private facts must have durable domain destinations and account
deletion/export semantics. Do not simply rename a retention class or discard
sole authored/provenance evidence. Prove deletion coverage of private rows
retaining original account UUIDs, including rows whose integer FK currently
uses ON DELETE SET NULL. Support's explicitly pending content-policy decision
does not waive account deletion/export. No real purge or cutover is authorized.

One exact physical addition is approved to close D-IDN-4: nullable
`app.accounts.last_login_at timestamptz`, preserving `app_users.last_login_at`
as the legacy interactive-login instant, separately from `last_seen_at` (legacy
`app_accounts.last_visited_at`). `lib/auth.ts:86` explicitly distinguishes
long-lived-session visits from login. Preserve the original instant and NULL;
do not derive it from visits or apply a geographic offset. Include mapping,
delete/export and semantic tests; coordinate the destination with manifest.

Do not label all legacy hours authored: an hours discrepancy alone cannot prove
authorship. Preserve exact observed minutes plus unreproducible legacy numeric
and raw text separately, keeping sparse durable evidence as already directed.
The future snapshot must reconcile new discrepancies before runtime projection.

Complete the existing contract/migration/tests and run M1+M2+M3 from clean
initdb as target-like NOSUPERUSER postgres, with actual constraint, RLS, old ACL,
retention, deletion, idempotency and replay assertions. Return exact migration
hash and evidence. Correct the stale checkpoint as each layer finishes.

## Manifest/probes: semantic integration gate

Own `database/v2/migration/**` and probe checkpoint. Latest saved result is
**73 Python tests**, SQL-derived destination index **83 relations / 901
columns**, coverage 44 source relations / 486 columns, strict load rejected
for **2 unresolved columns / 6 open relations**. These are saved claims to
verify once against the final physical migration, not M3 completion.

Root found an actual semantic contradiction despite the checkpoint's correct
prose: `manifest/dispositions/00-identity-and-sessions.json` still maps legacy
false visibility to hidden in all three account visibility transforms. Correct
every source disposition and regenerated output to the binding account tuple
decision: true→visible; false/NULL→unknown absent independent privacy evidence.
Test the actual generated transforms/contract against these semantics so a
coverage pass cannot bless the opposite rule. Preserve differing raw evidence.

Integrate the approved separate last-login destination, durable private-fact
and retention corrections from database. Rebuild and validate destination hash
from the final SQL. Distinguish real snapshot requirements from already settled
architecture decisions; keep future snapshot exceptions fail-closed. Do not
call unreproducible hours proven authored. Existing code/source/audit evidence
may resolve meaning; do not repeat broad live source queries or browser access.
No need to rerun unchanged public probes unless edits justify it.

## Clean test runtime and standing boundaries

Root restored full PG17.6 with default PGMQ1.5.1 under the ignored, shared
read-only prefix:
`/Users/benthatcher/Documents/GitHub/VaultShuffle/node_modules/.cache/vaultshuffle-pg17-20260910`.
`bin/initdb` and `share/postgresql/postgres.bki` are verified present at 13:18UTC.
Old `/tmp` prefix/source/catalog files disappeared. Do not diagnose or clone
those damaged/polluted clusters again. Each worker may create its own fresh
initdb data/log directory under ignored `node_modules/.cache/vaultshuffle-m3-*`,
a short owner-only `/tmp` socket and distinct port. Unix-only tests are valid;
Node synthetic TLS remains separate. Do not stop/repair siblings or M1/M2
evidence DBs. Exporter's last clean cluster was stopped and data/socket removed.
Local socket/listener escalation is authorized for these synthetic tests.

No production/source query or mutation, source credentials/login-role refresh,
remote apply, real export, deployment, provider activation, env switch, package
change, paid resource or commit in these batches. These boundaries leave all
assigned local implementation and validation authorized. Parent may update its
three prior reports. Bank a precise checkpoint before every usage interruption.
M3 remains incomplete until real snapshot, transforms, independent parity,
reconciliation and measured storage pass; M4–M7 remain afterward.
