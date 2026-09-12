# M3 migration readiness and source-disposition audit

Author: Claude (independent batch) · 9 September 2026 · branch `codex/v2-architecture`

Scope: a read-only readiness audit that prepares an M3 implementation handoff. It
implements nothing, edits no existing file, touches no remote service and makes no
production change. Plan reference: [architecture and execution plan](VaultShuffle_v2_architecture_plan.md)
sections 3, 5, 13, 14, 16, 17. Ledger reference: [execution status](v2-execution-status.md).

## 1. What this audit is allowed to prove

| Evidence class | Source | What it can establish |
|---|---|---|
| Frozen v2 schema | `database/v2/supabase/migrations/*.sql` | Exact target relations, constraints, grants and policies |
| Live source schema metadata | `database/v2/source-schema-inventory-20260909.json` | Live `public` relation/column/constraint inventory at 2026-09-09T00:29:20Z |
| Repository domain code | `lib/**`, `app/**`, `supabase/migrations/**` | Semantics, provenance and derivation rules behind each column |
| Live source **data** | not available here | Nothing. No row counts, distributions, conflicts or violations were read in this audit |

Every aggregate quoted below as "plan section 2" comes from the architecture plan's
read-only baseline of 5 September, not from a query run here. Bare "section N"
references mean a section of this report.

Both frozen migration hashes were independently reverified in this checkout:

```
54fe0a7defd029e91568b78d51393670ac7ca6edcf915919670c7f64c2476389  20260906093036_m1_private_foundation.sql
f09d7ca900f3cdaaee81eff0f507adc5869865f16eb7f340eeb1729223bc5aba  20260907163356_m2_jobs_quota_publish.sql
```

Two independent proofs that the repository is **not** a complete schema source, and
that the live inventory must be the manifest authority:

- The legacy migration chain begins at `supabase/migrations/20260824154247_remove_purge_categories.sql`.
  Base tables are created before it, three import/rate migrations are excluded by
  `.gitignore:79-81`, and the remote-only `backfill_user_game_state` migration is
  recorded in [user_game_state access safeguard](user-game-state-security.md) as absent locally.
- `catalog_user_imports` is written by live-shipped SQL in
  `supabase/migrations/20260829224231_reparent_product_data_to_app_accounts.sql:119`
  but **does not exist in the live inventory**. It was dropped remotely. Any transform
  derived from repository function bodies is therefore unsafe until live routine
  definitions are exported.

## 2. Manifest coverage result

The live `public` schema holds **44 relations: 42 base tables and 2 views**
(`user_games_with_catalog`, `catalog_duration_review_queue`), 486 columns.

Every one of the 42 base tables already has a disposition row in plan section 14.2.
Coverage against the live public schema is **100%**, with two wording fixes needed:

- "seed/import run records" must be pinned to the exact names `catalog_seed_runs`
  and `catalog_duration_import_runs`.
- The two views need an explicit "derived, not migrated" line so a manifest-coverage
  assertion can be written mechanically.

Three section 14.2 rows are now resolved or wrong on the evidence:

1. `priority` and `rating` **no longer exist** on live `user_games`. Its column
   ordinals skip 3, 4, 5, 8, 11, 14, 22-28, 30 and 31. Section 14.2 lists both as
   "requires explicit inspection"; that inspection is complete and the answer is
   retirement. Only `date_added`, `previous_active_status` and `completion_percentage`
   remain open from that sentence. The live view still publishes `rating` and
   `priority` columns, so the view body was rebuilt remotely and differs from
   `supabase/migrations/20260901193000_share_a_family_library.sql:289`.
2. `app_settings` is **per-account data**, not configuration. Live shape is
   `(id, user_id, key, value, created_at, updated_at)` with `UNIQUE (user_id, key)`
   and a CASCADE foreign key to `app_accounts`. Section 14.2 files it with
   `algorithm_weights` under "versioned validated configuration and feature/worker
   budgets". It belongs in `app.account_preferences`, whose section 5.1 contract
   already describes exactly this import ("import browser-local values once with
   explicit conflict precedence").
3. `algorithm_weights` is **hand-tuned operator configuration**, and section 14.2's
   grouping of it with configuration is correct. Its live shape
   `(key, positive, total, note, updated_at)` is the same Beta-style tally as
   `genre_preference_globals` and `game_preference_globals`, and an earlier draft of
   this report wrongly concluded from that shape that it belonged with the learned
   warm-start snapshot. The code says otherwise: `lib/genre-preferences.ts:112`
   describes the table as edited by hand in the Supabase dashboard, and
   `lib/genre-preference-worker.ts:79` describes it as carrying the live values so
   they can be tuned with an update statement rather than a deploy. Preserve and
   version it separately from learned aggregates. Shape alone does not make a table
   learned evidence. Coordinator ruling, 9 September.

## 3. Missing v2 relations

The applied target has 35 private tables: 26 from M1 and 9 from M2. `reco` and
`migration` are **empty schemas**; no relation exists in either. `catalog` holds
only `games`, `game_metadata` and `game_features`.

Five relations named in plan section 5.4 do not exist, so their legacy sources have
nowhere to land:

| Section 5.4 relation | Legacy sources with no destination |
|---|---|
| `catalog.duration_estimates` | `game_duration_estimates` (16 cols), `game_duration_aliases` |
| `catalog.review_decisions` | `catalog_duration_reviews`, `catalog_game_quarantine` (14 cols), `catalog_games.duration_manual_override` |
| `catalog.provider_state` | `catalog_games` tags retry columns 46-52, `catalog_ingest_queue`, `game_duration_jobs` |
| `catalog.offers` | `catalog_games.steam_appid` product mapping |
| `catalog.offer_prices` | `catalog_games.price_currency/price_initial/price_final/discount_percent/is_free` |

Seven further legacy domains have no v2 relation of any kind:

| Legacy | Nature | Required v2 home |
|---|---|---|
| `vault_draws`, `vault_draw_events`, `vault_events` | draw serve/impression/action history | new relations; `app.vault_state.current_draw_ref` is already a dangling `uuid` with no referent |
| `user_genre_preferences`, `genre_preference_globals`, `game_preference_globals`, `algorithm_weights` | recommender warm start | `reco` schema, currently empty |
| `contact_messages`, `feedback_submissions` | support records containing email addresses | private support domain (section 14.2 requires it) |
| `purge_reviews` | historical review decisions incl. `action = 'complete'` | bounded archive or documented retirement |
| `metadata_worker_runs` | worker audit, 14/30-day retention per section 13 | bounded operational archive |
| `catalog_game_sightings`, `catalog_seed_runs`, `catalog_duration_import_runs` | catalogue provenance | bounded archive |
| `api_rate_limits` | app-side abuse counters keyed by `key_hash` | see section 7 below |

Two further structural gaps:

- **No migration role.** `database/v2/supabase/migrations/20260906093036_m1_private_foundation.sql:21`
  creates only `vault_app` and `vault_worker`. Every private table carries
  `force row level security`. Under `vault_app` a bulk load is impossible for
  **13 of the 35 target relations**: the four M1 `ops` tables and all seven M2 `ops`
  tables have **no policy at all**, and the two M2 `app` tables carry a select-only
  policy (M2:3074-3098). The `app.*` tenant policies are granted to `vault_app`;
  the `catalog.*` read policy is granted to `vault_app` and `vault_worker`
  (M1:747, 752, 757) and is select-only, so the catalogue cannot be loaded through
  it either. The load therefore runs as a role with `BYPASSRLS`, or through
  `SECURITY DEFINER` loaders in the `migration` schema, or per account with
  `app.account_id` set for the `app.*` tables. The coordinator has since verified
  that the target owner `postgres` is NOSUPERUSER with `BYPASSRLS` true,
  `CREATEROLE` true and `LOGIN` true, and owns all private tables, so a permanently
  privileged loader role is not automatically required; a tightly bounded
  migration-operator load leaving runtime ACLs unchanged is the preferred shape.
- **No mapping tables.** Section 14.1 requires old-UUID to new-integer maps, run
  metadata, watermark, counts, hashes, conflict report and applied steps. The
  `migration` schema is empty.

## 4. Hard constraint conflicts

These are value-domain conflicts where legacy rows cannot be inserted into the
frozen v2 schema at all. Each needs a new M3 migration or an agreed lossy mapping
recorded in the conflict report. Section 14 records an independent mechanical sweep
that reproduced all of them and adds eight more.

**4.1 Completion event source.** Live check allows
`sweep, sweep_bulk, library, vault, purge, details`. v2
`app.completion_events.source` (M1:411) allows `user, system, migration`. Section
14.2 asks to "preserve ... source event identity"; the current constraint cannot.
Collapsing all six to `'user'` destroys the origin surface that
`lib/completion-events.ts:5` defines and that the completion funnel is measured on.

**4.2 Completion event target.** Live `completion_events.game_id` is **nullable and
has no foreign key**; `steam_appid` is nullable too. v2 requires
`game_id integer not null references catalog.games(id)`. A legacy event whose
library row was deleted and whose `steam_appid` is null is unmigratable. Plan
section 3 requires that user history survive losing ownership.

**4.3 Recency evidence source.** Live `user_games.recency_source` allows
`steam_exact, observed_playtime_change, steam_recent_window`
(`lib/recency.ts:25`). v2 `app.game_activity.evidence_source` (M1:269) allows
`steam_profile, steam_api, user, unknown`. **No legacy value is in the v2 list.**
The two columns also answer different questions: legacy records what kind of
evidence exists, v2 records who reported it. The interval columns are the right
home for the two inferred kinds, and they can represent them, because
`interval_started_at` may be null. Legacy does not store the interval start for
`observed_playtime_change`, so that bound is genuinely unrecoverable and must stay
null rather than be invented.

**4.4 Deck compatibility.** Live `catalog_games.deck_compatibility` is `smallint`,
carrying Steam's four-way categorisation. v2
`catalog.game_features.deck_compatibility` is a three-value text tri-state
`unknown/supported/unsupported`, which cannot distinguish Playable from Verified.
Plan section 2 records 25,263 populated Deck observations, so this is not a rare edge.

**4.5 Duration confidence.** Live `catalog_games.duration_confidence` is **text**
constrained to the three ordinal labels `low, medium, high`;
`game_duration_estimates.match_confidence` is text over `none, low, medium, high`.
v2 `catalog.game_features.duration_confidence` is `numeric(5,4)` bounded 0 to 1.
An ordinal label has no defensible numeric image, and inventing one would fabricate
precision the evidence does not have.

**4.6 Merge audit foreign key.** Live `account_merges.source_account_id` is
deliberately **not** a foreign key. It is created at
`supabase/migrations/20260830151421_secure_manual_profiles.sql:42-50` with
`source_account_id uuid not null unique` and no foreign key, and the merge path
deletes the source account at `:708`. The nearby comment at `:27` states this
rationale for a different table, `manual_profile_security_intents`; the structural
fact here rests on the constraint list and the deletion, not on that comment. v2 `ops.account_merges.source_account_id`
(M1:459) **is** `references app.accounts(id)`, and so is
`ops.account_aliases.source_account_id`. Every legacy `merged_existing` audit row
whose source account is gone will fail that foreign key. Legacy `merge_mode` values
`promoted/merged_existing` also need mapping to v2 `promote/merge`, and v2 requires
a `reason` that legacy does not have.

**4.7 Family member identity.** Live `user_family_members` carries
`display_name` (not null), `avatar_url` and `profile_url`. v2 `app.family_members`
(M1:315) has no destination column for any of them, yet the family shelf shows the
lender. v2 also bounds `candidate_app_ids` to 10,000 entries and 256 KiB and
`candidate_count` to 10,000, while legacy `candidate_appids bigint[]` and
`library_seen integer` are unbounded. v2 additionally enforces at most five members
per account.

**4.8 Family access without a member row.** Live `user_games.family_owner_steam_id`
is plain text with **no foreign key** to `user_family_members`. v2
`app.family_game_access` (M1:331) requires a composite foreign key to
`app.family_members(account_id, id)`. Any of the 1,262 family rows whose lender row
has since been removed cannot be represented as family access.

**4.9 Collection ordering.** Live `collection_games` has
`PRIMARY KEY (collection_id, game_id)` and `CHECK (position >= 0)` but **no
uniqueness on position**. v2 adds `unique (account_id, collection_id, position)`
(M1:368). Duplicate or gapped positions need a deterministic renumbering whose
remap is recorded, not a silent reorder. Plan section 3 makes collection ordering an
acceptance requirement.

**4.10 Snooze ordering.** v2 `app.snoozes` adds `check (until_at is null or until_at >= snoozed_at)`.
Live `user_game_snoozes` has no such check, so a snooze whose `snoozed_until`
precedes `snoozed_at` is representable in the source and rejected by the target.

**4.11 Empty-string notes.** Live `user_games.notes` is `text NOT NULL`. v2
`app.game_state.notes` requires `length(btrim(notes)) between 1 and 10000`. Empty
and whitespace-only notes must become `NULL`, and the row must then be suppressed
entirely unless another state field is set, because `app.game_state` carries a
check requiring at least one meaningful field. Plan section 2 records zero nonempty
notes today, so this is currently a suppression rule rather than a data risk, but
the feature is retained and the rule must exist.

**4.12 Catalogue columns with no target.** Beyond the price and duration relations
above, `catalog_games` loses `developer`, `publisher`, `release_date`,
`is_free`, `main_extras_minutes`, `platform_windows`, `platform_mac`,
`popularity_source/metric/low/high/ccu`, `first_seen_reason`, `source_captured_at`,
`deck_checked_at`, and the `review_positive/review_negative/review_total` counts,
which collapse to a single `review_score numeric(5,2)`. The counts are not
cosmetic: the live read model derives the displayed rating from
`review_positive * 10.0 / review_total`. `catalog.games` has no release-date
column despite section 5.4 promising "lifecycle/release metadata".

**4.13 Catalogue type is forced, so misclassification will be inherited.** Live
`catalog_games` carries `CHECK (steam_type = 'game')`. Every row in the shared
catalogue therefore claims to be a game, including the DLC and demo entries known
to be stored there. v2 `catalog.games.game_type` can express
`game, dlc, demo, software, video, unknown`, but the source cannot distinguish
them, so a faithful migration inherits the misclassification wholesale. This needs
a stated decision: import everything as `game` and reclassify later behind
`catalog.review_decisions`, or reclassify during the transform from an independent
signal. Silently importing as `game` without recording the decision is the failure
mode to avoid.

Confirmed non-risk in the same area: live `catalog_games` also carries
`CHECK (price_currency IS NULL OR price_currency = 'USD')`, so the section 5.4
requirement that current prices migrate as US observations, never as inferred GB or
EU prices, is structurally guaranteed by the source.

## 5. The stale `user_game_state` authority hazard

This is the highest-consequence correctness risk in M3 and the live shape makes it
worse than the plan assumed.

- Live shape is `PRIMARY KEY (user_id, appid)` with
  `FOREIGN KEY (user_id, appid) REFERENCES user_games(user_id, catalog_steam_appid) ON DELETE CASCADE`.
  It is a **child of `user_games` on the exact join key a transform would naturally
  use**. A left join is one keystroke away and there is no structural signal that
  the child is stale.
- It duplicates `completed_at`, `slept_at`, `dismissed_at`, `dismissed_playtime`,
  `review_requested_at`, `last_played_at`, `last_observed_played_at`,
  `recency_evidence_at`, `family_owner_steam_id` and `family_verified_at`, and
  encodes `prev_active_status` and `recency_source` as **smallint codes** where
  `user_games` uses text. A coalescing transform would silently prefer whichever
  side it read first.
- Plan section 2 records that the staging table **contains** 24,428 rows and that it
  differs from current `user_games` in completion state and hundreds of activity
  observations. 24,428 is the total staging row count, not the count of differing
  rows; how many actually differ is unmeasured and is a section 10 probe.
  [user_game_state access safeguard](user-game-state-security.md) confirms the app
  never reads it, and that existing owner and service-role permissions were
  preserved when RLS was enabled. That note does not establish the exact
  service-role grant on this table, but service-role is the credential an exporter
  is most likely to be handed, so the controls below stand regardless.

Required controls for the M3 exporter and transform:

1. `user_game_state` is exported to a **quarantined** staging relation whose name
   cannot be confused with state (for example `migration.legacy_user_game_state_audit`),
   never into any relation feeding `app.game_state` or `app.game_activity`.
2. The transform contains **no join** from `user_game_state` to any target relation.
   This is asserted statically in review and dynamically by a test that fails if the
   staging relation is referenced outside the reconciliation report.
3. A reconciliation report counts, per account, rows where the staging copy asserts
   a completion or sleep that `user_games` does not. Those counts are published in
   the conflict report; none of them changes a migrated value.
4. The smallint code books for `prev_active_status` (1, 2) and `recency_source`
   (1, 2, 3) are **not** inferred from ordering. They must be read from live routine
   or comment definitions, or the column is discarded as uninterpretable.

## 6. Deterministic, restartable identity mappings

Four maps are needed. All are content-addressed, insert-only and safe to re-run.

**6.1 Account map.** `app_accounts.id (uuid) -> app.accounts.id (integer)`.
`app_users.id` and `manual_steam_profiles.id` are **the same UUID** as
`app_accounts.id` (`supabase/migrations/20260829224140_add_manual_steam_profiles.sql:66`
and `:128`), so one map serves identity, profile and session parenting. New
`public_id` retains the old UUID, as section 14.1 requires. Determinism comes from
ordering `app_accounts` by `(created_at, id)` and assigning identities in that
order; restart re-reads the map rather than re-assigning.

**6.2 Game map.** `steam_appid (bigint) -> catalog.games.id (integer)`. Sourced from
`catalog_games`, ordered by `steam_appid`. `user_games.catalog_steam_appid` has a
`RESTRICT` foreign key to `catalog_games`, so every library row resolves. Draw rows
also reference `catalog_games` directly.

**6.3 Library-row map.** `user_games.id (uuid) -> (account_id, game_id)`. This is the
highest-fanout map and the one section 14.1 already names. It is **mandatory**
because seven legacy relations address a game by the per-user library UUID rather
than by catalogue identity: `collection_games.game_id`, `user_game_pins.game_id`,
`user_game_snoozes.game_id`, `user_vault_state.current_game_id`,
`vault_events.game_id` and `purge_reviews.game_id`, all six with real foreign keys
to `user_games(id)`, plus the nullable `completion_events.game_id`, which carries no
foreign key at all. Anchors: `lib/vault-state.ts:27`, `:32`, `:37`;
`lib/collections.ts:38`.

**6.4 Public-identity retention.** Collection UUIDs are retained as
`app.collections.public_id`. Draw UUIDs should be retained the same way so
`app.vault_state.current_draw_ref` resolves once a draw relation exists. Family
member public IDs are new; legacy `user_family_members.id` is not currently exposed
to the browser, so retention there is optional and should be decided explicitly.

Sequence hygiene: every identity sequence is set above its imported maximum, and the
map tables carry a unique constraint on both sides so a partial re-run cannot
produce two integers for one UUID.

## 7. Operational and quota carry-over

`api_rate_limits` is an **app-side abuse counter**, not a provider budget: fixed
windows keyed by `(bucket, key_hash)` where `key_hash` is a 64-hex digest derived
from a session or client key. v2 replaced this with real token buckets and daily
provider quotas (`ops.provider_token_buckets`, `ops.provider_quota_daily`). The two
algorithms are not convertible. An earlier draft of this report recommended starting
v2 buckets empty and accepting that abuse limits reset at the cutover instant. The
coordinator has **not approved** that unqualified deviation: application abuse
control and keyed provider budgets are separate systems, and outstanding cooldown
obligations must be preserved rather than dropped. The M3 batch proposes
conservative handling carried into M6 and M7, in which an unexpired legacy cooldown
continues to bind after cutover. `key_hash` values are session-derived and must
never leave the private export.

`steam_import_jobs` stores the entire owned-games payload in `games jsonb` with
`PRIMARY KEY (user_id)` and a `processing_token`/`processing_started_at` lease.
Section 13 deletes successful import payloads after commit, so the payload column is
never migrated. In-flight rows at freeze time (`status = 'importing'`) become an
operator report, not resumed work, per section 14.2.

The ledger's standing warning applies here and is unchanged: new v2 counters cannot
observe unchanged production v1 calls sharing a provider credential, so global budget
integration across all consumers remains a cutover prerequisite.

## 8. Canonicalization rules

**8.1 Null versus zero, and one authored write path.** On the import path
`user_games.hours_played numeric(10,1) NOT NULL` is a **derived, rounded** value:
`lib/steam-owned-games.ts:32` computes `Math.round(((minutes ?? 0) / 60) * 10) / 10`.
`observed_playtime_minutes integer` is nullable and is the exact measurement, so
`app.library_games.playtime_minutes` is sourced from `observed_playtime_minutes`.
A null stays null, and `hours_played = 0` must never become an observed zero, which
is the distinction section 5.2 draws. The 1,262 family rows are the population where
the two disagree.

That rule cannot be absolute, and an earlier draft of this report wrongly made it so.
`hours_played` is also **client-authored**: `lib/validation.ts:26` and `:38` accept it
on both write verbs, `app/api/games/[id]/route.ts:14` and `:26` parse them, and
`lib/games.ts:117` writes the value through. Meanwhile `observed_playtime_minutes`
has **no writer in `lib/` or `app/` at all**; it appears only as a type at
`lib/types.ts:37` and is set solely by server-side SQL in the import and refresh
routines, for example
`supabase/migrations/20260831175217_add_steam_playtime_refresh.sql:245` and `:282`.
So an edited `hours_played` never reaches `observed_playtime_minutes`, and sourcing
minutes only from the latter would silently discard exactly the authored fact that
plan section 14.2 says to preserve. Plan section 2's count of 1,262 rows missing
exact minutes, all family rows, suggests the affected population may be zero, but a
count is not a proof. Section 10 must probe for rows whose `hours_played` cannot be
reproduced from `observed_playtime_minutes`, and the disposition must be decided on
that measurement rather than assumed.

**8.2 Numeric narrowing.** Three conversions change type and must have a stated
rounding rule, applied identically in the transform and the validator:
`user_game_pins.hours_at_pin double precision` to
`app.pins.personal_minutes_baseline integer` (a **unit change**, hours to minutes);
`user_games.completion_suggestion_dismissed_playtime numeric` to
`app.game_state.completion_dismissed_playtime integer`;
`completion_events.hours_played double precision` if any home is agreed.

**8.3 Boolean to tri-state.** `app_accounts.steam_library_visible`,
`steam_playtime_visible` and `steam_last_played_visible` are nullable booleans.
An earlier draft of this report guarded only NULL, saying it maps to `unknown` and
never to `hidden`. That guard is necessary but **incomplete**, and the coordinator
ruling of 9 September corrects it: a legacy **false** flag means no positive hours
or no reported last-played value, **not** explicit provider privacy. So `true` may
project `visible`, while both `false` and NULL project `unknown` unless independent
privacy evidence exists. Treating `false` as `hidden` would manufacture a privacy
assertion the source never made. Preserve the raw tuple and its provenance rather
than only the projection. Section 5.1 states the underlying requirement and the M2
review closed the same class of bug for private snapshots.

Visibility also has a **precedence** problem the audit did not anticipate. The same
three capability facts exist on both `app_accounts` and `app_users`, and a dated
aggregate found 183 accounts whose account-side and profile-side triples disagree,
with 271 differing checked-at times. Precedence is resolved from the actual writer
and reader paths rather than by picking the newer row, and conflicting source
evidence is preserved until the real snapshot rechecks it.

**8.4 Derived state must not become authored state.**
`completion_percentage integer NOT NULL` is written at import by
`inferredCompletionForPayload` (`lib/game-classification.ts:174`) and re-derived on
read by `gameProgress` (`:161`). There is no provenance flag. Recommended primary
rule: **do not populate `app.game_state.manual_progress` from it at all**, and
retain the whole column in `migration` staging as evidence so a later provenance
decision is still possible. This satisfies section 5.2 without asserting authorship
the data cannot support.

Confirmed non-gap: `status` is also derived. `Sampled` is computed from progress
(`lib/game-classification.ts:156`) and is rendered as In Progress
(`lib/app-view-model.ts:140`). v2's decision to keep only `previous_active_status`
therefore loses nothing for the active sub-states. This is a finding about `status`,
which is not one of plan section 14.2's five named open fields; it does not close
any of them, and `previous_active_status` remains open.

**8.5 Time.** Every timestamp column in the live inventory is
`timestamp with time zone`; the inventory reports `timezone: UTC`. The ledger's
7 September finding stands and no geographic offset is applied to stored instants.
The remaining time risks are the non-`timestamptz` surfaces, which must be checked
separately:

- **`user_games.date_added` is `text`, not a date, and it is locale-formatted.**
  `lib/steam-owned-games.ts:19` produces it with
  `new Date().toLocaleDateString("en-GB")`, giving `DD/MM/YYYY`.
  `lib/validation.ts:29` accepts any trimmed string up to 64 characters, so other
  formats may exist. Parsing `03/09/2026` with a default JavaScript or US locale
  parser yields **March 9**, not 3 September. The column has no v2 destination, so
  the safe disposition is retention as opaque text in `migration` staging with **no
  date parsing at all**, and a documented retirement.
- `date` columns: `user_playtime_snapshots.captured_on`,
  `catalog_games.release_date`, `catalog_games.source_captured_at`,
  `catalog_seed_runs.captured_at`. Each is a civil date with no zone. They copy
  across unchanged and must never be routed through a timestamp conversion.
- Epoch integers: Steam's `rtime_last_played` is already converted at the boundary
  (`lib/steam-owned-games.ts:126`) and stored as `timestamptz`, so no epoch value is
  at rest in the source. The v2 side already rejects a known last-played epoch of
  zero, per the M2 review.
- JSON carrying timestamps must be treated as opaque text and hashed as text, never
  re-serialised: `steam_import_jobs.games`, `metadata_worker_runs.counts/summary`,
  `catalog_ingest_queue.source_payload`, `game_duration_estimates.evidence`,
  `catalog_duration_import_runs.manifest`, `feedback_submissions.client_context`,
  `vault_events.context`, `catalog_games.tags`, `collections.rules`. The M2 review
  already established that `JSONB::text` differs from TypeScript canonical JSON;
  the same rule governs M3 checksums.
- Display conversion is a separate surface: `lib/playtime-summary.ts:36` builds day
  keys with `setUTCDate` and `toISOString().slice(0, 10)`, so the product already
  reasons in UTC days. Parity checks must use the same key derivation.

**8.6 Daily playtime is cumulative, not a daily gain.** This is a silent-corruption
risk with no constraint to catch it. `user_playtime_snapshots.total_minutes bigint`
is a **running library total**; the per-day gain is derived by differencing
consecutive snapshots at `lib/playtime-summary.ts:32`. v2
`app.playtime_daily.observed_minutes` carries no marker for which semantic it holds.
Copying the column verbatim is lossless and preserves derivability; converting to
gains destroys the first day and the totals irreversibly. Recommendation: copy
cumulative totals unchanged, state the invariant in the M3 contract, and add an
explicit semantic marker in the M3 migration. Legacy has no per-day coverage
evidence, so every migrated row takes `coverage = 'unknown'`. `games_with_playtime`
has no destination in the frozen schema and, per the coordinator ruling of
9 September, is **preserved**: the M3 contract must give it a column rather than
retire it.

**8.7 Session digests.** `hashToken` (`lib/auth.ts:46`) is
`HMAC-SHA256(SESSION_SECRET, token).digest("hex")`, so digests are 64-character hex
decoding to the 32 bytes v2 requires. `manual_profile_sessions.token_hash` carries
`CHECK (token_hash ~ '^[0-9a-f]{64}$')`. **`sessions.token_hash` has no such check**
and only a `UNIQUE` constraint, so malformed or uppercase digests are possible there
and only there. v2 has one global unique digest across both kinds, where legacy has
two independent unique constraints, so a cross-table collision is possible in
principle. Both are private reconciliations: counts only, never values.
Session identifiers are renumbered to bigint, which is safe because the cookie
carries the token and no external artefact references a session UUID; the one
internal reference, `manual_profile_security_intents.source_manual_session_id`, is
expired at the freeze rather than migrated.

## 9. Exporter and validator design

**Snapshot discipline.** One `REPEATABLE READ READ ONLY` transaction on a
direct or session connection is the only acceptable source of final and rehearsal
data. Paginated HTTP reads are explicitly not a snapshot: each page is its own
transaction, production keeps writing, and the result can contain a collection whose
membership rows were exported before the parent and a library row exported after its
deletion. The exporter therefore:

1. Opens one read-only repeatable-read transaction and records
   `pg_snapshot_xmin(pg_current_snapshot())`, `pg_current_wal_lsn()` and the exact
   statement start as the run watermark.
2. Streams every manifest relation through `COPY ... TO STDOUT` inside that one
   transaction, in a fixed manifest order, writing each relation to its own file
   with a SHA-256 computed on the wire.
3. Emits a run manifest: source snapshot, target revision, code commit, transform
   version, per-relation row count and digest, and timings, as section 14.3 requires.
4. Writes to a private directory with restricted permissions. Paths are excluded by
   the existing `.gitignore` rules for `data/private/`, `data/exports/`, `*.csv`
   and `*.dump`. Nothing containing rows, digests or emails is printed to a terminal
   or a tool transcript.
5. Never issues a write. The connection is read-only at the transaction level, and
   the run asserts that before starting.

**Restartability.** Restart discards the partial export and takes a new snapshot;
a resumed export across two snapshots is not a snapshot. The *load* side is the
restartable half, keyed by the mapping tables and an applied-steps ledger.

**Validator.** Independent of the transform, reading only the exported files and the
target, and computing transformed source checksums itself rather than trusting the
transform's output. Under one canonicalization: NULL distinct from empty string and
from zero; numerics rendered at fixed scale with a stated rounding mode; instants as
UTC ISO-8601 with a fixed sub-second precision; dates as `YYYY-MM-DD` with no zone;
JSON hashed as the exact source text. Per section 14.3 the comparison is per account
and per sorted set, not a global count: sorted personal and family AppID sets, exact
known minutes plus unknown count, retired facts, completion, sleep, undo and
dismissal state, notes, activity source and intervals, collection membership,
position and note hashes, exact pins, scopes, slots and baselines, snoozes, current
pick, daily trend and completion history. Every exception is reported and requires a
documented resolution before promotion.

## 10. Live evidence this audit could not obtain

Each item below is a specific probe for the M3 batch to run read-only against the
source. None is answerable from the repository.

1. **The two-account discrepancy.** Plan section 2 records 198 manual accounts and 196
   `manual_steam_profiles` rows. Promotion cannot explain it: promotion sets
   `account_type = 'steam'` and then deletes the profile
   (`supabase/migrations/20260830151421_secure_manual_profiles.sql:345` and `:373`).
   Probe: manual accounts with no profile row, with their created-at, child-row
   counts and session counts. The disposition depends on whether they own data.
2. **Non-`public` schemas.** The inventory covers `public` only. The live database
   also has `auth`, `cron`, `extensions`, `graphql`, `graphql_public`, `net`,
   `realtime`, `storage`, `supabase_migrations` and `vault`. Required before the
   freeze: `supabase_migrations.schema_migrations` as the section 14.1 audit ledger;
   `cron.job` for every schedule that section 15 step 2 must fence; `net` for
   in-flight outbound requests; `storage.buckets` to decide whether an object-storage
   recovery plan is needed at all; confirmation that `auth.users` is empty, since
   VaultShuffle uses custom sessions. `vault.secrets` is explicitly **excluded** from
   every export.
3. **Existing CLI authentication.** Whether the installed Supabase CLI offers a
   proven single-snapshot stream rather than Management API querying, and whether an
   existing authenticated CLI path reaches the source without mutating a source role.
   A coordinator catalog query found `cli_login_postgres` already present on the
   source, LOGIN true, not superuser, not bypass-RLS, with validity expired on
   3 September 2026. That is evidence for investigation and **not** authorization to
   refresh, provision or otherwise mutate it. The recorded CLI version is stale and
   the current `db query --linked` help says it queries through the Management API,
   which is not snapshot proof.
4. **Live routine definitions.** `catalog_user_imports` proves repository function
   bodies can be stale. Export live function, trigger, view and grant definitions
   before writing any transform that mirrors legacy logic.
**Measured on 9 September**, as dated aggregates rather than snapshot parity:
items 5 and 6 below are answered, and most of item 7's conflict classes measured
zero. The source keeps moving, so each must be rechecked inside the real snapshot.

5. **Authored playtime. Answered: zero divergent rows.** Count rows whose
   `hours_played` cannot be reproduced from
   `observed_playtime_minutes` by the import rounding in `lib/steam-owned-games.ts:32`,
   split by `access_source`. This decides whether the client write path in section 8.1
   ever produced a divergent authored value, and therefore whether minutes may be
   sourced from `observed_playtime_minutes` alone.
6. **Staging divergence. Answered: divergence exists and is measured.** The staging
   table holds 24,428 rows with measured completion and recency discrepancies against
   `user_games`. The controls in section 5 stand unchanged: this is reconciliation
   evidence and never transform authority.
7. **Constraint-violation probes**, all count-only: collections with duplicate or
   gapped positions; snoozes with `snoozed_until < snoozed_at`; accounts with more
   than five family members; `user_family_members` with `library_seen > 10000` or
   `cardinality(candidate_appids) > 10000`; `user_games` family rows whose
   `family_owner_steam_id` has no matching member; `completion_events` with both
   `game_id` and `steam_appid` null, and the distribution of `source`; `user_games`
   rows where `status` is Completed or Slept but the matching timestamp is null;
   `sessions.token_hash` values failing `^[0-9a-f]{64}$`; digest collisions across
   the two session tables; display names failing v2's `btrim` length checks;
   and the size of the misclassified non-game population described in section 4.13.
8. **`user_game_state` code books.** The smallint meanings for
   `prev_active_status` and `recency_source`, from live definitions.
9. **Byte accounting.** Section 16's M3 gate requires measured bytes per user, which
   needs a real load into the target.

Two items that were open in the first draft are now **resolved** and need no probe.
The target's migration owner `postgres` is verified NOSUPERUSER with `BYPASSRLS`
true, `CREATEROLE` true and `LOGIN` true, owning all private tables, so the loader
design no longer hangs on that question. And the source export path is answered in
section 15.

## 11. Proposed ownership split for the next batch

Non-overlapping paths, so subagents can work autonomously without conflicting edits.

| Owner | Paths | Deliverable |
|---|---|---|
| Schema owner | `database/v2/supabase/migrations/2026xxxx_m3_*.sql`, `database/v2/M3-contract.md` | New migration: the five missing `catalog` relations, the `reco` warm-start snapshot, draw history, support and operational archives, `migration` mapping and conflict tables, the loader role or `SECURITY DEFINER` loaders, and the section 4 constraint corrections |
| Exporter owner | `lib/v2/migration/export/**`, `docs/v2-export-contract.md` | Repeatable-read snapshot exporter, run manifest, per-relation digests, private output handling, no-write assertion |
| Transform owner | `lib/v2/migration/transform/**` | Deterministic restartable mapping and per-account transform, canonicalization module shared with the validator |
| Validator owner | `lib/v2/migration/validate/**` | Independent checksum and per-account parity validator, conflict and exception report |
| Coordinator | plan, ledger, review, remote apply | Cross-domain decisions and the M3 gate |

Existing frozen paths stay untouched: `database/v2/supabase/migrations/20260906093036_*.sql`,
`20260907163356_*.sql`, and all pre-existing dirty user files listed in the ledger.

## 12. Acceptance criteria for the next M3 batch

1. A new M3 migration replays on a clean PostgreSQL 17 database after M1 and M2,
   changes neither frozen file, and creates every relation listed in section 3.
2. Every section 4 conflict is either resolved by that migration or recorded as an
   agreed lossy mapping with its rationale and its count in the conflict report.
3. The manifest asserts 100% coverage of live `public` base tables and columns
   mechanically, from the inventory file, and fails on any unlisted relation or
   column. Non-`public` schemas have an explicit assessed disposition.
4. The exporter proves single-snapshot semantics: the run manifest carries the
   snapshot watermark, and a test demonstrates that concurrent source writes during
   an export do not appear in it.
5. Mapping tables are unique on both sides, and a deliberately interrupted load
   resumed from the ledger produces byte-identical target content to an
   uninterrupted load.
6. The validator is written against the exported files and the target only, computes
   its own transformed source checksums, and reports per account rather than
   globally.
7. `user_game_state` appears in exactly one place: a quarantined audit relation and
   its reconciliation report. A test fails if any transform references it.
8. The validator asserts that the count of verified Steam profiles in the target
   equals the live `app_users` count. `app.steam_profiles.verified` defaults to
   false, so this failure mode is silent and needs its own gate.
9. No source write occurs. No secret, session digest, email address or user row
   appears in any repository file, log or tool transcript.
10. Rehearsal is run against **real exported data**. Section 16's rule stands: M3 is
    never marked complete for synthetic fixtures.
11. Measured bytes per user and load timings are recorded from the real rehearsal.

## 13. Confidence

Dated aggregate observations of 9 September have since measured several of the
conflicts below. They are evidence, not parity proof: the source is live and
account count has already drifted from 630 at the plan baseline to 684, so only the
real snapshot can close a gate. Measured **zero**: orphan lender links, over-cap
families (maximum four), decoded digest collisions across both session tables,
unresolved completion identities, invalid session hex or expiry ordering, and
required merge tombstones. Measured **non-zero**: exactly one collection with
duplicate positions, two manual accounts missing profiles, and 183 accounts with
disagreeing visibility triples. Section 8.1's authored-hours concern measured zero
divergent rows across all 365,610 owned library rows, so the write path is real but
the affected population is currently empty.

| Finding | Confidence | Basis |
|---|---|---|
| Missing v2 relations, empty `reco` and `migration` | High | Direct read of both frozen migrations |
| Section 4 constraint conflicts | High | Live constraint definitions against frozen v2 checks |
| Manifest covers all 42 live base tables | High | Mechanical comparison against the inventory |
| `hours_played` derived; minutes authoritative | High | `lib/steam-owned-games.ts:32` and live nullability |
| Daily snapshots are cumulative | High | `lib/playtime-summary.ts:32` |
| `date_added` is locale-formatted text | High | `lib/steam-owned-games.ts:19` |
| `completion_percentage` derived at import | High | `lib/game-classification.ts:174` |
| `Sampled` is derived, so v2 loses nothing | High | `lib/game-classification.ts:156` |
| `app_settings` is per-account, not config | High | Live FK and `UNIQUE (user_id, key)` |
| `catalog_user_imports` dropped remotely | High | Present in shipped SQL, absent from the live inventory |
| Silent de-verification risk on `verified` default | High | M1:110 default and the absence of any legacy verification column |
| No snapshot-consistent backup path exists on this plan | High | Read-only dashboard inspection, section 15 |
| Client-authored `hours_played` write path exists | High | `lib/games.ts:117` reached from both write verbs |
| Whether any authored `hours_played` actually diverges | Measured zero, dated | 365,610 owned rows, none disagreeing, 9 September aggregate |
| `false` visibility means no data, not privacy | High | Coordinator ruling from the writer and reader paths |
| Independent sweep totals (59/23/28/48) | Medium | Mechanical and reproducible, but two result groups needed correction; see section 14 |
| Target owner has `BYPASSRLS` | High | Verified by the coordinator against the target, 9 September |
| Which constraints real data actually violates | None | No source data was read; every section 10 probe is outstanding |

## 14. Mechanical constraint sweep

An independent read-only sweep of both frozen migrations against the live inventory
produced 158 classified rows. Counts:

| Class | Meaning | Rows |
|---|---:|---:|
| A | Legacy value domain cannot satisfy a v2 constraint | 59 |
| B | Fits but loses information | 23 |
| C | v2 key, FK or cap that legacy does not guarantee | 28 |
| D | v2 requires a value legacy simply does not have | 48 |

The sweep independently reproduced every section 4 conflict and the cumulative
daily-playtime narrowing in section 8.6. Eight further items are material enough to
carry into the M3 batch:

1. **`app.steam_profiles.verified boolean not null default false` (M1:110).**
   Verification is inferable only from which legacy table the profile came from.
   A missed mapping does not fail; it silently **de-verifies every Steam account**,
   which is the single most damaging default in the target schema. Plan section 3
   makes verified identity the only unique Steam claim, so this needs an explicit
   assertion in the validator, not just in the transform.
2. **`app.game_state`'s disjunction check (M1:254-259)** rejects any state row whose
   only non-null fields are recency or family evidence. Those facts belong in
   `app.game_activity` and `app.family_game_access`. A transform that routes all of
   `user_game_state` into `app.game_state` fails on exactly the rows it should not
   have been reading at all.
3. **One account could hold both an `app_users` and a `manual_steam_profiles` row.**
   Nothing in the live schema forbids it, but `app.steam_profiles.account_id` is the
   primary key (M1:108), so v2 permits only one profile per account. This is a
   plausible explanation for the two-account discrepancy and should be probed
   alongside it.
4. **`catalog_game_quarantine.steam_type` is unvalidated text**, unlike
   `catalog_games.steam_type` which is forced to `'game'`. Quarantine rows can
   therefore carry type strings outside v2's `game_type` domain. This is the one
   place the source retains real type information, which makes it the natural input
   to the section 4.13 reclassification decision.
5. **`app.library_sync_state.in_flight_job_id` (M2:295-298)** has a composite foreign
   key to `ops.jobs(account_id, id)`. Legacy `steam_import_jobs.processing_token` is
   a lease token, not a job identity, so carrying it across produces a dangling
   reference. It must be left null.
6. **`app.completion_events` requires `undone_at >= occurred_at` (M1:413)** and
   `app.snoozes` requires `until_at >= snoozed_at` (M1:393). Neither ordering is
   enforced in the source.
7. **The five-member family cap is a trigger** (`family_member_limit`, M1:538 and
   M1:546-548), not a table constraint. It fires per row during the load, so an
   over-cap account fails mid-transaction rather than at validation time.
8. **`ops.auth_intents` is blocked by its session foreign key, not by its value
   domains.** An earlier draft of this report argued that legacy intents satisfy
   neither branch of the v2 kind check and that the nonce is neither unique nor 32
   bytes. Both are wrong. `manual_profile_security_intents.source_account_id` and
   `source_manual_session_id` are **both NOT NULL**, which is exactly what the
   promotion branch requires (M1:437-440). And the identifying digest is
   `token_hash`, which carries `CHECK (token_hash ~ '^[0-9a-f]{64}$')` and a UNIQUE
   constraint, so it decodes to precisely the 32 bytes M1:426 wants;
   `openid_response_nonce` is a different, nullable column written after the
   callback. The real obstacle is the composite foreign key at M1:433-434 to
   `app.sessions(account_id, id)`, against section 8.7's decision to expire manual
   sessions rather than migrate them: an intent cannot reference a session that will
   not exist. Section 14.2's "expire pending intents and restart the flow" survives;
   the argument for it does not.

Two sweep results are corrected rather than adopted:

- The sweep reports that legacy promotions record a distinct source and target and
  so violate v2's promote branch. They do not. The promotion path inserts
  `(source_id, source_id)` at
  `supabase/migrations/20260830151421_secure_manual_profiles.sql:352-362`, which
  satisfies `mode = 'promote' and source_account_id = target_account_id`. The real
  conflict is the one in section 4.6: `merged_existing` rows have a distinct source
  whose account row was deleted at `:708`, so the v2 foreign key fails.
- Roughly twenty class-A rows treat `ops.jobs`, `ops.enrichment_outbox` and the
  provider quota and token-bucket tables as migration destinations for
  `steam_import_jobs`, `game_duration_jobs`, `catalog_ingest_queue` and
  `api_rate_limits`. Under section 14.2 they are not destinations: in-flight work is
  not resumed, payloads are not migrated, and due work is rebuilt. Those rows are
  therefore design confirmations, not migration conflicts. The genuine decisions in
  that area are the two already recorded in section 7.

## 15. Source access path

Established 9 September by read-only inspection of the signed-in Supabase dashboard
for the Ireland production project. No credential was read, revealed, copied or
stored, and no control that changes state was used.

**There is no snapshot-consistent backup or restore path on this plan.** Scheduled
backups, point-in-time recovery and restore-to-new-project are all upgrade offers
rather than capabilities here, and no downloadable dump feature exists. That settles
the design question section 9 left open: a client-side logical dump over a direct or
session connection, inside one repeatable-read transaction, is not merely the
preferred route but the only one available.

| Fact | Value |
|---|---|
| Region | `eu-west-1`, shown as West EU (Ireland) |
| PostgreSQL | 17.6.1.127, major 17, release channel GA, status healthy |
| Plan / compute | Free, Nano |
| Direct connection | `db.<project-ref>.supabase.co` port 5432, database and user `postgres` |
| Session pooler | `aws-0-eu-west-1.pooler.supabase.com` port 5432 |
| Transaction pooler | `aws-0-eu-west-1.pooler.supabase.com` port 6543 |

The direct endpoint is IPv6-only, because the dedicated IPv4 add-on is disabled. The
session pooler is the documented IPv4 fallback. Direct and session mode are the
approved choices for the snapshot; the transaction pooler at port 6543 is not.
That is a workflow decision rather than an impossibility claim: a pooled backend is
retained for an open transaction, so transaction pooling does not by itself prevent
a long repeatable-read transaction. What it does not reliably give is session state
across statements, which a dump client depends on. The exporter should attempt
direct and fall back rather than assume, because reachability was deliberately not
tested: no connection, lookup or authentication attempt was made against production.

Two findings beyond the assignment that the coordinator should see:

- **Enforce SSL on incoming connections is OFF.** A non-TLS connection to production
  would currently succeed silently. TLS is entirely the client's responsibility,
  which sharpens the existing rule that the temporary client at `/tmp/vaultshuffle-pg17`,
  built without OpenSSL, must never be pointed at production.
- **No network restrictions and no IP bans** are configured. Nothing needs unwinding
  before an export, and equally nothing currently limits who can reach the database.

Two prerequisites remain outside this work. The database password is not retrievable
by anyone, including the account owner, so the user must supply it themselves; the
access note records the exact steps and file permissions, preferring `~/.pgpass` at
mode 0600 so the secret stays out of process arguments. And a TLS-capable
PostgreSQL 17 or later client must be obtained under a separate temporary prefix.

Recorded as data, not acted on: the dashboard's Connect dialog offers to install
third-party agent skills and to copy a packaged agent prompt. Neither was used.
Installing third-party agent instructions is a configuration change and outside this
remit.

One caveat from the access inspection has since been **resolved against the official
source**. `pg_dump` does wrap its run in a single transaction, but its default mode
is `REPEATABLE READ, READ ONLY`. The deferrable form,
`SERIALIZABLE, READ ONLY, DEFERRABLE`, applies only with the optional
`--serializable-deferrable` flag. Verified at
`/tmp/postgresql-17.6/src/bin/pg_dump/pg_dump.c:1346-1352`. The exporter targets the
default mode, which is what section 9 specifies.

The project CA certificate is public connection material, not a secret, so obtaining
it needs no credential handling. And the dashboard's password-reset warning means
currently-open connections and anything holding the old password; it is not evidence
that every authentication path requires a reset. Whether an existing authenticated
CLI path can reach the source without mutating a source role is a separate open
question, recorded in section 10.
