-- Replace Sleep with permanent Blacklist in the current legacy runtime.
-- PREPARED LOCALLY, NOT APPLIED. This is compatibility DDL for the app that
-- still reads public.user_games while the V2 cutover is prepared.

begin;

-- Remove the only view dependency before retiring slept_at. The exact current
-- view body was read from pg_get_viewdef on 12 September; it is recreated
-- below with the same projection except for the retired timestamp.
drop view public.user_games_with_catalog;

-- Rewrite large current functions from their installed definition, with an
-- exact-fragment drift fence. Copying the entire account-merge implementation
-- here would create an unrelated fork of its security-sensitive logic.
do $$
declare
  v_definition text;
  v_changed text;
begin
  select pg_get_functiondef('public.upsert_user_steam_games(uuid,jsonb,text)'::regprocedure)
    into v_definition;
  v_changed := replace(v_definition,
    E'    completed_at,\n    slept_at,\n    completion_suggestion_dismissed_at,',
    E'    completed_at,\n    completion_suggestion_dismissed_at,');
  v_changed := replace(v_changed,
    E'    input.completed_at,\n    input.slept_at,\n    input.completion_suggestion_dismissed_at,',
    E'    input.completed_at,\n    input.completion_suggestion_dismissed_at,');
  v_changed := replace(v_changed,
    E'    completed_at timestamptz,\n    slept_at timestamptz,\n    completion_suggestion_dismissed_at timestamptz,',
    E'    completed_at timestamptz,\n    completion_suggestion_dismissed_at timestamptz,');
  v_changed := replace(v_changed,
    E'    completed_at = public.user_games.completed_at,\n    slept_at = public.user_games.slept_at,\n    completion_suggestion_dismissed_at =',
    E'    completed_at = public.user_games.completed_at,\n    completion_suggestion_dismissed_at =');
  if v_changed = v_definition or v_changed ilike '%slept_at%' then
    raise exception 'drift: upsert_user_steam_games Sleep fragments did not match';
  end if;
  execute v_changed;

  select pg_get_functiondef(
    'public.complete_manual_profile_security(text,uuid,text,text,text,text,timestamp with time zone,text)'::regprocedure
  ) into v_definition;
  v_changed := replace(v_definition,
    $old$      when target_games.status = 'Completed' or source_games.status = 'Completed' then 'Completed'
      when source_games.status <> 'Not Started' then source_games.status$old$,
    $new$      when target_games.status = 'Completed' or source_games.status = 'Completed' then 'Completed'
      when target_games.status = 'Blacklisted' or source_games.status = 'Blacklisted' then 'Blacklisted'
      when source_games.status <> 'Not Started' then source_games.status$new$);
  v_changed := replace(v_changed,
    E'    completed_at = greatest(target_games.completed_at, source_games.completed_at),\n    slept_at = greatest(target_games.slept_at, source_games.slept_at),\n    completion_suggestion_dismissed_at =',
    E'    completed_at = greatest(target_games.completed_at, source_games.completed_at),\n    completion_suggestion_dismissed_at =');
  if v_changed = v_definition or v_changed ilike '%slept_at%' then
    raise exception 'drift: complete_manual_profile_security Sleep fragments did not match';
  end if;
  execute v_changed;
end
$$;

alter table public.user_games drop constraint user_games_status_check;
update public.user_games set status = 'Blacklisted' where status = 'Slept';
alter table public.user_games
  add constraint user_games_status_check
  check (status in ('Not Started', 'Sampled', 'In Progress', 'Blacklisted', 'Completed'));
alter table public.user_games drop column slept_at;

comment on column public.user_games.status is
  'Blacklisted is a permanent exclusion until explicit Reactivate. It has no '
  'timestamp or automatic expiry. Completed remains an independent status.';

alter table public.purge_reviews drop constraint purge_reviews_action_check;
update public.purge_reviews set action = 'blacklist' where action = 'sleep';
alter table public.purge_reviews
  add constraint purge_reviews_action_check
  check (action in ('keep', 'pin', 'blacklist', 'complete'));

alter table public.vault_draw_events drop constraint vault_draw_events_event_type_check;
update public.vault_draw_events set event_type = 'blacklisted' where event_type = 'slept';
alter table public.vault_draw_events
  add constraint vault_draw_events_event_type_check check (event_type in (
    'opened_on_steam', 'pinned', 'unpinned', 'drew_again', 'hidden_for_session',
    'snoozed_7_days', 'snoozed_30_days', 'blacklisted', 'marked_completed',
    'restored', 'liked', 'disliked', 'reroll_too_long', 'reroll_wrong_mood',
    'reroll_played_enough', 'reroll_not_interested', 'reroll_not_tonight'
  ));

-- vault_events is a separate retained history/read-model source with a free
-- text action. Preserve its meaning under the new undated vocabulary.
update public.vault_events set action = 'blacklisted' where action = 'slept';

do $$
begin
  if exists (
    select 1 from public.algorithm_weights old_weight
    join public.algorithm_weights new_weight
      on new_weight.key = case old_weight.key
        when 'event:slept' then 'event:blacklisted'
        when 'decision:sleep' then 'decision:blacklist'
      end
    where old_weight.key in ('event:slept', 'decision:sleep')
  ) then
    raise exception 'blacklist algorithm-weight key collision';
  end if;
end
$$;

update public.algorithm_weights
set key = case key
  when 'event:slept' then 'event:blacklisted'
  when 'decision:sleep' then 'decision:blacklist'
end
where key in ('event:slept', 'decision:sleep');

create or replace function public.set_user_game_status(
  p_user_id uuid,
  p_game_id uuid,
  p_status text
) returns public.user_games
language plpgsql
set search_path to ''
as $function$
declare
  updated_game public.user_games;
begin
  if p_status not in ('Not Started', 'Sampled', 'In Progress', 'Blacklisted', 'Completed') then
    raise exception 'INVALID_GAME_STATUS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into updated_game
  from public.user_games
  where id = p_game_id and user_id = p_user_id
  for update;
  if updated_game.id is null then raise exception 'GAME_NOT_FOUND'; end if;

  if updated_game.status is distinct from p_status then
    update public.user_games
    set previous_active_status = case
          when p_status in ('Blacklisted', 'Completed')
            and status not in ('Blacklisted', 'Completed') then status
          when p_status in ('Blacklisted', 'Completed') then
            coalesce(previous_active_status, 'Not Started')
          else previous_active_status
        end,
        status = p_status,
        completed_at = case when p_status = 'Completed' then now() else null end,
        updated_at = now()
    where id = p_game_id and user_id = p_user_id
    returning * into updated_game;
  end if;

  if p_status in ('Blacklisted', 'Completed') then
    delete from public.user_game_pins
    where user_id = p_user_id and game_id = p_game_id and scope = 'library';
    update public.user_vault_state
    set current_game_id = null, updated_at = now()
    where user_id = p_user_id and current_game_id = p_game_id;
  end if;
  return updated_game;
end;
$function$;

create or replace function public.restore_user_game_active(
  p_user_id uuid,
  p_game_id uuid
) returns public.user_games
language plpgsql
set search_path to ''
as $function$
declare
  updated_game public.user_games;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into updated_game
  from public.user_games
  where id = p_game_id and user_id = p_user_id
  for update;
  if updated_game.id is null then raise exception 'GAME_NOT_ARCHIVED'; end if;

  if updated_game.status in ('Blacklisted', 'Completed') then
    update public.user_games
    set status = coalesce(previous_active_status, 'Not Started'),
        completed_at = null,
        previous_active_status = null,
        updated_at = now()
    where id = p_game_id and user_id = p_user_id
    returning * into updated_game;
  end if;
  return updated_game;
end;
$function$;

create or replace function public.apply_user_purge_decision(
  p_user_id uuid,
  p_game_id uuid,
  p_action text,
  p_category text default null
) returns jsonb
language plpgsql
set search_path to ''
as $function$
declare
  target_game public.user_games;
  saved_review public.purge_reviews;
  ignored_state jsonb;
begin
  if p_action not in ('keep', 'pin', 'blacklist', 'complete') then raise exception 'INVALID_PURGE_ACTION'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select * into target_game from public.user_games
  where id = p_game_id and user_id = p_user_id and ownership = 'Owned' for update;
  if target_game.id is null then raise exception 'GAME_NOT_REVIEWABLE'; end if;

  select * into saved_review from public.purge_reviews
  where user_id = p_user_id and game_id = p_game_id and (
    reviewed_at >= now() - interval '30 seconds'
    or (action = 'keep' and target_game.status in ('Not Started','Sampled','In Progress') and reviewed_at >= now() - interval '180 days')
    or (action = 'blacklist' and target_game.status = 'Blacklisted')
    or (action = 'complete' and target_game.status = 'Completed')
    or (action = 'pin' and exists (
      select 1 from public.user_game_pins where user_id = p_user_id and game_id = p_game_id
    ))
  ) order by reviewed_at desc limit 1;
  if saved_review.id is not null then
    return jsonb_build_object('review', jsonb_build_object(
      'id',saved_review.id,'gameId',saved_review.game_id,'action',saved_review.action,'reviewedAt',saved_review.reviewed_at
    ), 'deduplicated',true,'reconciled',true);
  end if;
  if target_game.status not in ('Not Started','Sampled','In Progress') then raise exception 'GAME_NOT_REVIEWABLE'; end if;

  if p_action = 'pin' then
    ignored_state := public.apply_user_vault_action(p_user_id,'pinned',p_game_id,'{}'::jsonb);
  elsif p_action = 'blacklist' then
    target_game := public.set_user_game_status(p_user_id,p_game_id,'Blacklisted');
  elsif p_action = 'complete' then
    target_game := public.set_user_game_status(p_user_id,p_game_id,'Completed');
  end if;
  insert into public.purge_reviews (
    user_id,game_id,action,playtime_minutes_at_review,progress_at_review,last_played_at_review
  ) values (
    p_user_id,p_game_id,p_action,greatest(0,round(target_game.hours_played*60)::integer),
    target_game.completion_percentage,target_game.last_played_at
  ) returning * into saved_review;
  return jsonb_build_object('review',jsonb_build_object(
    'id',saved_review.id,'gameId',saved_review.game_id,'action',saved_review.action,'reviewedAt',saved_review.reviewed_at
  ),'deduplicated',false,'reconciled',false);
end;
$function$;

create or replace function public.undo_user_purge_decision(
  p_user_id uuid,
  p_review_id uuid
) returns boolean
language plpgsql
set search_path to ''
as $function$
declare
  saved_review public.purge_reviews;
  ignored_game public.user_games;
  ignored_state jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  select * into saved_review from public.purge_reviews
  where id=p_review_id and user_id=p_user_id for update;
  if saved_review.id is null then return false; end if;
  if saved_review.action='pin' then
    ignored_state := public.apply_user_vault_action(p_user_id,'unpinned',saved_review.game_id,'{}'::jsonb);
  elsif saved_review.action in ('blacklist','complete') then
    ignored_game := public.restore_user_game_active(p_user_id,saved_review.game_id);
  end if;
  delete from public.purge_reviews where id=p_review_id and user_id=p_user_id;
  return true;
end;
$function$;

create or replace function public.request_user_game_review(p_user_id uuid,p_game_ids uuid[])
returns integer language plpgsql security definer set search_path to ''
as $function$
declare v_updated integer;
begin
  if p_user_id is null then raise exception 'INVALID_REVIEW_USER'; end if;
  if p_game_ids is null or cardinality(p_game_ids)=0 then return 0; end if;
  if cardinality(p_game_ids)>500 then raise exception 'REVIEW_BATCH_TOO_LARGE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  update public.user_games set review_requested_at=now(),updated_at=now()
  where user_id=p_user_id and id=any(p_game_ids) and ownership='Owned'
    and status in ('Not Started','Sampled','In Progress');
  get diagnostics v_updated=row_count;
  return v_updated;
end;
$function$;

create or replace function public.remove_user_family_member_games(
  p_user_id uuid,p_steam_id text,p_retained_appids bigint[] default '{}'
) returns integer language plpgsql security definer set search_path to ''
as $function$
declare removed integer;
begin
  if p_user_id is null then raise exception 'INVALID_IMPORT_USER'; end if;
  update public.user_games set ownership='Wishlist',family_verified_at=null,updated_at=now()
  where user_id=p_user_id and access_source='family' and family_owner_steam_id=p_steam_id
    and not (catalog_steam_appid=any(coalesce(p_retained_appids,'{}')))
    and (coalesce(notes,'')<>'' or status in ('Completed','Blacklisted'));
  with deleted as (
    delete from public.user_games
    where user_id=p_user_id and access_source='family' and family_owner_steam_id=p_steam_id
      and not (catalog_steam_appid=any(coalesce(p_retained_appids,'{}'))) and ownership='Owned'
    returning 1
  ) select count(*) into removed from deleted;
  return coalesce(removed,0);
end;
$function$;

create view public.user_games_with_catalog as
select g.id,g.user_id,c.name as title,
  case when cardinality(c.genres)>0 then array_to_string(c.genres,' / ') else 'Unknown' end as genre,
  'Steam'::text as store,g.ownership,g.status,
  case when coalesce(c.review_total,0)>0 then round(c.review_positive::numeric*10.0/c.review_total::numeric)::integer else 0 end as rating,
  g.hours_played,g.completion_percentage,'Medium'::text as priority,g.date_added,g.notes,
  c.steam_appid::text as steam_appid,g.created_at,g.updated_at,g.last_played_at,g.completed_at,
  g.completion_suggestion_dismissed_at,g.completion_suggestion_dismissed_playtime,
  c.main_story_minutes,c.main_extras_minutes,c.completionist_minutes,c.duration_source,
  c.duration_source_updated_at,c.duration_confidence,g.previous_active_status,
  q.steam_appid is not null as is_quarantined,q.reason as quarantine_reason,
  c.steam_appid as catalog_steam_appid,c.capsule_url,c.header_url,c.price_currency,c.price_initial,
  c.price_final,c.discount_percent,c.is_free,c.duration_kind,c.tags as steam_tags,
  c.platform_windows,c.platform_mac,c.platform_linux,c.deck_compatibility,c.review_positive,
  c.review_negative,c.review_total,c.release_date,c.duration_status,c.tags_status,c.short_description,
  g.last_observed_played_at,g.recency_source,g.recency_evidence_at,g.observed_playtime_minutes,
  g.review_requested_at,c.categories as steam_categories,g.access_source,g.family_owner_steam_id,g.family_verified_at
from public.user_games g
join public.catalog_games c on c.steam_appid=g.catalog_steam_appid
left join public.catalog_game_quarantine q on q.steam_appid=c.steam_appid and q.review_status='excluded';

comment on view public.user_games_with_catalog is
  'Application read model joining per-user state to canonical catalogue metadata.';
revoke all on public.user_games_with_catalog from public,anon,authenticated;
grant select on public.user_games_with_catalog to service_role;

commit;
