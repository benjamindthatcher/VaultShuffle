# M3 live view-definition review

Updated: 13 September 2026

## Evidence and scope

This is a metadata-only review of the two `public` view definitions captured
with the completed strict-reader export. No source row was read or reproduced.

The owner-only sidecar
`/private/tmp/vaultshuffle-m3-export-20260913/output/20260913T130404Z-130c2ad9.schema-views.json`
is mode `0600`, SHA-256
`59597f47278c8d7ca4722dd46cd991d80fc80f64ecca83354ba1c37391cfa641`.
It declares manifest SHA-256
`b3f9def89106b7e5c4772ee5b3b0449ac16e504da2f8e677e7ee1194837fc3cb`,
the completed manifest's run ID, `current_snapshot`, `snapshot_xmin`, and UTC
transaction-start watermark `2026-09-13T13:04:04.638967Z`. Each matched the
completed manifest. This same-snapshot capture closes the observation portion
of D-VIEW-1 / S-VIEW-DEFS: M4 no longer has to infer the live view bodies from
repository SQL.

It does not close a target design or authorization decision. Views are derived
read models; their rows are not loader inputs. The M3 loader verifies and
accounts for both source relations, then deliberately creates no target batch
from them. See `lib/v2/migration/load/all-domains.ts` (the coverage-only and
rebuild relation sets).

## Captured source semantics

| Source view | Captured definition SHA-256 | What it does | Runtime anchor |
| --- | --- | --- |
| `public.catalog_duration_review_queue` | `df5ccaa8a73e1bfcae4d95031023515c971a3f6032b501f173e188253bb41b0c` | Projects catalogue games for which all three legacy duration-minute fields are null. It left-joins the one legacy duration-review row and exposes its `reviewed_at`; it does **not** exclude reviewed games itself. | `lib/duration-review.ts`: total counts every queue row, remaining and selectable rows apply `reviewed_at IS NULL`, then order unresolved rows by imported-user count, review count and AppID. |
| `public.user_games_with_catalog` | `21d61cf59c0f8e2141a2e2b24d044c58d908e0da81e7c4eefa2da18fd328c7e9` | Inner-joins a per-user game/access row to its catalogue game. It combines lifecycle, progress, notes, recency, review-request and family-access facts with shared metadata. It derives display genre, a ten-point rounded review rating, literal `Steam` store and literal `Medium` priority. It exposes quarantine status only when the related catalogue quarantine has `review_status='excluded'`. | `lib/game-tables.ts` names it as the current read model; `lib/games.ts`, `lib/collections.ts` and `lib/pinned-playtime.ts` read it with an explicit `user_id` filter and exclude quarantined rows. |

The captured library projection still contains the legacy `slept_at` timestamp.
It also exposes `status`, `previous_active_status`, `completion_suggestion_*`,
`access_source`, `family_owner_steam_id` and `family_verified_at`. This is the
live source fact, whereas
`supabase/migrations/20260912192336_replace_sleep_with_blacklist.sql` rebuilds
the repository version without `slept_at` after the Blacklist transition. The
captured definition therefore confirms the repository SQL is not a literal
description of the source view at this export watermark. It is intentional
target-transition SQL, not evidence for reading the view as a migration source.

## M4 parity specification

M4 should rebuild only the product read models required by its finalized target
schema. It must not copy either view, rely on its display constants, or use
view rows as authoritative migration input.

| Read model | Preserve/rebuild from | Required parity rule |
| --- | --- | --- |
| Library-with-catalogue | `app.library_games`, `app.game_state`, `app.game_activity`, `catalog.games`, `catalog.game_metadata`, `catalog.game_features`, plus the authoritative quarantine/review-decision representation | Join only library/access records with a resolved canonical game. Carry status, progress, notes, timestamps, recency, review-request and family-access facts. Recompute presentation-only title/genre/artwork/pricing/platform/reviews/duration fields from catalogue facts. Recompute excluded-quarantine visibility from the authoritative decision. Do not restore `slept_at`; represent Blacklist through the approved target lifecycle/blacklist state. Treat source `rating`, `priority`, `store`, flattened genre and text AppID as retired presentation projections, not independent facts. |
| Duration review queue | `catalog.games`/duration-estimate state and preserved duration review decisions | Define unresolved using the approved target duration-state semantics. Preserve the source review evidence and review instant through `catalog.review_decisions`; a queue row remains visible to historical/admin counting when review evidence exists, while the actionable subset is the rows without a settled review. Keep the existing deterministic ordering only if the M4 product surface retains this queue. |

The source view proves an important access invariant for M4: family availability
is part of the library projection (`access_source`, family owner and verification
instant), while application callers additionally limit product library queries
to `ownership='Owned'`. A rebuilt read model must retain those distinctions;
it must not collapse family access into owned access or copy an owner's
playtime as a family member's fact.

There is no demonstrated source membership or access-control defect from this
capture. The historical access metadata records only `service_role=SELECT` for
the library view, and the current runtime anchors are server-only admin-client
paths with caller-supplied `user_id` predicates. The same-snapshot sidecar
contains definitions only, so it does not prove current owner, grants,
`security_invoker` option or RLS behavior. M4 must review target grants/RLS and
keep browser roles from directly reading another account's library, but that is
a target deployment gate rather than an unresolved source-view semantic.

## M3 disposition

D-VIEW-1 is resolved as an observation: the live definitions above are frozen
at the real export watermark, and the source view facts are accounted for by
their base relations. S-VIEW-DEFS is satisfied by the bound sidecar capture.
The remaining M4 work is to approve and implement the parity rules above with
the final target schema, lifecycle semantics, review-decision policy and target
authorization model.
