# M4 bounded read repositories

Updated: 14 September 2026

## Scope and result

The M4 bootstrap, paged library and game-detail repository slice now passes its
required PostgreSQL 17 acceptance gate. It remains a server-only repository
boundary and is not connected to legacy routes or UI.

`BootstrapRepository` returns account/library/state revisions, owned and
distinct-family totals, at most the three `library`-scope pins, and current-pick
metadata. Its payload contains no library row collection. The acceptance
fixture has 1,005 owned games plus family access and asserts that the serialized
bootstrap stays below 700 bytes, includes exactly three library pins despite
three pins in another scope, and retains revision/current-pick values.

`LibraryRepository` reads owned access once and distinct family games once,
even when several family members lend the same game. Personal ownership wins
an owned/family overlap, including the owner's exact nullable minutes; a
family-only row always reports `NULL` minutes. Default pages contain 50 rows,
the maximum is 100, and the `(title, game_id)` cursor makes equal-title ordering
deterministic. The filtered total is computed before the cursor, stays stable
on every page, and remains available even when a cursor is beyond the last
row.

Filtering and counting run in SQL for access, completed, Blacklist, title
search, progress and any-of genre/tag selection. Progress uses personal minute
evidence: exact zero is not-started, positive minutes are in-progress, and
unknown/family minutes are not guessed into either state. Genre matching is
case-insensitive and accepts target metadata arrays containing strings,
`{label}` objects or the new `{tag, weight}` weighted-tag shape. Search, genres,
limits, access and progress are parameterized or bounded allowlists.

Detail reads preserve nullable minutes, completed/Blacklist state, private
notes, manual progress, last-played time, description, artwork and normalized
genre/weighted-tag objects. An inaccessible catalogue ID and another account's
owned game both return no detail under the established principal.

## PostgreSQL acceptance fixture

`lib/v2/repositories/read.integration.test.ts` creates and always disposes its
own short-path Unix-socket PG17 cluster using
`node_modules/.cache/vaultshuffle-pg17-20260910/bin`. It replays, unchanged:

1. M1 private foundation
2. M2 jobs/quota/publish with the bundled default PGMQ 1.5.1 extension
3. M3 preservation schema
4. M3 legacy-preservation follow-up
5. Blacklist semantics
6. the local M4 manual-session touch migration

The synthetic dataset contains 1,205 catalogue games, 1,005 owned games for
the principal, 116 and 106 family-lender rows with overlap, one other-account
owned/detail row, and an empty tenant. After owned precedence and lender
deduplication there are 1,105 accessible games; the inactive catalogue row
leaves 1,104, and default completed/Blacklist exclusions leave 1,102.

The fixture proves:

- full keyset traversal across repeated titles has no omissions or duplicate
  game IDs, and every page reports the same count;
- default, completed, Blacklist, access, search, genre/tag and progress filter
  counts equal their completely traversed result sets;
- owned/family overlap, multiple lenders, `NULL` versus zero minutes, empty
  tenants and a cursor after the final row retain their distinct meanings;
- full detail state/notes and target weighted tags survive repository mapping;
- the login role has only inherited `vault_app` membership, and forced RLS
  returns neither another account's row nor any account without transaction
  context;
- malicious search/genre strings remain values and cannot change SQL shape.

## Validation

These commands completed successfully:

```sh
node --experimental-strip-types --test \
  lib/v2/repositories/library-core.test.ts \
  lib/v2/repositories/session.integration.test.ts \
  lib/v2/repositories/read.integration.test.ts
npm run typecheck
npm run lint -- --quiet
```

The focused repository run passed 13/13 tests. The real read fixture contributes
8/8 passing tests, including all migrations and more than 1,000 library rows.
The temporary cluster stopped and its directory was removed after the run.

## Material limits

This checkpoint validates the direct PostgreSQL repository boundary only. It
does not claim route, cookie-composition, browser or UI integration. It makes no
remote write, does not apply the M4 manual-session touch migration to a target,
and does not switch the legacy runtime.
