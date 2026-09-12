# M3-A: Claude implementation batch

Coordinator assignment, 9 September 2026. The user requested Claude app and native
Claude subagents instead of Luna agents for now. Preserve the user's current
Opus 5 / Ultracode selection. Codex retains cross-domain decisions, integration
review, remote apply and milestone signoff. This file is the concrete handoff;
the architecture plan and execution ledger remain authoritative.

First fold the completed constraint-sweep subagent's findings into the readiness
report. Then execute the batch below autonomously through implementation,
debugging and validation. Use meaningful native subagent assignments with
non-overlapping ownership. Return at the completed batch gate or a real blocker.
Do not repeatedly ask Codex about routine implementation details.

## Boundaries

M1 and M2 are complete and immutable. No M3 DDL is authorized yet: propose the
physical contract for coordinator review before implementing or applying it.
No production writes, password reset, role creation/grants, paid resources,
deployment, environment switch or provider activation. No real source data export
until this exporter batch has been reviewed. Do not read private rows or secrets
for the schema/manifest work. Do not expose credentials, session hashes, emails
or private records in chat, screenshots, reports or command output.

The user explicitly asked us to investigate the existing Supabase connection and
use their browser through Claude when helpful. Do not declare access impossible
merely because `.env.local` lacks a PostgreSQL URL. Codex's connector currently
exposes management SQL, schema migrations and metadata, with no discovered bulk
snapshot/export or database-password tool. Local `.env.local` contains only the
legacy API URL/key; relevant process variables, `.pgpass` and `.pg_service.conf`
are absent. Do not search unrelated user files or secret stores. Do not use a
Supabase CLI command on production if it initializes/provisions a login role.

## Export subagent

Own `lib/v2/migration/export/**`, `lib/v2/migration/shared/**`, and
`docs/v2-export-contract.md` (all new).

Implement an opt-in streaming snapshot exporter and run manifest with bounded
memory, per-relation hashes/counts and private file permissions. Use one direct
or session `REPEATABLE READ READ ONLY` transaction, or an equivalently proven
single-snapshot stream. Use explicit UTC; preserve civil dates, nulls, exact
numerics and bigint values. Reject accidental project/destination mismatches.
Require explicit source identity, a private connection file and output directory.
Never expose credentials through process arguments or unsanitized errors. Failed
exports remain clearly incomplete; restart takes a new snapshot rather than
combining files from multiple snapshots. HTTP pagination is not snapshot proof.

Remote transport must verify TLS certificates. The temporary PostgreSQL client
at `/tmp/vaultshuffle-pg17` has `USE_OPENSSL` undefined and is suitable only for
our synthetic Unix-socket tests. Do not weaken TLS. Obtain/build a TLS-capable
client under a separate temporary prefix if needed, or make the prerequisite
explicit. Consult official current docs and CLI help when implementing.

Test actual concurrent writes during a synthetic local export, abort/partial
output/privacy handling, large integers, UTC/DST and civil-date preservation.
Use a separate disposable local database; do not touch M1/M2 evidence databases
or cluster memberships. The local socket is `/tmp/vaultshuffle-pg17-socket`,
port 55432, admin `vault_local_admin`; there are no external credentials involved.

## Schema and manifest subagent

Own `database/v2/M3-contract.md` and `database/v2/migration/**` (all new).

Produce a machine-readable table/column disposition manifest, validator/tests,
and bounded count-only source-probe SQL for coordinator review. The live metadata
file `database/v2/source-schema-inventory-20260909.json` contains 44 public
relations / 486 columns: 42 base tables plus 2 derived views. Every relation and
column needs explicit preservation, transformation, derived retirement, audit or
an explicitly unresolved decision. Fail mechanically on unexpected schema drift.
Do not equate a broad table-level disposition with complete column coverage.
Propose assessed dispositions for non-public schemas; never blindly export Vault
secrets or schedule definitions containing authorization headers.

Propose exact private relations, grants/loading procedure, preservation fields
and constraints required for the real M3 load. Do not write a migration yet.
Distinguish potential constraint conflicts from violations actually measured in
source data. Prepare count-only probes, never raw row queries. Preserve evidence
and make unresolved semantic decisions visible rather than silently dropping or
coercing data. Any permanent archive must have explicit purpose and retention.

## Browser and access subagent

Use one bounded native subagent if browser tools are available. Own only
`docs/v2-export-access.md`, containing nonsecret findings.

Inspect the user's existing signed-in Supabase dashboard for Ireland project
`pfvblcopcmairdfeqdep`: existing direct/session connection capability or a
snapshot-consistent backup/export path. Read-only inspection only. No password
reset, permission changes, role provisioning, billing changes, remote DDL or
deployment. If an existing credential can be made available safely in a private
local file, return only its restricted path and capability, never its value.
Do not expose secrets/private records through browser captures or logs. If the
browser capability is unavailable, report the concrete limitation. Do not
duplicate exporter implementation or request user credentials prematurely.

## Coordinator review decisions

- A target management query now verifies current operator and owner `postgres`:
  NOSUPERUSER, BYPASSRLS=true, CREATEROLE=true, LOGIN=true. All private tables are
  owned by postgres. A new permanently privileged loader role is not automatically
  necessary; propose a tightly bounded migration-operator load with runtime ACLs
  unchanged.
- Daily playtime snapshots remain cumulative totals, with unknown coverage where
  not evidenced. Preserve `games_with_playtime`; do not convert totals to gains.
- `app_settings` is tenant preference data. `algorithm_weights` is manually tuned
  signal configuration: `lib/genre-preferences.ts:112` and
  `lib/genre-preference-worker.ts:79` explicitly describe hand-tuned rows. Preserve
  and version it separately from learned warm-start aggregates. Its shape alone
  does not make it learned preference evidence.
- `api_rate_limits` implements application abuse control. M2 implements keyed
  provider budgets. They are separate systems. Do not approve an unqualified
  reset-at-cutover deviation; preserve cooldown obligations and propose
  conservative handling for M6/M7.
- Preserve exact minutes separately from rounded hours. Authored baseline unit
  conversions need explicit provenance and checked rounding.
- Preserve completion origin surface/source event IDs and unknown-game history;
  recency provider and evidence kind; Deck Playable versus Verified; ordinal
  confidence without fabricated probabilities; lender display fields; manual
  duration decisions; merge tombstones and deleted source public IDs.
- Empty notes can normalize to null. Nonempty text cannot be truncated or dropped.
  Do not weaken constraints or fabricate personal/family access to make rows fit.
  Legacy catalogue classification is provenance, not a fresh provider observation.
- Hash exact export wire representation for integrity, then define typed
  canonicalization for transformed parity. JSONB has already lost original
  provider formatting. Neither blanket reserialization nor treating every JSON
  document as forever opaque is the entire design.
- Retain raw `date_added` evidence until disposition is agreed; never parse
  DD/MM/YYYY with a US/default parser. Apply no geographic timestamp offset.
- Keep stale `user_game_state` isolated for audit/reconciliation. It must never
  resurrect authored state or activity in the transform.

## Integration and return

Main Claude may integrate the new paths above and update its readiness report.
Leave the architecture plan, main execution ledger, package files, existing
runtime/import contracts and pre-existing dirty user files untouched. Use direct
documented test commands instead of changing npm scripts. If a file was created
concurrently by Codex, stop before overwriting it.

Return exact files, proposed contracts/probes requiring coordinator decisions,
actual test commands/results, native subagents used, remaining blockers and the
next recommended batch. Synthetic fixtures are implementation evidence only.
M3 remains incomplete until real-data rehearsal, independent per-account parity,
checksum validation, zero unexplained data loss and measured storage gates pass.
