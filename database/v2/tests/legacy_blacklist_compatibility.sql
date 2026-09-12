-- Disposable PG17 compatibility fixture for the current public.* runtime.
-- It builds only the schema surface used by the migration, seeds synthetic
-- Sleep data, applies the local migration, and rolls the behavioral rows back.
\set ON_ERROR_STOP on

do $$
begin
  if to_regrole('anon') is null then create role anon nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
  if to_regrole('service_role') is null then create role service_role nologin; end if;
end
$$;

create table public.catalog_games (
  steam_appid bigint primary key, name text not null, genres text[] not null default '{}',
  review_total integer, review_positive integer, capsule_url text, header_url text,
  price_currency text, price_initial integer, price_final integer, discount_percent integer,
  is_free boolean, main_story_minutes integer, main_extras_minutes integer,
  completionist_minutes integer, duration_source text, duration_source_updated_at timestamptz,
  duration_confidence text, duration_kind text, tags text[], platform_windows boolean,
  platform_mac boolean, platform_linux boolean, deck_compatibility text,
  review_negative integer, release_date date, duration_status text, tags_status text,
  short_description text, categories text[]
);

create table public.user_games (
  id uuid primary key, user_id uuid not null, catalog_steam_appid bigint not null references public.catalog_games,
  ownership text not null default 'Owned', status text not null default 'Not Started', rating integer not null default 0,
  hours_played numeric not null default 0, completion_percentage integer not null default 0,
  priority text not null default 'Medium', date_added text, notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  last_played_at timestamptz, completed_at timestamptz, slept_at timestamptz,
  completion_suggestion_dismissed_at timestamptz,
  completion_suggestion_dismissed_playtime numeric, previous_active_status text,
  last_observed_played_at timestamptz, recency_source text, recency_evidence_at timestamptz,
  observed_playtime_minutes integer, review_requested_at timestamptz, access_source text not null default 'owned',
  family_owner_steam_id text, family_verified_at timestamptz,
  unique (user_id, catalog_steam_appid),
  constraint user_games_status_check check (status in ('Not Started','Sampled','In Progress','Slept','Completed'))
);

create table public.catalog_game_quarantine (
  steam_appid bigint, review_status text, reason text
);
create table public.user_game_pins (
  user_id uuid not null, game_id uuid not null, scope text not null
);
create table public.user_vault_state (
  user_id uuid primary key, current_game_id uuid, updated_at timestamptz not null default now()
);
create table public.purge_reviews (
  id uuid primary key, user_id uuid not null, game_id uuid not null, action text not null,
  reviewed_at timestamptz not null default now(), playtime_minutes_at_review integer not null,
  progress_at_review integer, last_played_at_review timestamptz,
  constraint purge_reviews_action_check check (action in ('keep','pin','sleep','complete'))
);
create table public.vault_draw_events (
  id uuid primary key, event_type text not null,
  constraint vault_draw_events_event_type_check check (event_type in (
    'opened_on_steam','pinned','unpinned','drew_again','hidden_for_session',
    'snoozed_7_days','snoozed_30_days','slept','marked_completed','restored',
    'liked','disliked','reroll_too_long','reroll_wrong_mood','reroll_played_enough',
    'reroll_not_interested','reroll_not_tonight'
  ))
);
create table public.vault_events (id uuid primary key, action text not null);
create table public.algorithm_weights (
  key text primary key, positive numeric not null, total numeric not null, note text
);
create table public.user_snoozed_games (
  user_id uuid not null, game_id uuid not null, until_at timestamptz not null,
  primary key (user_id, game_id)
);

create function public.upsert_user_steam_games(uuid,jsonb,text)
returns setof public.user_games language plpgsql set search_path to '' as $function$
begin
/*
    completed_at,
    slept_at,
    completion_suggestion_dismissed_at,
    input.completed_at,
    input.slept_at,
    input.completion_suggestion_dismissed_at,
    completed_at timestamptz,
    slept_at timestamptz,
    completion_suggestion_dismissed_at timestamptz,
    completed_at = public.user_games.completed_at,
    slept_at = public.user_games.slept_at,
    completion_suggestion_dismissed_at =
*/
  return query select * from public.user_games where false;
end
$function$;

create function public.complete_manual_profile_security(text,uuid,text,text,text,text,timestamptz,text)
returns void language plpgsql set search_path to '' as $function$
begin
/*
      when target_games.status = 'Completed' or source_games.status = 'Completed' then 'Completed'
      when source_games.status <> 'Not Started' then source_games.status
    completed_at = greatest(target_games.completed_at, source_games.completed_at),
    slept_at = greatest(target_games.slept_at, source_games.slept_at),
    completion_suggestion_dismissed_at =
*/
  return;
end
$function$;

create view public.user_games_with_catalog as
select g.*, c.name from public.user_games g join public.catalog_games c on c.steam_appid = g.catalog_steam_appid;
grant select on public.user_games_with_catalog to service_role;

insert into public.catalog_games (steam_appid,name,genres) values (10,'Ten','{Action}');
insert into public.user_games (
  id,user_id,catalog_steam_appid,status,hours_played,notes,slept_at,previous_active_status
) values (
  '20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',10,
  'Slept',12.5,'keep note','2026-01-01 00:00:00+00','In Progress'
);
insert into public.purge_reviews (
  id,user_id,game_id,action,playtime_minutes_at_review
) values (
  '30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001','sleep',750
);
insert into public.vault_draw_events values ('40000000-0000-4000-8000-000000000001','slept');
insert into public.vault_events values ('50000000-0000-4000-8000-000000000001','slept');
insert into public.algorithm_weights values
  ('event:slept',4,9,'event tuned'),('decision:sleep',3,8,'decision tuned');
insert into public.user_snoozed_games values (
  '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
  '2027-01-01 00:00:00+00'
);

\ir ../../../supabase/migrations/20260912192336_replace_sleep_with_blacklist.sql

do $$
declare
  v_game public.user_games;
  v_updated_at timestamptz;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='user_games' and column_name='slept_at'
  ) then raise exception 'slept_at remains'; end if;
  if (select status from public.user_games limit 1) <> 'Blacklisted' then
    raise exception 'Slept row was not converted';
  end if;
  if (select hours_played from public.user_games limit 1) <> 12.5
     or (select notes from public.user_games limit 1) <> 'keep note' then
    raise exception 'Blacklist migration changed playtime or notes';
  end if;
  if (select action from public.purge_reviews limit 1) <> 'blacklist'
     or (select event_type from public.vault_draw_events limit 1) <> 'blacklisted'
     or (select action from public.vault_events limit 1) <> 'blacklisted' then
    raise exception 'legacy Blacklist vocabulary was not converted';
  end if;
  if (select positive from public.algorithm_weights where key='event:blacklisted') <> 4
     or (select total from public.algorithm_weights where key='decision:blacklist') <> 8
     or (select note from public.algorithm_weights where key='event:blacklisted') <> 'event tuned' then
    raise exception 'operator tuning was not preserved';
  end if;
  if (select count(*) from public.user_snoozed_games) <> 1 then
    raise exception 'separate Vault snooze changed';
  end if;

  select * into v_game from public.set_user_game_status(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','Blacklisted'
  );
  v_updated_at := v_game.updated_at;
  perform public.set_user_game_status(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001','Blacklisted'
  );
  if (select updated_at from public.user_games limit 1) <> v_updated_at then
    raise exception 'repeat Blacklist changed the row';
  end if;

  perform public.restore_user_game_active(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  );
  if (select status from public.user_games limit 1) <> 'In Progress' then
    raise exception 'Reactivate did not restore active status';
  end if;
  perform public.restore_user_game_active(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001'
  );

  begin
    perform public.set_user_game_status(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001','Slept'
    );
    raise exception 'Slept status unexpectedly accepted';
  exception when others then
    if sqlerrm <> 'INVALID_GAME_STATUS' then raise; end if;
  end;
  begin
    perform public.set_user_game_status(
      '10000000-0000-4000-8000-000000000099',
      '20000000-0000-4000-8000-000000000001','Blacklisted'
    );
    raise exception 'cross-user mutation unexpectedly accepted';
  exception when others then
    if sqlerrm <> 'GAME_NOT_FOUND' then raise; end if;
  end;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and pg_get_functiondef(p.oid) ~* '(slept_at|90[[:space:]]+days|automatic[[:space:]_-]*restore)'
  ) then raise exception 'timed Sleep reference remains in public functions'; end if;
end
$$;

select 'legacy blacklist compatibility ok' as result;
