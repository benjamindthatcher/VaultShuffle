alter table public.game_duration_estimates
  add column if not exists evidence jsonb not null default '{}'::jsonb;

comment on column public.game_duration_estimates.evidence is
  'Compact provider identity, duration-basis, mode and validation evidence. Raw provider values remain in their typed columns.';

create index if not exists game_duration_estimates_igdb_sibling_idx
  on public.game_duration_estimates (provider_game_id, steam_app_id)
  where provider = 'igdb'
    and match_status = 'matched'
    and provider_game_id is not null;

create or replace function public.reconcile_catalogue_duration(
  p_steam_app_id bigint,
  p_estimate_removed boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_game public.catalog_games%rowtype;
  best_match public.game_duration_estimates%rowtype;
  review_match public.game_duration_estimates%rowtype;
  latest_evidence public.game_duration_estimates%rowtype;
begin
  select *
  into existing_game
  from public.catalog_games
  where steam_appid = p_steam_app_id
  for update;

  if not found or existing_game.duration_manual_override then
    return;
  end if;

  -- Quarantine is an independent, owner-reviewed workflow. Duration refreshes
  -- may retain evidence rows, but must not change excluded catalogue products.
  if exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = p_steam_app_id
      and quarantine.review_status = 'excluded'
  ) then
    return;
  end if;

  -- An affirmative endless/not-applicable decision is resolved by the separate
  -- classification audit. Provider rows stage a conflict rather than silently
  -- replacing the classification. Clearing an unsupported classification to
  -- unknown allows this function to project the best accepted finite evidence.
  if existing_game.duration_kind in ('endless', 'not-applicable') then
    return;
  end if;

  select estimate.*
  into best_match
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status = 'matched'
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
      or estimate.completionist_minutes >= coalesce(estimate.main_extra_minutes, estimate.main_story_minutes)
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint < estimate.main_story_minutes::bigint * 12
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
              'safe_exact_title',
              'safe_exact_alias'
            )
            and estimate.evidence ->> 'verification_tier' in (
              'exact_title',
              'mixed_script_title'
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
        and lower(existing_game.name) !~
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
    case estimate.match_confidence when 'high' then 2 else 1 end desc,
    case estimate.provider when 'hltb' then 2 when 'igdb' then 1 end desc,
    (
      (estimate.main_story_minutes is not null)::int
      + (estimate.main_extra_minutes is not null)::int
      + (estimate.completionist_minutes is not null)::int
    ) desc,
    coalesce(estimate.submission_count, 0) desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc nulls last
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = best_match.main_story_minutes,
        main_extras_minutes = best_match.main_extra_minutes,
        completionist_minutes = best_match.completionist_minutes,
        duration_source = best_match.provider,
        duration_source_game_id = best_match.provider_game_id::text,
        duration_source_updated_at = coalesce(best_match.provider_updated_at, best_match.checked_at),
        duration_confidence = best_match.match_confidence,
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
        best_match.main_story_minutes,
        best_match.main_extra_minutes,
        best_match.completionist_minutes,
        best_match.provider,
        best_match.provider_game_id::text,
        coalesce(best_match.provider_updated_at, best_match.checked_at),
        best_match.match_confidence,
        'ready'::text,
        'finite'::text
      );
    return;
  end if;

  -- Unaccepted matches remain durable evidence, but never leak their values to
  -- catalogue consumers while they await review.
  select estimate.*
  into review_match
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status = 'matched'
  order by
    case estimate.match_confidence
      when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0
    end desc,
    case estimate.provider
      when 'hltb' then 4 when 'igdb' then 3 when 'igdb-parent' then 2
      when 'igdb-title' then 1 else 0
    end desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc nulls last
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = review_match.provider,
        duration_source_game_id = review_match.provider_game_id::text,
        duration_source_updated_at = coalesce(review_match.provider_updated_at, review_match.checked_at),
        duration_confidence = case
          when review_match.match_confidence in ('low', 'medium', 'high')
            then review_match.match_confidence
          else null
        end,
        duration_status = 'review_required',
        duration_kind = 'unknown',
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
        null::integer,
        null::integer,
        null::integer,
        review_match.provider,
        review_match.provider_game_id::text,
        coalesce(review_match.provider_updated_at, review_match.checked_at),
        case
          when review_match.match_confidence in ('low', 'medium', 'high')
            then review_match.match_confidence
          else null
        end,
        'review_required'::text,
        'unknown'::text
      );
    return;
  end if;

  select estimate.*
  into latest_evidence
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status in ('no_duration', 'ambiguous', 'needs_review', 'not_found')
  order by
    case estimate.match_status
      when 'no_duration' then 4 when 'ambiguous' then 3
      when 'needs_review' then 2 when 'not_found' then 1
    end desc,
    estimate.checked_at desc nulls last,
    estimate.provider asc
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = latest_evidence.provider,
        duration_source_game_id = latest_evidence.provider_game_id::text,
        duration_source_updated_at = coalesce(latest_evidence.provider_updated_at, latest_evidence.checked_at),
        duration_confidence = case
          when latest_evidence.match_confidence in ('low', 'medium', 'high')
            then latest_evidence.match_confidence
          else null
        end,
        duration_status = 'review_required',
        duration_kind = 'unknown',
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
        null::integer,
        null::integer,
        null::integer,
        latest_evidence.provider,
        latest_evidence.provider_game_id::text,
        coalesce(latest_evidence.provider_updated_at, latest_evidence.checked_at),
        case
          when latest_evidence.match_confidence in ('low', 'medium', 'high')
            then latest_evidence.match_confidence
          else null
        end,
        'review_required'::text,
        'unknown'::text
      );
    return;
  end if;

  if p_estimate_removed then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = null,
        duration_source_game_id = null,
        duration_source_updated_at = null,
        duration_confidence = null,
        duration_status = 'review_required',
        duration_kind = 'unknown',
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
        null::integer,
        null::integer,
        null::integer,
        null::text,
        null::text,
        null::timestamptz,
        null::text,
        'review_required'::text,
        'unknown'::text
      );
  end if;
end;
$$;

-- Direct IGDB eligibility depends on every Steam AppID linked to the same IGDB
-- game. Reconcile the complete affected sibling set after each row change so a
-- later insert/update/delete cannot leave an earlier sibling projected under a
-- stale uniqueness decision. Ascending order gives concurrent writers one lock
-- order and avoids cross-AppID deadlocks.
create or replace function public.sync_duration_estimate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_app_id bigint;
  new_app_id bigint;
  old_igdb_id bigint;
  new_igdb_id bigint;
  affected record;
  estimate_removed boolean;
begin
  if tg_op <> 'INSERT' then
    old_app_id := old.steam_app_id;
    if old.provider = 'igdb' then
      old_igdb_id := old.provider_game_id;
    end if;
  end if;

  if tg_op <> 'DELETE' then
    new_app_id := new.steam_app_id;
    if new.provider = 'igdb' then
      new_igdb_id := new.provider_game_id;
    end if;
  end if;

  -- Direct IGDB eligibility is a cross-row uniqueness decision. Serialize all
  -- IGDB identity changes so concurrent workers cannot each project a shared
  -- provider ID while the other transaction is still invisible. IGDB writes
  -- are infrequent enough that the deliberately coarse transaction lock is a
  -- safer trade-off than per-ID row-trigger locks (which can deadlock when two
  -- multi-row statements encounter IDs in opposite orders). Duration writers
  -- use PostgreSQL's default READ COMMITTED isolation so the SPI queries after
  -- a blocked lock acquisition see the transaction that just committed.
  if old_igdb_id is not null or new_igdb_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vaultshuffle:duration:igdb-writes', 0)
    );
  end if;

  for affected in
    select distinct candidates.steam_app_id
    from (
      select old_app_id as steam_app_id
      union all
      select new_app_id
      union all
      select estimate.steam_app_id
      from public.game_duration_estimates as estimate
      where estimate.provider = 'igdb'
        and estimate.match_status = 'matched'
        and estimate.provider_game_id is not null
        and estimate.provider_game_id in (old_igdb_id, new_igdb_id)
    ) as candidates
    where candidates.steam_app_id is not null
    order by candidates.steam_app_id
  loop
    estimate_removed := (
      (tg_op = 'DELETE' and affected.steam_app_id = old_app_id)
      or (
        tg_op = 'UPDATE'
        and old_app_id is distinct from new_app_id
        and affected.steam_app_id = old_app_id
      )
    );
    perform public.reconcile_catalogue_duration(
      affected.steam_app_id,
      estimate_removed
    );
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_catalogue_duration(bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.sync_duration_estimate()
  from public, anon, authenticated;

comment on function public.reconcile_catalogue_duration(bigint, boolean) is
  'Projects validated HLTB or conservative direct-IGDB evidence while preserving manual, excluded and classified nonfinite rows.';
