-- Rebuild legacy automatic non-finite classifications after duration evidence
-- has been validated and 20260825143500_harden_duration_evidence.sql is live.
--
-- Safety properties:
--   * explicit duration_manual_override rows are immutable;
--   * catalog_game_quarantine rows with review_status = 'excluded' are immutable;
--   * no row is added to or changed in quarantine;
--   * game_duration_estimates is read-only and remains the durable raw evidence;
--   * unsupported automatic endless/not-applicable labels are demoted before
--     public.reconcile_catalogue_duration projects hardened finite/review evidence;
--   * every change and assertion is one transaction, so any failure rolls back.
--
-- Run scripts/durations/dry-run-rebuild-duration-classifications.sql first.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '15min';

-- Duration estimate writes invoke catalogue reconciliation. Take the evidence
-- lock first to avoid the inverse lock order with a concurrent worker, then hold
-- catalogue and quarantine stable for the short rebuild transaction.
lock table public.game_duration_estimates in share mode;
lock table public.catalog_game_quarantine in share mode;
lock table public.catalog_games in share row exclusive mode;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_duration_estimates'
      and column_name = 'evidence'
      and data_type = 'jsonb'
  ) then
    raise exception
      'rebuild_duration_classifications requires game_duration_estimates.evidence jsonb';
  end if;

  if pg_catalog.to_regprocedure(
    'public.reconcile_catalogue_duration(bigint,boolean)'
  ) is null then
    raise exception
      'rebuild_duration_classifications requires reconcile_catalogue_duration(bigint, boolean)';
  end if;

  -- This migration is intentionally post-validation. Abort rather than
  -- classifying from legacy rows after only a partial HLTB writeback.
  if not exists (
    select 1
    from public.catalog_duration_import_runs as import_run
    where import_run.source = 'hltb_detail_validation'
      and import_run.source_sha256 =
        'a3614aa730cd775342ceaf7fdece41fd72d84d35e63c35d917b6447c427466ee'
      and import_run.status = 'completed'
      and import_run.completed_at is not null
      and import_run.imported_count = 26850
      and import_run.skipped_count = 1620
      and import_run.expected_app_count = 28467
      and import_run.staged_row_count = 28470
      and import_run.manifest #>> '{final_verification,missing_catalogue}' = '0'
      and import_run.manifest #>> '{final_verification,job_state_mismatches}' = '0'
      and import_run.manifest #>> '{final_verification,unhardened_hltb_projected_ready}' = '0'
      and import_run.manifest #>> '{final_verification,no_duration_rows_with_raw_values}' = '0'
  ) then
    raise exception
      'the exact validated HLTB writeback must complete before classification rebuild';
  end if;
end;
$$;

-- Snapshot every row protected by either owner intent or confirmed exclusion.
-- The postcondition compares every catalogue field this migration can touch.
create temporary table pg_temp.duration_classification_protected_before
on commit drop
as
select
  game.steam_appid,
  pg_catalog.jsonb_build_array(
    game.main_story_minutes,
    game.main_extras_minutes,
    game.completionist_minutes,
    game.duration_source,
    game.duration_source_game_id,
    game.duration_source_updated_at,
    game.duration_confidence,
    game.duration_status,
    game.duration_kind,
    game.updated_at
  ) as protected_projection
from public.catalog_games as game
where game.duration_manual_override
   or exists (
     select 1
     from public.catalog_game_quarantine as quarantine
     where quarantine.steam_appid = game.steam_appid
       and quarantine.review_status = 'excluded'
   );

-- This checksum is deliberately over the complete estimate row. It is not a
-- backup; it is an assertion that the rebuild preserved all raw evidence.
create temporary table pg_temp.duration_estimate_guard
on commit drop
as
select
  count(*) as estimate_rows,
  coalesce(
    sum(
      pg_catalog.hashtextextended(
        pg_catalog.to_jsonb(estimate)::text,
        0
      )::numeric
    ),
    0::numeric
  ) as evidence_fingerprint
from public.game_duration_estimates as estimate;

-- Catalogue updates must not have an indirect quarantine side effect either.
create temporary table pg_temp.duration_quarantine_guard
on commit drop
as
select
  count(*) as quarantine_rows,
  coalesce(
    sum(
      pg_catalog.hashtextextended(
        pg_catalog.to_jsonb(quarantine)::text,
        0
      )::numeric
    ),
    0::numeric
  ) as quarantine_fingerprint
from public.catalog_game_quarantine as quarantine;

create temporary table pg_temp.duration_classification_rebuild_plan (
  steam_appid bigint primary key,
  name text not null,
  review_total integer,
  prior_duration_kind text not null,
  prior_duration_status text,
  prior_duration_source text,
  action text not null check (
    action in ('retain_endless', 'promote_endless', 'demote_and_reconcile')
  ),
  retain_route text not null check (
    retain_route in (
      'none',
      'strict_steam_loop',
      'validated_hltb_modes',
      'corroborated_steam_loop',
      'strict_steam_and_hltb_modes'
    )
  ),
  has_hardened_finite boolean not null,
  has_positive_matched boolean not null,
  is_primary_title boolean not null,
  has_direct_igdb_no_duration boolean not null,
  has_validated_hltb_multiplayer_no_duration boolean not null,
  has_validated_hltb_coop_no_duration boolean not null,
  official_single_player boolean not null,
  has_single_player_or_story_tag boolean not null,
  steam_loop_signal boolean not null,
  reason text not null
) on commit drop;

with scoped as (
  select game.*
  from public.catalog_games as game
  where game.duration_kind in ('endless', 'not-applicable', 'unknown')
    and not game.duration_manual_override
    and not exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    )
), tag_rows as (
  select
    game.steam_appid,
    lower(btrim(tag.key)) as tag,
    case
      when tag.value #>> '{}' ~ '^[0-9]+([.][0-9]+)?$'
        then (tag.value #>> '{}')::numeric
      else null
    end as votes
  from scoped as game
  left join lateral pg_catalog.jsonb_each(
    coalesce(game.tags, '{}'::jsonb)
  ) as tag(key, value) on true
), tag_maximums as (
  select
    steam_appid,
    max(votes) filter (where votes > 0) as top_votes
  from tag_rows
  group by steam_appid
), tag_flags as (
  select
    row.steam_appid,
    coalesce(bool_or(row.tag in (
      'singleplayer', 'single-player', 'single player', 'story rich',
      'campaign', 'co-op campaign', 'multiple endings', 'visual novel'
    )), false) as has_single_player_or_story_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('massively multiplayer', 'mmo', 'mmorpg')
    ), false) as has_dominant_mmo_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('battle royale', 'moba')
    ), false) as has_dominant_pvp_loop_tag,
    coalesce(bool_or(row.tag in (
      'auto battler', 'battle royale', 'hero shooter', 'massively multiplayer',
      'mmo', 'mmorpg', 'moba'
    )), false) as has_distinctive_online_loop_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.35
      and row.tag in (
        'competitive', 'esports', 'e-sports', 'online pvp', 'pvp', 'team-based'
      )
    ), false) as has_weighted_competitive_loop_tag,
    coalesce(bool_or(
      maximum.top_votes > 0
      and row.votes >= maximum.top_votes * 0.65
      and row.tag in ('open world survival craft', 'sandbox')
    ), false) as has_dominant_sandbox_loop_tag
  from tag_rows as row
  join tag_maximums as maximum
    on maximum.steam_appid = row.steam_appid
  group by row.steam_appid
), catalogue_flags as (
  select
    game.steam_appid,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in ('single-player', 'single player')
    ) as official_single_player,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in (
        'multi-player', 'multiplayer', 'mmo', 'pvp', 'online pvp'
      )
    ) as official_multiplayer,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) = 'online co-op'
    ) as official_online_coop,
    exists (
      select 1
      from unnest(
        coalesce(game.genres, array[]::text[])
        || coalesce(game.categories, array[]::text[])
      ) as signal(value)
      where lower(btrim(signal.value)) in (
        'massively multiplayer', 'mmo', 'mmorpg'
      )
    ) as official_mmo,
    exists (
      select 1
      from unnest(coalesce(game.categories, array[]::text[])) as category(value)
      where lower(btrim(category.value)) in ('pvp', 'online pvp')
    ) as official_pvp
  from scoped as game
), estimate_flags as (
  select
    game.steam_appid,
    coalesce(bool_or(
      estimate.match_status = 'matched'
      and (
        estimate.main_story_minutes > 0
        or estimate.main_extra_minutes > 0
        or estimate.completionist_minutes > 0
      )
    ), false) as has_positive_matched,
    coalesce(bool_or(
      estimate.provider = 'igdb'
      and estimate.match_status = 'no_duration'
      and estimate.match_confidence in ('medium', 'high')
      and estimate.provider_game_id is not null
      and estimate.main_story_minutes is null
      and estimate.main_extra_minutes is null
      and estimate.completionist_minutes is null
      and lower(game.name) !~
        '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
      and (
        estimate.evidence @>
          '{"duplicate_provider_id_validated": true}'::jsonb
        or not exists (
          select 1
          from public.game_duration_estimates as sibling_estimate
          where sibling_estimate.provider = 'igdb'
            and sibling_estimate.provider_game_id = estimate.provider_game_id
            and sibling_estimate.steam_app_id <> estimate.steam_app_id
        )
      )
    ), false) as has_direct_igdb_no_duration,
    coalesce(bool_or(
      estimate.provider = 'hltb'
      and estimate.match_status = 'no_duration'
      and estimate.match_confidence in ('medium', 'high')
      and estimate.provider_game_id is not null
      and estimate.main_story_minutes is null
      and estimate.main_extra_minutes is null
      and estimate.completionist_minutes is null
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and estimate.evidence ->> 'duration_basis' = 'no_duration'
      and (
        (
          estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
          and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        )
        or (
          estimate.evidence ->> 'verification_method' in (
            'safe_exact_title', 'safe_exact_alias'
          )
          and estimate.evidence ->> 'verification_tier' in (
            'exact_title', 'mixed_script_title'
          )
        )
      )
      and estimate.evidence #>> '{hltb_modes,single_player}' = 'false'
      and estimate.evidence #>> '{hltb_modes,multiplayer}' = 'true'
    ), false) as has_validated_hltb_multiplayer_no_duration,
    coalesce(bool_or(
      estimate.provider = 'hltb'
      and estimate.match_status = 'no_duration'
      and estimate.match_confidence in ('medium', 'high')
      and estimate.provider_game_id is not null
      and estimate.main_story_minutes is null
      and estimate.main_extra_minutes is null
      and estimate.completionist_minutes is null
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and estimate.evidence ->> 'duration_basis' = 'no_duration'
      and (
        (
          estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
          and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        )
        or (
          estimate.evidence ->> 'verification_method' in (
            'safe_exact_title', 'safe_exact_alias'
          )
          and estimate.evidence ->> 'verification_tier' in (
            'exact_title', 'mixed_script_title'
          )
        )
      )
      and estimate.evidence #>> '{hltb_modes,single_player}' = 'false'
      and estimate.evidence #>> '{hltb_modes,co_op}' = 'true'
    ), false) as has_validated_hltb_coop_no_duration
  from scoped as game
  left join public.game_duration_estimates as estimate
    on estimate.steam_app_id = game.steam_appid
  group by game.steam_appid
), hardened_finite as (
  select distinct game.steam_appid
  from scoped as game
  join public.game_duration_estimates as estimate
    on estimate.steam_app_id = game.steam_appid
  where estimate.match_status = 'matched'
    and estimate.match_confidence in ('medium', 'high')
    and estimate.provider_game_id is not null
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
    and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
    and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
      or estimate.completionist_minutes >= coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      )
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint
        < estimate.main_story_minutes::bigint * 12
    )
    and (
      (
        estimate.provider = 'hltb'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in (
              'safe_exact_title', 'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title', 'mixed_script_title'
            )
          )
        )
      )
      or (
        estimate.provider = 'igdb'
        and coalesce(estimate.submission_count, 0) >= 5
        and (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) >= 2
        and lower(game.name) !~
          '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        and (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
          or not exists (
            select 1
            from public.game_duration_estimates as sibling_estimate
            where sibling_estimate.provider = 'igdb'
              and sibling_estimate.match_status = 'matched'
              and sibling_estimate.provider_game_id = estimate.provider_game_id
              and sibling_estimate.steam_app_id <> estimate.steam_app_id
          )
        )
      )
    )
), evaluated as (
  select
    game.steam_appid,
    game.name,
    game.review_total,
    game.duration_kind as prior_duration_kind,
    game.duration_status as prior_duration_status,
    game.duration_source as prior_duration_source,
    estimate.has_positive_matched,
    estimate.has_direct_igdb_no_duration,
    estimate.has_validated_hltb_multiplayer_no_duration,
    estimate.has_validated_hltb_coop_no_duration,
    catalogue.official_single_player,
    catalogue.official_multiplayer,
    catalogue.official_online_coop,
    tag.has_single_player_or_story_tag,
    (
      catalogue.official_multiplayer
      and (
        catalogue.official_mmo
        or catalogue.official_pvp
        or tag.has_dominant_mmo_tag
        or tag.has_dominant_pvp_loop_tag
        or tag.has_distinctive_online_loop_tag
        or tag.has_weighted_competitive_loop_tag
        or tag.has_dominant_sandbox_loop_tag
      )
    ) as steam_loop_signal,
    hardened.steam_appid is not null as has_hardened_finite,
    lower(btrim(coalesce(game.steam_type, ''))) = 'game' as is_steam_game,
    lower(game.name) !~
      '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
      as is_primary_title
  from scoped as game
  join tag_flags as tag
    on tag.steam_appid = game.steam_appid
  join catalogue_flags as catalogue
    on catalogue.steam_appid = game.steam_appid
  join estimate_flags as estimate
    on estimate.steam_appid = game.steam_appid
  left join hardened_finite as hardened
    on hardened.steam_appid = game.steam_appid
), classified as (
  select
    evaluated.*,
    (
      is_steam_game
      and is_primary_title
      and not has_hardened_finite
      and has_direct_igdb_no_duration
      and not official_single_player
      and not has_single_player_or_story_tag
      and steam_loop_signal
    ) as strict_steam_loop,
    (
      is_steam_game
      and is_primary_title
      and not has_hardened_finite
      and not official_single_player
      and not has_single_player_or_story_tag
      and (
        (
          has_validated_hltb_multiplayer_no_duration
          and official_multiplayer
        )
        or (
          has_validated_hltb_coop_no_duration
          and official_online_coop
          and steam_loop_signal
        )
      )
    ) as validated_hltb_modes,
    (
      is_steam_game
      and is_primary_title
      and not has_hardened_finite
      and not official_single_player
      and not has_single_player_or_story_tag
      and steam_loop_signal
    ) as corroborated_steam_loop
  from evaluated
)
insert into pg_temp.duration_classification_rebuild_plan (
  steam_appid,
  name,
  review_total,
  prior_duration_kind,
  prior_duration_status,
  prior_duration_source,
  action,
  retain_route,
  has_hardened_finite,
  has_positive_matched,
  is_primary_title,
  has_direct_igdb_no_duration,
  has_validated_hltb_multiplayer_no_duration,
  has_validated_hltb_coop_no_duration,
  official_single_player,
  has_single_player_or_story_tag,
  steam_loop_signal,
  reason
)
select
  steam_appid,
  name,
  review_total,
  prior_duration_kind,
  prior_duration_status,
  prior_duration_source,
  case
    when prior_duration_kind = 'endless'
      and (
        strict_steam_loop
        or validated_hltb_modes
        or corroborated_steam_loop
      )
      then 'retain_endless'
    when strict_steam_loop or validated_hltb_modes or corroborated_steam_loop
      then 'promote_endless'
    else 'demote_and_reconcile'
  end,
  case
    when strict_steam_loop and validated_hltb_modes
      then 'strict_steam_and_hltb_modes'
    when strict_steam_loop then 'strict_steam_loop'
    when validated_hltb_modes then 'validated_hltb_modes'
    when corroborated_steam_loop then 'corroborated_steam_loop'
    else 'none'
  end,
  has_hardened_finite,
  has_positive_matched,
  is_primary_title,
  has_direct_igdb_no_duration,
  has_validated_hltb_multiplayer_no_duration,
  has_validated_hltb_coop_no_duration,
  official_single_player,
  has_single_player_or_story_tag,
  steam_loop_signal,
  case
    when strict_steam_loop or validated_hltb_modes or corroborated_steam_loop
      then 'corroborated_endless'
    when prior_duration_kind = 'not-applicable'
      then 'automatic_not_applicable_is_not_supported'
    when has_hardened_finite
      then 'hardened_finite_evidence_requires_reconciliation'
    when has_positive_matched
      then 'unaccepted_positive_evidence_requires_review'
    else 'unsupported_automatic_nonfinite_classification'
  end
from classified
where prior_duration_kind in ('endless', 'not-applicable')
   or (
     prior_duration_kind = 'unknown'
     and (
       strict_steam_loop
       or validated_hltb_modes
       or corroborated_steam_loop
     )
   );

do $$
declare
  legacy_count bigint;
  planned_count bigint;
  retained_count bigint;
  promoted_count bigint;
  demoted_count bigint;
begin
  select count(*)
  into legacy_count
  from public.catalog_games as game
  where game.duration_kind in ('endless', 'not-applicable')
    and not game.duration_manual_override
    and not exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    );

  select
    count(*),
    count(*) filter (where action = 'retain_endless'),
    count(*) filter (where action = 'promote_endless'),
    count(*) filter (where action = 'demote_and_reconcile')
  into planned_count, retained_count, promoted_count, demoted_count
  from pg_temp.duration_classification_rebuild_plan;

  if exists (
    select 1
    from public.catalog_games as game
    where game.duration_kind in ('endless', 'not-applicable')
      and not game.duration_manual_override
      and not exists (
        select 1
        from public.catalog_game_quarantine as quarantine
        where quarantine.steam_appid = game.steam_appid
          and quarantine.review_status = 'excluded'
      )
      and not exists (
        select 1
        from pg_temp.duration_classification_rebuild_plan as plan
        where plan.steam_appid = game.steam_appid
      )
  ) then
    raise exception
      'classification rebuild plan omits an automatic non-finite row';
  end if;

  if planned_count < legacy_count then
    raise exception
      'classification rebuild plan is incomplete: planned %, legacy %',
      planned_count,
      legacy_count;
  end if;

  if planned_count > 10000 then
    raise exception
      'classification rebuild safety cap exceeded: % rows', planned_count;
  end if;

  if exists (
    select 1
    from pg_temp.duration_classification_rebuild_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where game.duration_manual_override
       or exists (
         select 1
         from public.catalog_game_quarantine as quarantine
         where quarantine.steam_appid = game.steam_appid
           and quarantine.review_status = 'excluded'
       )
  ) then
    raise exception 'classification rebuild plan contains a protected row';
  end if;

  if exists (
    select 1
    from pg_temp.duration_classification_rebuild_plan
    where action in ('retain_endless', 'promote_endless')
      and (
        (action = 'retain_endless' and prior_duration_kind <> 'endless')
        or (action = 'promote_endless' and prior_duration_kind = 'endless')
        or retain_route = 'none'
        or has_hardened_finite
        or not is_primary_title
        or official_single_player
        or has_single_player_or_story_tag
      )
  ) then
    raise exception 'classification rebuild endless predicate failed its invariant';
  end if;

  raise notice
    'duration classification rebuild: % legacy, % planned, % retain endless, % promote endless, % demote/reconcile',
    legacy_count,
    planned_count,
    retained_count,
    promoted_count,
    demoted_count;
end;
$$;

-- Remove only the unsupported catalogue projection. Provider rows and legacy
-- source identifiers/timestamps remain intact until reconciliation selects the
-- strongest durable evidence. Legacy classification confidence is cleared.
update public.catalog_games as game
set main_story_minutes = null,
    main_extras_minutes = null,
    completionist_minutes = null,
    duration_confidence = null,
    duration_status = 'review_required',
    duration_kind = 'unknown',
    updated_at = now()
from pg_temp.duration_classification_rebuild_plan as plan
where plan.steam_appid = game.steam_appid
  and plan.action = 'demote_and_reconcile'
  and not game.duration_manual_override
  and not exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = game.steam_appid
      and quarantine.review_status = 'excluded'
  );

-- Retained or newly promoted endless rows are still duration-less by
-- definition. Do not rewrite raw source provenance or confidence; only
-- normalize the public projection.
update public.catalog_games as game
set main_story_minutes = null,
    main_extras_minutes = null,
    completionist_minutes = null,
    duration_status = 'ready',
    duration_kind = 'endless',
    updated_at = now()
from pg_temp.duration_classification_rebuild_plan as plan
where plan.steam_appid = game.steam_appid
  and plan.action in ('retain_endless', 'promote_endless')
  and not game.duration_manual_override
  and not exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = game.steam_appid
      and quarantine.review_status = 'excluded'
  )
  and row(
    game.main_story_minutes,
    game.main_extras_minutes,
    game.completionist_minutes,
    game.duration_status,
    game.duration_kind
  ) is distinct from row(
    null::integer,
    null::integer,
    null::integer,
    'ready'::text,
    'endless'::text
  );

-- Demotion removes the early-return classification guard in the hardened
-- reconciler. Ascending AppID order matches the established lock discipline.
do $$
declare
  affected record;
begin
  for affected in
    select plan.steam_appid
    from pg_temp.duration_classification_rebuild_plan as plan
    where plan.action = 'demote_and_reconcile'
    order by plan.steam_appid
  loop
    perform public.reconcile_catalogue_duration(
      affected.steam_appid,
      false
    );
  end loop;
end;
$$;

do $$
begin
  if exists (
    select 1
    from pg_temp.duration_classification_protected_before as before
    join public.catalog_games as game
      on game.steam_appid = before.steam_appid
    where before.protected_projection is distinct from
      pg_catalog.jsonb_build_array(
        game.main_story_minutes,
        game.main_extras_minutes,
        game.completionist_minutes,
        game.duration_source,
        game.duration_source_game_id,
        game.duration_source_updated_at,
        game.duration_confidence,
        game.duration_status,
        game.duration_kind,
        game.updated_at
      )
  ) then
    raise exception 'classification rebuild changed a protected catalogue row';
  end if;

  if exists (
    select 1
    from pg_temp.duration_estimate_guard as before
    cross join lateral (
      select
        count(*) as estimate_rows,
        coalesce(
          sum(
            pg_catalog.hashtextextended(
              pg_catalog.to_jsonb(estimate)::text,
              0
            )::numeric
          ),
          0::numeric
        ) as evidence_fingerprint
      from public.game_duration_estimates as estimate
    ) as after
    where row(before.estimate_rows, before.evidence_fingerprint)
      is distinct from row(after.estimate_rows, after.evidence_fingerprint)
  ) then
    raise exception 'classification rebuild changed raw duration evidence';
  end if;

  if exists (
    select 1
    from pg_temp.duration_quarantine_guard as before
    cross join lateral (
      select
        count(*) as quarantine_rows,
        coalesce(
          sum(
            pg_catalog.hashtextextended(
              pg_catalog.to_jsonb(quarantine)::text,
              0
            )::numeric
          ),
          0::numeric
        ) as quarantine_fingerprint
      from public.catalog_game_quarantine as quarantine
    ) as after
    where row(before.quarantine_rows, before.quarantine_fingerprint)
      is distinct from row(after.quarantine_rows, after.quarantine_fingerprint)
  ) then
    raise exception 'classification rebuild changed quarantine state';
  end if;

  if exists (
    select 1
    from pg_temp.duration_classification_rebuild_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where plan.action in ('retain_endless', 'promote_endless')
      and (
        game.duration_kind <> 'endless'
        or game.duration_status <> 'ready'
        or game.main_story_minutes is not null
        or game.main_extras_minutes is not null
        or game.completionist_minutes is not null
      )
  ) then
    raise exception 'classification rebuild failed an endless postcondition';
  end if;

  if exists (
    select 1
    from pg_temp.duration_classification_rebuild_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where plan.action = 'demote_and_reconcile'
      and (
        (plan.has_hardened_finite and row(game.duration_kind, game.duration_status)
          is distinct from row('finite'::text, 'ready'::text))
        or
        (not plan.has_hardened_finite and row(game.duration_kind, game.duration_status)
          is distinct from row('unknown'::text, 'review_required'::text))
      )
  ) then
    raise exception 'classification rebuild disagrees with hardened reconciliation';
  end if;

  if exists (
    select 1
    from public.catalog_games as game
    where game.duration_kind in ('endless', 'not-applicable')
      and not game.duration_manual_override
      and not exists (
        select 1
        from public.catalog_game_quarantine as quarantine
        where quarantine.steam_appid = game.steam_appid
          and quarantine.review_status = 'excluded'
      )
      and not exists (
        select 1
        from pg_temp.duration_classification_rebuild_plan as plan
        where plan.steam_appid = game.steam_appid
          and plan.action in ('retain_endless', 'promote_endless')
      )
  ) then
    raise exception 'unsupported automatic non-finite classification remains';
  end if;
end;
$$;

commit;
