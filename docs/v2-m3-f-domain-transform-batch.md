# M3-F: catalogue and library transforms

**Ownership superseded at 19:34UTC:** user reports Claude exhausted. Codex's
existing max Luna identity/manifest worker now owns the catalogue/game branch;
the export/session worker owns library/family/history after completing its
known adapter fix. Preserve Claude's partial files and shared contract; finish,
debug and validate rather than restart. Claude must not automatically resume
or edit these scopes until root transfers them back. Root owns integration.

Update after dispatch: physical final4 changes only the retention view/indexes
and contract wording, with the same 92 relations / 991 columns. Current SQL SHA
is `605b72a3d9df1328ec27033c3420c1813a238f6e15bd8fc28f971cddaf30a24a`,
contract `46e9b982395cb2800da1247d22afc43de0e1cc3e99df1fc632a7b032142a3577`.
Use these at the integration gate. The earlier hashes below record dispatch.

Coordinator assignment, 10 September 2026, 19:05 UTC. Claude Opus 5 / Ultracode
coordinates native Opus 5 / max implementers while allowance is available.
This is a bounded local implementation batch, not a migration completion gate.

## Ownership

- Native catalogue implementer: new `lib/v2/migration/transform/games*` and
  `catalogue*`, tests, and `docs/v2-m3-catalogue-{contract,checkpoint}.md`.
- Native library implementer: new `lib/v2/migration/transform/library*`,
  `family*`, `history*`, tests, and
  `docs/v2-m3-library-{contract,checkpoint}.md`.
- Claude parent: one integration contract/checkpoint for this batch at
  `docs/v2-claude-domain-transforms.md`; coordinate shared APIs before coding.
- Codex's existing max Luna identity/manifest worker retains `accounts*`,
  `scalars*`, and `database/v2/migration/**` only to finish root review fixes and
  refresh final physical hashes. Session/capability worker retains `sessions*`
  and `capabilities*`. Database worker has returned its physical gate; root
  reviews it. Do not restart old Claude database/exporter/manifest agents.

Do not edit sibling files, M1/M2/M3 SQL, package files, production application
code, plan or root ledger. Read their current contracts. Necessary shared
changes must be proposed to root or the current owner, not duplicated.
No source/remote query, real export, credentials, source auth change, target
apply, deployment, worker/provider activation, commits, or production writes.

## Binding inputs and contracts

Use architecture sections 5, 13, 14, the current source inventory, structured
column dispositions, M3-B rulings and physical M1/M3 contracts. Actual source
cells are exact `string | null` from the accepted reader. Reuse `scalars.ts`
for exact numbers and microsecond instants. Run identity must be explicit and
match maps/input/output; source counts from old audits are never preconditions.
Use bounded memory/explicit row limits, stable code/count-only public failures,
and deterministic semantic output. No `Date` truncation, numeric precision
loss, private values in exceptions, wall-clock defaults, silent repairs or
discarding a malformed row while calling the remainder complete.

The physical return is SQL SHA
`7a82d2eb070bbb08688e95111cc6da095a83591d03a9703c5f5123f11d6eefe3`,
contract `688482b9c24a4c815b4112d86681f66848dc2399f8b21ae5a6dbe27fba8ac7b1`.
92 private relations / 991 columns. It is locally replayed, not remotely applied.
Physical gaps are blocking findings for root, not permission to add SQL or
fabricate values. Proposed typed records must be explicitly mappable to these
columns; distinguish transform evidence from destination fields.

## Catalogue domain

First publish one reviewed game-map interface for both implementers. Inventory
the complete valid Steam AppID union needed by the actual source relationships
before deterministic numeric AppID sorting/numbering; preserve AppID text and
enforce 1..4294967295 and target integer-key bounds. Duplicate/conflicting source
identities, missing references, or inconsistent same-run maps fail explicitly.
Catalogue identity never confers ownership. Unknown/null completion identity
does not justify inventing a game; its separate retained-history destination
is already in the contract. Required catalogue stubs need explicit source
identity/title/provenance and a documented fallback rule from the reviewed
contract; propose unresolved cases instead of guessing titles or timestamps.

Implement the `catalog_games` disposition into games, metadata, features and
actual US offer/price observations, and its minimal legacy classification
evidence. Preserve exact values, NULL/zero, civil dates, weighted tag structure,
tri-state platforms and four-way Deck detail, review sample counts, ordinal
duration confidence and manual override facts. Forced legacy `steam_type=game`
is evidence, not a fresh provider classification. Preserve classification and
quarantine precedence explicitly; if its existing rule is insufficient, return
a concrete unresolved case rather than silently deciding it. Do not fabricate
an enrichment/capture timestamp, probability, region/currency conversion or
manual-decision provenance.

Handle source PostgreSQL arrays and JSON without precision loss or shape
coercion. Keep metadata bounds faithful to PostgreSQL character/JSONB semantics;
if a pure precheck cannot prove encoded storage size, make the later SQL
constraint check an explicit required gate. No silent truncation or wrapping a
wrong JSON shape. This batch may leave provider/duration resolver, seed/import
run and guest rebuild transforms as explicitly pending later modules; cover
every `catalog_games` field and all implemented classification inputs now.

## Library domain

Consume the same-run account and game maps. Transform authoritative
`user_games`, family members/access, daily playtime history and completion
history into actual M1/M3 destinations, preserving source identity maps.
Implement sparse state/activity/retired facts and sparse legacy measurement
evidence together with the bounded raw staging records needed for reconciliation.
Do not promote stale `user_game_state` into current authority; preserve full
audit staging and only sole useful sparse evidence durably under M3-B.

Exact observed personal minutes and raw legacy decimal hours remain separate.
Follow plan 14.2's exact-observed preference; discrepant values require an
explicit unresolved reconciliation result until root signs the active-value
decision. A discrepancy does not prove authorship. Family lender playtime never
becomes personal playtime, and member removal/orphan evidence must not fabricate
access. Preserve simultaneous lenders, member display/candidate data and the
five-other-member cap. Wishlist/retired measurement semantics must follow the
actual legacy status/access writers and manifest, with missing/unknown distinct
from zero. Derived completion percentage is not an authored manual override.

Preserve completion event UUID, actor/surface, original nullable game identifiers,
occurred/undone state and exact measurement provenance. Use the resolved versus
unknown-game history relations with no duplicated event identity. Daily totals
remain cumulative with `games_with_playtime` and unknown coverage; do not infer
daily gains or fix decreasing/negative anomalies. `purge_reviews` action versus
completion duplication remains its documented snapshot gate; no generated
completion event without a resolved explicit rule. Collection/pin/snooze/vault
and recommender/config/support transforms are outside this batch.

## Acceptance and autonomy

Each implementer implements, debugs and validates its whole domain autonomously.
Coordinate map/scalar/account interfaces once, then reengage for concrete
blockers or completed review only. Use independent expected adversarial outputs:
permuted inputs, exact bigint/decimal/UTC/date boundaries, mixed runs, missing
and duplicate identities, target overflow, same AppID across accounts, family
versus personal attribution, unknown completion identity, sparse-state
preservation, malformed PG array/JSON and safe errors. Exercise pure outputs
against disposable PG17 M1/M2/M3 constraints where useful, with private synthetic
rows only; own a fresh isolated cluster/database, never alter sibling fixtures.

Targeted tests, strict typecheck with repository target, and lint must pass.
Claude parent performs one completed integration review and combined domain
test gate, reports exact files/commands/results/assumptions/remaining fields and
any blocking physical decision, and saves resumable checkpoints before limits.
Do not report M3 complete without the real snapshot/parity/storage gates.
