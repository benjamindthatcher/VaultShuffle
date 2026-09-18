-- Verbatim definition captured before relaxing the low-confidence submission floor (2026-09-16).
-- Restore by running this file as-is.

CREATE OR REPLACE FUNCTION public.reconcile_catalogue_duration(p_steam_app_id bigint, p_estimate_removed boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  projected_game public.catalog_games%rowtype;
  low_sample public.game_duration_estimates%rowtype;
begin
  perform public.reconcile_catalogue_duration_v2(
    p_steam_app_id,
    p_estimate_removed
  );

  select *
  into projected_game
  from public.catalog_games
  where steam_appid = p_steam_app_id
  for update;

  if not found
    or projected_game.duration_manual_override
    or projected_game.duration_kind in ('endless', 'not-applicable')
    or (
      projected_game.duration_status = 'ready'
      and projected_game.duration_kind = 'finite'
    )
  then
    return;
  end if;

  if exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = p_steam_app_id
      and quarantine.review_status = 'excluded'
  ) then
    return;
  end if;

  select estimate.*
  into low_sample
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status = 'matched'
    and estimate.match_confidence = 'low'
    and estimate.provider_game_id is not null
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (
      estimate.main_story_minutes is null
      or estimate.main_story_minutes between 1 and 120000
    )
    and (
      estimate.main_extra_minutes is null
      or estimate.main_extra_minutes between 1 and 120000
    )
    and (
      estimate.completionist_minutes is null
      or estimate.completionist_minutes between 1 and 120000
    )
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      ) is null
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
        and estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
        and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        and estimate.evidence ->> 'duration_basis' = 'completion_times'
        and estimate.evidence -> 'duration_issues' = '[]'::jsonb
        and (
          coalesce(estimate.submission_count, 0) >= 2
          or (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) >= 2
        )
      )
      or (
        estimate.provider = 'igdb'
        and (
          (
            coalesce(estimate.submission_count, 0) between 2 and 4
            and (
              (estimate.main_story_minutes is not null)::int
              + (estimate.main_extra_minutes is not null)::int
              + (estimate.completionist_minutes is not null)::int
            ) >= 2
            and (
              estimate.main_story_minutes is null
              or estimate.main_extra_minutes is null
              or estimate.main_extra_minutes::bigint
                < estimate.main_story_minutes::bigint * 12
            )
            and (
              coalesce(
                estimate.main_story_minutes,
                estimate.main_extra_minutes
              ) is null
              or estimate.completionist_minutes is null
              or estimate.completionist_minutes::bigint < coalesce(
                estimate.main_story_minutes,
                estimate.main_extra_minutes
              )::bigint * 12
            )
          )
          or (
            coalesce(estimate.submission_count, 0) = 1
            and estimate.main_story_minutes between 30 and 30000
            and estimate.main_extra_minutes
              between estimate.main_story_minutes and 30000
            and estimate.completionist_minutes
              between estimate.main_extra_minutes and 30000
            and estimate.main_extra_minutes::bigint
              <= estimate.main_story_minutes::bigint * 4
            and estimate.completionist_minutes::bigint
              <= estimate.main_extra_minutes::bigint * 3
            and estimate.completionist_minutes::bigint
              <= estimate.main_story_minutes::bigint * 6
            and lower(btrim(coalesce(projected_game.steam_type, ''))) = 'game'
            and coalesce(projected_game.review_total, 0) >= 100
            and exists (
              select 1
              from unnest(
                coalesce(projected_game.categories, array[]::text[])
              ) as category(value)
              where lower(btrim(category.value)) in (
                'single-player', 'single player'
              )
            )
            and not exists (
              select 1
              from unnest(
                coalesce(projected_game.categories, array[]::text[])
              ) as category(value)
              where lower(btrim(category.value)) in (
                'multi-player', 'multiplayer', 'online co-op', 'co-op',
                'mmo', 'pvp', 'online pvp'
              )
            )
            and exists (
              select 1
              from pg_catalog.jsonb_object_keys(
                coalesce(projected_game.tags, '{}'::jsonb)
              ) as tag(value)
              where lower(btrim(tag.value)) in (
                'story rich', 'campaign', 'visual novel', 'multiple endings',
                'choices matter', 'narrative', 'linear'
              )
            )
            and not exists (
              select 1
              from pg_catalog.jsonb_object_keys(
                coalesce(projected_game.tags, '{}'::jsonb)
              ) as tag(value)
              where lower(btrim(tag.value)) in (
                'sandbox', 'open world survival craft', 'colony sim',
                'life sim', 'city builder', 'god game', 'automation'
              )
            )
          )
        )
        and lower(projected_game.name) !~
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
  order by
    case estimate.provider when 'hltb' then 2 when 'igdb' then 1 else 0 end desc,
    (
      (estimate.main_story_minutes is not null)::int
      + (estimate.main_extra_minutes is not null)::int
      + (estimate.completionist_minutes is not null)::int
    ) desc,
    coalesce(estimate.submission_count, 0) desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc
  limit 1;

  if not found then
    return;
  end if;

  update public.catalog_games
  set main_story_minutes = low_sample.main_story_minutes,
      main_extras_minutes = low_sample.main_extra_minutes,
      completionist_minutes = low_sample.completionist_minutes,
      duration_source = low_sample.provider,
      duration_source_game_id = low_sample.provider_game_id::text,
      duration_source_updated_at = coalesce(
        low_sample.provider_updated_at,
        low_sample.checked_at
      ),
      duration_confidence = 'low',
      duration_status = 'ready',
      duration_kind = 'finite',
      updated_at = now()
  where steam_appid = p_steam_app_id
    and row(
      main_story_minutes,
      main_extras_minutes,
      completionist_minutes,
      duration_source,
      duration_source_game_id,
      duration_source_updated_at,
      duration_confidence,
      duration_status,
      duration_kind
    ) is distinct from row(
      low_sample.main_story_minutes,
      low_sample.main_extra_minutes,
      low_sample.completionist_minutes,
      low_sample.provider,
      low_sample.provider_game_id::text,
      coalesce(low_sample.provider_updated_at, low_sample.checked_at),
      'low'::text,
      'ready'::text,
      'finite'::text
    );
end;
$function$

