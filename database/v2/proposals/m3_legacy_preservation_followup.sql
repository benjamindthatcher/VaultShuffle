-- PROPOSAL, not applied to any target. 11 September 2026.
--
-- SUPERSEDED AS THE LIVE ARTEFACT: this reviewed proposal was promoted, with
-- its DDL unchanged, to the prepared migration
-- `database/v2/supabase/migrations/20260911234500_m3_legacy_preservation_followup.sql`
-- (SHA256 beecb95c25e87f1b239f11f16e807338ec496df19ac27deffa5fb49b0bda5f59),
-- which is the file root reviews and decides the apply gate on. That migration
-- is likewise NOT applied anywhere. This copy is kept only as the review
-- history; edit the migration, not this file.
--
-- Root's preservation follow-up (docs/v2-m3-preservation-followup-batch.md)
-- and its acceptance review (docs/v2-m3-preservation-final-review.md) directed
-- the smallest physical changes needed to preserve three legacy facts. M1/M2/M3
-- are immutable and were not edited; this is a new, additive migration for
-- root's own review and apply decision. It has been validated only against a
-- disposable local PG17 cluster with M1, M2 and M3 replayed first -- never
-- against the target vbjtbwelnhbbdfrqczyf or any project with real data.
--
-- Every change is additive: one relaxed NOT NULL, two new nullable columns
-- (app.retired_library_games.legacy_ownership,
-- app.game_activity.legacy_last_played_at), one new table CHECK, and two
-- widened disposition CHECKs. No existing row of an applied relation is
-- rewritten, and no column is dropped, narrowed or retyped.
--
-- Deletion and export behaviour is inherited, not re-declared: every relation
-- touched here is already registered in ops.data_retention_registry as
-- durable-account-lifetime / holds_personal_data / account_fk_column =
-- 'account_id' / deletion_mode 'cascade' / export_scope 'account_export'. The
-- new columns add no account UUID, so account_uuid_columns stays '{}' and the
-- registry's de_identify rule is unaffected; account deletion reaches the new
-- values through the same account_id cascade as the rows that carry them.
--
-- Each existing constraint this file replaces is matched by its exact frozen
-- name AND its exact frozen definition, and raises instead of guessing if the
-- applied schema has drifted from what this proposal was written against.
--
-- ===========================================================================
-- 1. app.retired_library_games -- legacy retirement (decision 1)
-- ===========================================================================
--
-- Root's correction to the prior review: `ownership = 'Wishlist'` is not
-- proof a row was never owned. `lib/steam-import-jobs.ts:190-221`
-- (reconcileSteamOwnership) demotes a previously-Owned personal row absent
-- from the latest complete Steam response to Wishlist, keeping its notes,
-- hours and history intact. Do not invent "never owned" or "was owned" --
-- preserve the literal source `ownership` value as-is, and do not conflate
-- that origin fact with `loss_reason` (why access ended), which stays
-- unaware of "wishlist" by design (M1's three literals -- complete_snapshot,
-- manual, unknown -- already say why; a fourth literal would say what the row
-- was, a different question).
--
-- `access_lost_at` stays NOT NULL in behaviour for every write outside the one
-- authorized legacy case: it keeps its `now()` default, and the CHECK below
-- accepts a null only for a row that is explicitly labelled
-- `legacy_ownership = 'Wishlist'` AND `loss_reason = 'unknown'`. Root's
-- acceptance review: the previous revision of this file accepted any non-null
-- legacy_ownership, which would also have allowed a legacy 'Owned' label to
-- carry a null loss instant. That is wider than the binding batch authorized,
-- and is corrected here to the exact literal.
--
-- NULL-safety is explicit rather than incidental, because a CHECK passes on
-- UNKNOWN as well as TRUE. `loss_reason` is NOT NULL, so `loss_reason =
-- 'unknown'` is always TRUE or FALSE. `legacy_ownership` is nullable, so
-- `legacy_ownership = 'Wishlist'` alone would be UNKNOWN for a null label,
-- and `access_lost_at is not null or (TRUE and UNKNOWN)` evaluates to UNKNOWN
-- -- accepting exactly the unlabelled null loss instant this constraint
-- exists to refuse. The `legacy_ownership is not null` conjunct forces that
-- case to FALSE (FALSE AND anything is FALSE in three-valued logic), so every
-- subexpression is a guaranteed boolean and the constraint can never pass by
-- unknown.

alter table app.retired_library_games
  alter column access_lost_at drop not null;

alter table app.retired_library_games
  add column legacy_ownership text
    check (legacy_ownership is null or legacy_ownership in ('Owned', 'Wishlist'));

comment on column app.retired_library_games.legacy_ownership is
  'Verbatim legacy user_games.ownership literal for this retired row, when known. '
  'Not an inferred prior-ownership claim: Wishlist here can be a never-owned row, '
  'a row demoted from Owned by lib/steam-import-jobs.ts reconcileSteamOwnership, '
  'or a family tombstone from remove_user_family_member_games. NULL means the '
  'writer that created this row (a future complete-snapshot loss detector, for '
  'example) did not record the origin, not that the origin is Wishlist.';

alter table app.retired_library_games
  add constraint retired_library_games_null_loss_instant_requires_legacy_label
  check (
    access_lost_at is not null
    or (
      loss_reason = 'unknown'
      and legacy_ownership is not null
      and legacy_ownership = 'Wishlist'
    )
  );

-- ===========================================================================
-- 2. app.game_activity -- distinct raw play facts (decision 3)
-- ===========================================================================
--
-- Root's acceptance review: legacy `user_games` carries two separate
-- last-played readings, `last_played_at` and `last_observed_played_at`.
-- app.game_activity.last_played_at takes the observed column (what
-- lib/recency.ts treats as the product's notion of last played). The prior
-- revision kept the other reading only in
-- migration.legacy_library_evidence.evidence, whose registered retention
-- class is staging-30d-post-cutover -- that expires, so it is not
-- preservation. This nullable column is the smallest durable home for it.
--
-- It is written only when the raw reading is a distinct fact: a different
-- instant, or a raw value with no observed counterpart. No ordering between
-- the two is asserted. The reviewed writers only ever advance
-- last_observed_played_at at or after the raw column, but that is a writer
-- pattern, not a source-schema guarantee, so no CHECK encodes it here and an
-- inverted pair is stored exactly as found.

alter table app.game_activity
  add column legacy_last_played_at timestamptz;

comment on column app.game_activity.legacy_last_played_at is
  'Legacy user_games.last_played_at, kept only when it is a distinct fact from '
  'last_played_at (which carries legacy last_observed_played_at): a different '
  'instant in either direction, or a raw value with no observed counterpart. '
  'NULL when the two legacy readings agree or the raw column held nothing. No '
  'ordering against last_played_at is enforced or implied.';

-- ===========================================================================
-- 3. app.family_access_orphans -- family retirement (decision 2)
-- ===========================================================================
--
-- `supabase/migrations/20260901193000_share_a_family_library.sql:237-280`
-- (remove_user_family_member_games) proves `ownership = 'Wishlist'` with
-- `access_source = 'family'` and an intact `family_owner_steam_id` is a
-- supported source tombstone for an engaged row (one with a note or a
-- Completed/Slept status), written on family-member removal -- not an
-- unresolved combination, and never grounds to restore access. The lender in
-- that row is frequently still a resolvable app.family_members row (only this
-- one game's access ended, not the whole membership), so this is distinct
-- from the existing 'quarantine' case, which means the lender identity itself
-- could not be resolved. Conflating the two would misreport a deliberate,
-- source-recorded revocation as an identity-resolution failure.
--
-- 'retired' is added as a new disposition literal alongside the existing
-- three. `confers_access` keeps its existing `= false` CHECK unchanged --
-- both dispositions confer nothing. No new column is needed: `account_id`
-- plus `lender_steam_id` already identifies the member via
-- app.family_members' own `unique (account_id, steam_id)`, so the resolved
-- lender identity is not lost by omitting a member_id column here.
--
-- The staging copy migration.legacy_family_access_orphans carries the same
-- disposition values and needs the identical widening; missing that half
-- would let the transform's typed output name a 'retired' row while the
-- staging table alone still refuses it.
--
-- Both replacements below name the exact constraint (M3's inline CHECK, whose
-- auto-generated name is deterministic) and assert its exact current
-- definition before dropping it. Root's acceptance review: the previous
-- revision matched on `ilike '%disposition%'` and `ilike '%quarantine%'`,
-- which would silently drop some other, later constraint that happened to
-- mention either word. Drift now raises instead of guessing.

do $$
declare
  v_expected constant text :=
    'CHECK ((disposition = ANY (ARRAY[''quarantine''::text, ''manual_review''::text, ''resolved''::text])))';
  v_actual text;
begin
  select pg_get_constraintdef(con.oid) into v_actual
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'app'
    and rel.relname = 'family_access_orphans'
    and con.conname = 'family_access_orphans_disposition_check'
    and con.contype = 'c';

  if v_actual is null then
    raise exception
      'drift: app.family_access_orphans_disposition_check not found; this proposal was written against M3 20260910232654 and will not guess which constraint to replace';
  end if;

  if v_actual <> v_expected then
    raise exception
      'drift: app.family_access_orphans_disposition_check is % but this proposal was written against %', v_actual, v_expected;
  end if;

  execute 'alter table app.family_access_orphans drop constraint family_access_orphans_disposition_check';
end $$;

alter table app.family_access_orphans
  add constraint family_access_orphans_disposition_check
  check (disposition in ('quarantine', 'manual_review', 'resolved', 'retired'));

comment on column app.family_access_orphans.disposition is
  'quarantine: the lender identity itself could not be resolved (missing or '
  'malformed family_owner_steam_id). retired: the lender resolved, but the '
  'source explicitly ended this access (remove_user_family_member_games); '
  'never restored regardless of resolution. manual_review, resolved: '
  'pre-existing, unchanged by this proposal.';

do $$
declare
  v_expected constant text :=
    'CHECK ((disposition = ANY (ARRAY[''quarantine''::text, ''manual_review''::text, ''resolved''::text])))';
  v_actual text;
begin
  select pg_get_constraintdef(con.oid) into v_actual
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'migration'
    and rel.relname = 'legacy_family_access_orphans'
    and con.conname = 'legacy_family_access_orphans_disposition_check'
    and con.contype = 'c';

  if v_actual is null then
    raise exception
      'drift: migration.legacy_family_access_orphans_disposition_check not found; this proposal was written against M3 20260910232654 and will not guess which constraint to replace';
  end if;

  if v_actual <> v_expected then
    raise exception
      'drift: migration.legacy_family_access_orphans_disposition_check is % but this proposal was written against %', v_actual, v_expected;
  end if;

  execute 'alter table migration.legacy_family_access_orphans drop constraint legacy_family_access_orphans_disposition_check';
end $$;

alter table migration.legacy_family_access_orphans
  add constraint legacy_family_access_orphans_disposition_check
  check (disposition in ('quarantine', 'manual_review', 'resolved', 'retired'));
