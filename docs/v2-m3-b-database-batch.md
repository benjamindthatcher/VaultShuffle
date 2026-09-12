# M3-B database implementation and probe gate

Coordinator review of the completed M3-A schema/manifest proposal, 9 September
2026. This is the next bounded database batch. Preserve the active export agent's
ownership. Use a native Claude implementer at max while Claude usage remains.
The architecture plan remains authoritative; the decisions below apply it.

## Authorized scope and ownership

Own `database/v2/M3-contract.md`, `database/v2/migration/**`, one NEW
CLI-named M3 migration under `database/v2/supabase/migrations/`, and new M3 SQL
tests/checkpoint under `database/v2/`. Read the Supabase skill. Read source/code
locally to resolve meaning. Do not edit M1/M2, package files, root ledger, the
architecture plan, exporter modules or user work. No remote command, source
query, source mutation, provider activation, environment change, deployment,
commit or paid resource. Local disposable database testing is authorized; do
not touch M1/M2 evidence databases, cluster memberships or the export fixture DBs.

The M3-A physical proposal is accepted as a preservation direction, but it is
not yet an executable contract: several relations lack columns/types/invariants.
You may now implement the exact private physical contract and a new migration,
debug and validate it locally, and return it for coordinator review before ANY
remote apply or real load. Keep unresolved source-value decisions fail-closed in
the loader/manifest. Do not coerce rows to make a test green.

## Binding decisions

1. Preserve draw/impression/action history, source IDs, bounded finalists and
   provenance. Preserve versioned frozen warm-start evidence separately from new
   learned state. Preserve manually tuned operator configuration separately from
   both. These are already required by plan 14.2; whether they survive is not an
   open decision. Design exact private `app`/`reco` relations and constraints.
2. Add the missing catalogue evidence, duration estimates, offers/current prices,
   provider retry state, aliases and review/manual-decision destinations from
   plan 5.4/14.2. Preserve the source's actual US price observations, not invented
   regional observations or indefinite price history. Preserve useful metadata,
   raw weighted tags, review counts, four-way Deck detail, ordinal confidence,
   manual duration decisions and first-seen provenance. Do not add duplicated hot
   per-account catalogue facts. A forced legacy `steam_type='game'` is legacy
   classification evidence; preserve it without asserting a new provider check.
   Quarantine evidence must not silently rewrite classification without a
   deterministic precedence rule and reconciliation proof.
3. Support records must survive in a private, owner-only domain with source
   record/account mapping, consent, status and timestamps intact. No browser role
   or general runtime SELECT access. Do not invent a purge deadline that deletes
   existing support content during rehearsal; record the retention-policy
   decision separately for M6/M7. Account deletion/export must still cover it.
4. Preserve application abuse cooldown obligations in a separate private
   operational destination, never in M2's keyed provider-budget tables. Record
   algorithm/version, source time/window and expiration needed for a conservative
   cutover bridge. No reset or activation is authorized here.
5. Preserve unknown-game completion history without fabricating a catalogue or
   ownership identity. Prefer a separate retained-history relation with source
   event ID, original nullable identifiers, actor/surface, occurred/undone state
   and metric provenance; keep M1's valid resolved-event invariant. The later
   history read model must include this relation and avoid duplicate event IDs.
6. Preserve exact observed minutes AND any authored/legacy hours that cannot be
   reproduced. An hours mismatch is evidence of disagreement, not proof that a
   user authored it. Never max/coalesce incomparable family/personal observations.
   Preserve raw decimal evidence and provenance; choose active-value precedence
   only after code evidence and measured probes. Do not widen the compact active
   library row for exceptional evidence. Pin conversion must preserve an exact
   decimal baseline or checked conversion evidence if integer minutes lose data.
7. Add `games_with_playtime` to daily history; keep cumulative totals and unknown
   unevidenced coverage. A per-row constant semantic string is unnecessary when
   the relation/contract already defines cumulative semantics; document the
   meaning clearly instead. Preserve negative/decreasing anomalies as conflicts,
   not inferred daily gains or forced monotonic totals.
8. Preserve lender display metadata. Orphan family-access evidence is retained
   privately but does not manufacture a member or confer access. Deleted merge
   source UUIDs get deterministic deleted-account tombstones and map entries;
   inventory the union of existing identities and required tombstones before
   assigning integer IDs. Include legacy family-member identity mapping where
   public/member IDs are preserved. No added identity may confer verification.
9. Collection position gaps are legal under a uniqueness constraint; do not
   report every gap as a load blocker. Duplicate positions require stable,
   deterministic ordering based on source ordering semantics and original order
   evidence, not dropped members. Preserve nonempty notes without truncation.
10. Recency provider and evidence kind are independent facts. Interval nullability
    does not necessarily encode the original evidence kind; preserve it explicitly
    where needed. Never invent interval starts or turn NULL visibility into hidden.
    Resolve account/profile visibility precedence from the actual writer/read path
    and observation timestamps; preserve conflicting source evidence until resolved.
11. Bounded phase transactions as existing target owner `postgres` are accepted.
    New owner-only migration/staging relations need no privileged runtime loader.
    Scope the "unchanged ACL" assertion to existing runtime permissions; new
    domain tables still need appropriate least-privilege RLS and explicit grants.
    Existing app/worker roles remain NOLOGIN/NOBYPASSRLS/NOCREATEROLE. Public,
    anon and authenticated roles must gain no private access. Every phase records
    the same source snapshot/manifest hash, is idempotent or clearly restartable,
    and rejects mixed-run state. Rehearsal requires no production maintenance.
12. Archive retention must follow plan 13. Raw migration staging/exports expire
    within 30 days of validated cutover, except an explicit recovery incident;
    "permanent while feature exists" or "review at M7" is not a bounded staging
    retention policy. Move lasting authored/provenance facts into appropriate
    durable private domain relations with deletion semantics. Preserve original
    facts first; classify/filter old routine worker payloads with measured counts.
    Do not delete sole evidence under a vague archive label. Stale
    `user_game_state` never becomes transform authority.

## Probe and manifest corrections required before coordinator execution

- Compile every probe against a disposable source-schema fixture built from the
  recorded inventory. Add meaningful adversarial rows for each conflict class;
  tests must prove the aggregate detects it, not merely search for SQL keywords.
  `net.http_request_queue.created` is not established by our public inventory;
  query non-public column metadata before depending on it. Separate platform
  schema probes from public probes, and fail clearly on absent optional objects.
- "Count-only" is currently too broad a claim. `PX` returns arbitrary JSON keys
  and unconstrained text group labels, and P08 returns freeform catalog comments,
  defaults and trigger definitions. JSON keys can themselves contain private
  values. Use allowlisted enum buckets plus `other` counts and aggregate JSON
  shape/key-count statistics. Separate potentially sensitive schema definitions
  into a privately captured/reviewed artifact; never bulk print them.
- Use schema-qualified public relation references, explicit read-only mode and
  bounded statement/lock timeouts in the runner. P07 digest collision must test
  the decoded representation across both tables after validating shape; case
  variants can be distinct text and identical bytea. Treat SQL NULL correctly.
- The P05 decimal formula is not literally identical to IEEE-754 JavaScript for
  every large value. Check realistic numeric range and boundary fixtures, and
  label any mismatch conservatively. A max difference is not author attribution.
- A repeatable-read snapshot remains consistent while schedules write. Correct
  the non-public manifest claim that an unfenced scheduled write invalidates the
  snapshot. Schedule fencing belongs to final cutover, not a read-only rehearsal.
- Non-public names establish neither emptiness nor absence of custom objects.
  Capture safe metadata and aggregate counts where needed; all nonempty storage
  deserves disposition, including public buckets. Extension schemas must be
  assessed for custom objects, not assumed to contain no application data. Avoid
  unsupported history claims about a deleted migration folder.
- Strengthen the validator: require source project identity and expected relation
  kinds, reject duplicate inventory entries, and provide a strict final-load mode
  that rejects unresolved decisions. Coverage mode may list unresolved columns,
  but its success must not be confused with migration readiness. Link destinations
  to the actual new physical contract. Rebuild generated outputs consistently.

## Return gate

### New measured evidence from coordinator, 21:39–21:40 UTC

Read `database/v2/source-nonpublic-audit-20260909.json` and
`database/v2/source-playtime-audit-20260909.json`. These are read-only aggregate
audits, NOT an export or a final freeze snapshot. No private row value was
returned. The public playtime audit ran all nine reviewed P05/P06 statements in
one repeatable-read read-only transaction with 30-second statement timeout and
2-second lock timeout; its exact wrapped SQL is saved beside the result.

- Auth users, storage buckets, storage objects and queued HTTP requests are all
  zero at this observation. The non-public metadata inventory covers 45
  relations. `net.http_request_queue` has NO `created` column, confirming the
  proposed P02e query would fail. Do not infer an age that the queue cannot hold.
- All 365,610 owned library rows have exact observed minutes, and zero disagree
  with the reviewed decimal hours formula. All 1,563 family rows have unknown
  minutes and zero hours; preserve unknown, never convert them to observed zero.
  All 62 pin baselines convert to whole minutes in this audit. All 13,157
  completion events with hours likewise convert to whole minutes; 401 have no
  hours. This resolves the current population concern, but the real export must
  re-run the same checks and fail/reconcile any new divergent evidence.
- Stale staging has 24,428 rows, three completion timestamp disagreements across
  three accounts, one last-played disagreement, 284 last-observed disagreements
  and 343 recency-evidence disagreements. It is demonstrably not authoritative.

These counts are current evidence for this assignment, not permission for the
worker to query production. The coordinator still owns remote audit/execution.

Return exact new migration hash, exact schema/manifest decisions, all remaining
source-value blockers, meaningful local SQL/probe/validator test results and
commands, fresh replay as target-like non-superuser postgres, privilege/RLS and
cleanup assertions, plus an updated database checkpoint. No M3 completion claim:
actual consistent source export, transforms, independent parity, reconciliation
and measured storage remain later gates. Write completed layers to disk before
starting another so session limits leave a precise continuation point.
