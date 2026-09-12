# M3-F integration contract: the shared game map

**Handoff 19:34UTC:** Claude exhausted per user. Preserve this agreed API.
Catalogue/game implementation transfers to Codex max Luna identity/manifest
worker; library/family/history transfers to Codex max Luna export/session
worker after its current adapter fix. Do not resume Claude implementation
without root ownership reconciliation. Final physical hashes are in the M3-F
batch update, superseding the dispatch hashes below.

Claude parent, 10 September 2026. Companion to
[the M3-F batch](v2-m3-f-domain-transform-batch.md). This file exists to be read
BEFORE either domain implementer writes code, because both consume the same map
and an interface invented twice is an interface that disagrees.

Verified against disk at dispatch, both matching the coordinator's stated return:

```
7a82d2eb070bbb08688e95111cc6da095a83591d03a9703c5f5123f11d6eefe3  20260909214501_m3_preservation_schema.sql
688482b9c24a4c815b4112d86681f66848dc2399f8b21ae5a6dbe27fba8ac7b1  database/v2/M3-contract.md
```

92 private relations, 991 columns, locally replayed and not remotely applied.

## Ownership

The **catalogue implementer produces** the map. The **library implementer
consumes** it and never builds one. Neither edits the other's files. A change to
the shape below is proposed here first, not implemented twice.

## Why a shared map at all

Five legacy relations address a game by the per-account library UUID rather than
by catalogue identity, and a sixth carries a nullable AppID with no foreign key.
Every one of them has to resolve through a single agreed mapping or the two
domains will produce records that cannot be joined. The account map already
established the pattern in `transform/accounts.ts`; the game map mirrors it
deliberately rather than inventing a second idiom.

## Shape

Mirror `AccountMapTargetRecord`. Field names are the contract:

```ts
export type GameMapTargetRecord = Readonly<{
  /** Exact source AppID text. Never a number, never re-rendered. */
  legacy_app_id: string;
  /** Target catalog.games.id. */
  game_id: number;
  /** Where the identity came from, so a stub is never mistaken for a catalogue row. */
  source_kind: "catalog_games" | "stub";
  source_snapshot_hash: string;
}>;

export type GameMap = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  entries: readonly GameMapTargetRecord[];
}>;
```

The lookup the library implementer calls:

```ts
export function lookupGameId(map: GameMap, legacyAppId: string | null): number;
```

It **throws** rather than returning null or a sentinel. A missing identity is a
transform failure, not a value.

## Rules both implementers must hold

**Run identity is explicit and checked.** Every record carries the same
`run_id` and `snapshot_hash`. A library transform handed a map from a different
run fails immediately with a stable code. Counts from older audits are evidence,
never preconditions.

**AppID text is preserved exactly.** It is `string | null` from the reader and
stays text in the map. Validate the range 1 to 4294967295 and the target integer
key bounds, but never round-trip through a float and never re-render the text.

**Numbering is deterministic.** Inventory the complete AppID union that the real
source relationships require FIRST, then sort numerically and assign. The same
input must produce the same map on every run, including under permuted input
order.

**Failure is explicit, always.** Duplicate or conflicting source identities, a
missing reference, an out-of-range AppID, or an inconsistent same-run map each
fail with a stable code and a count. Never a silent repair, never a default,
never dropping a malformed row while calling the remainder complete.

**Identity is not ownership.** A map entry says a catalogue row exists. It says
nothing about who owns or can access that game. The library implementer must not
read access from the map's existence.

**Unknown completion identity does not create a game.** A completion event with
a null game identifier and a null AppID routes to the retained unknown-history
destination the physical contract already provides. Inventing a catalogue row to
give it a foreign key would fabricate identity.

**A stub is labelled.** Where the contract requires a catalogue stub, it carries
explicit source identity, title and provenance under the documented fallback
rule, and `source_kind: "stub"`. Unresolved cases are returned as findings, not
guessed titles or invented timestamps.

## Shared modules neither implementer reimplements

`transform/scalars.ts` for exact integers, decimals, civil dates and microsecond
instants. `read/reader.ts` for source cells, which are exact `string | null`.
No `Date` truncation, no numeric precision loss, no wall-clock default, and no
private value in an exception message.

## Boundary between the domains

The catalogue implementer owns `transform/games*` and `catalogue*`. The library
implementer owns `transform/library*`, `family*` and `history*`. Codex workers
retain `accounts*`, `scalars*`, `sessions*`, `capabilities*` and the migration
tooling directory. Collection, pin, snooze, vault, recommender, configuration
and support transforms are outside this batch, as are the provider and duration
resolver, seed and import run, and guest rebuild modules.

## What this batch is not

Not a migration completion gate. The physical schema is locally replayed and not
remotely applied. A physical gap is a blocking finding for root, never a licence
to add SQL or fabricate a value. M3 stays incomplete until the real snapshot,
transforms, independent per-account parity, reconciliation and measured storage
all pass.
