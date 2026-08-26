-- Read-only preview for 20260825154000_rebuild_duration_classifications.sql.
--
-- This evaluates one CTE-only query, reports the proposed decisions and
-- predicted hardened reconciliation result, then rolls back.
-- Keep every predicate in this file synchronized with the migration.

begin transaction isolation level repeatable read, read only;

set local statement_timeout = '10min';

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
      'dry run requires game_duration_estimates.evidence jsonb';
  end if;

  if pg_catalog.to_regprocedure(
    'public.reconcile_catalogue_duration(bigint,boolean)'
  ) is null then
    raise exception
      'dry run requires reconcile_catalogue_duration(bigint, boolean)';
  end if;

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
  ) then
    raise exception 'dry run requires the completed validated HLTB import marker';
  end if;
end;
$$;

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
        'competitive', 'esports', 'e-sports', 'online pvp', 'pvp'
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
), plan as (
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
  end as action,
  case
    when strict_steam_loop and validated_hltb_modes
      then 'strict_steam_and_hltb_modes'
    when strict_steam_loop then 'strict_steam_loop'
    when validated_hltb_modes then 'validated_hltb_modes'
    when corroborated_steam_loop then 'corroborated_steam_loop'
    else 'none'
  end as retain_route,
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
  end as reason,
  case
    when strict_steam_loop or validated_hltb_modes or corroborated_steam_loop
      then 'endless'
    when has_hardened_finite then 'finite'
    else 'unknown'
  end as predicted_duration_kind,
  case
    when strict_steam_loop or validated_hltb_modes or corroborated_steam_loop
      then 'ready'
    when has_hardened_finite then 'ready'
    else 'review_required'
  end as predicted_duration_status
from classified
where prior_duration_kind in ('endless', 'not-applicable')
   or (
     prior_duration_kind = 'unknown'
     and (
       strict_steam_loop
       or validated_hltb_modes
       or corroborated_steam_loop
     )
   )
), ranked_examples as (
  select
    plan.*,
    row_number() over (
      partition by plan.action, plan.retain_route
      order by plan.review_total desc nulls last, plan.steam_appid
    ) as example_rank
  from plan
), report as (
  -- 01. Top-level impact and predicted post-reconcile state.
  select
    '01_action_summary'::text as audit_section,
    concat_ws(
      ':',
      action,
      retain_route,
      predicted_duration_kind || '/' || predicted_duration_status
    ) as label,
    count(*)::bigint as games,
    pg_catalog.jsonb_build_object(
      'action', action,
      'retain_route', retain_route,
      'predicted_duration_kind', predicted_duration_kind,
      'predicted_duration_status', predicted_duration_status
    ) as details
  from plan
  group by action, retain_route, predicted_duration_kind, predicted_duration_status

  union all

  -- 02. Legacy provenance affected by each decision.
  select
    '02_source_breakdown'::text,
    concat_ws(
      ':',
      action,
      prior_duration_kind,
      coalesce(prior_duration_source, '<null>')
    ),
    count(*)::bigint,
    pg_catalog.jsonb_build_object(
      'action', action,
      'prior_duration_kind', prior_duration_kind,
      'prior_duration_source', coalesce(prior_duration_source, '<null>')
    )
  from plan
  group by action, prior_duration_kind, coalesce(prior_duration_source, '<null>')

  union all

  -- 03. Why rows are retained or demoted.
  select
    '03_reason_breakdown'::text,
    action || ':' || reason,
    count(*)::bigint,
    pg_catalog.jsonb_build_object(
      'action', action,
      'reason', reason,
      'hardened_finite_after_reconcile',
        count(*) filter (where has_hardened_finite),
      'any_positive_match', count(*) filter (where has_positive_matched),
      'official_single_player', count(*) filter (where official_single_player),
      'story_or_single_player_tag',
        count(*) filter (where has_single_player_or_story_tag)
    )
  from plan
  group by action, reason

  union all

  -- 04. Every value whose JSON key ends in _violations must be zero.
  select
    '04_safety_invariants'::text,
    'plan_invariants'::text,
    count(*)::bigint,
    pg_catalog.jsonb_build_object(
      'scoped_automatic_classifications', count(*),
      'retained_endless', count(*) filter (where action = 'retain_endless'),
      'promoted_endless', count(*) filter (where action = 'promote_endless'),
      'demoted_and_reconciled',
        count(*) filter (where action = 'demote_and_reconcile'),
      'safety_cap_violations', case when count(*) > 10000 then 1 else 0 end,
      'post_validation_readiness_violations', case when exists (
        select 1
        from public.catalog_duration_import_runs as import_run
        where import_run.source = 'hltb_detail_validation'
          and import_run.source_sha256 =
            'a3614aa730cd775342ceaf7fdece41fd72d84d35e63c35d917b6447c427466ee'
          and import_run.status = 'completed'
          and import_run.imported_count = 26850
          and import_run.skipped_count = 1620
      ) then 0 else 1 end,
      'endless_action_kind_violations', count(*) filter (
        where (action = 'retain_endless' and prior_duration_kind <> 'endless')
           or (action = 'promote_endless' and prior_duration_kind = 'endless')
      ),
      'retain_predicate_violations', count(*) filter (
        where action in ('retain_endless', 'promote_endless')
          and (
            retain_route = 'none'
            or has_hardened_finite
            or not is_primary_title
            or official_single_player
            or has_single_player_or_story_tag
          )
      ),
      'unsupported_nonfinite_projection_violations', count(*) filter (
        where action = 'demote_and_reconcile'
          and predicted_duration_kind in ('endless', 'not-applicable')
      )
    )
  from plan

  union all

  select
    '04_protected_scope'::text,
    'manual_and_excluded'::text,
    count(*)::bigint,
    pg_catalog.jsonb_build_object(
      'explicit_manual_overrides',
        count(*) filter (where game.duration_manual_override),
      'excluded_quarantine_rows', count(*) filter (
        where exists (
          select 1
          from public.catalog_game_quarantine as quarantine
          where quarantine.steam_appid = game.steam_appid
            and quarantine.review_status = 'excluded'
        )
      ),
      'planned_manual_override_violations', count(*) filter (
        where game.duration_manual_override
          and exists (
            select 1 from plan where plan.steam_appid = game.steam_appid
          )
      ),
      'planned_excluded_violations', count(*) filter (
        where exists (
          select 1
          from public.catalog_game_quarantine as quarantine
          where quarantine.steam_appid = game.steam_appid
            and quarantine.review_status = 'excluded'
        )
          and exists (
            select 1 from plan where plan.steam_appid = game.steam_appid
          )
      )
    )
  from public.catalog_games as game
  where game.duration_kind in ('endless', 'not-applicable', 'unknown')

  union all

  -- 05. Deterministic examples from every action/route, never user data.
  select
    '05_examples'::text,
    steam_appid::text,
    1::bigint,
    pg_catalog.jsonb_build_object(
      'steam_appid', steam_appid,
      'name', name,
      'review_total', review_total,
      'prior_duration_kind', prior_duration_kind,
      'prior_duration_source', prior_duration_source,
      'action', action,
      'retain_route', retain_route,
      'reason', reason,
      'predicted_duration_kind', predicted_duration_kind,
      'predicted_duration_status', predicted_duration_status,
      'has_hardened_finite', has_hardened_finite,
      'has_positive_matched', has_positive_matched,
      'is_primary_title', is_primary_title,
      'has_direct_igdb_no_duration', has_direct_igdb_no_duration,
      'has_validated_hltb_multiplayer_no_duration',
        has_validated_hltb_multiplayer_no_duration,
      'has_validated_hltb_coop_no_duration',
        has_validated_hltb_coop_no_duration,
      'steam_loop_signal', steam_loop_signal
    )
  from ranked_examples
  where example_rank <= 15
)
select audit_section, label, games, details
from report
order by audit_section, label;

rollback;
