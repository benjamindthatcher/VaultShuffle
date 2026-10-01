-- Preserve the existing password-protected owner's evidence queue on V2.
-- A response records a link/note only; it never classifies or changes durations.
begin;
create function catalog.duration_review_queue()
returns jsonb language sql stable security definer
set search_path = pg_catalog
as $$
  with candidates as materialized (
    select g.id,g.steam_app_id,g.title,m.header_image_url,m.capsule_image_url,
      f.duration_status,f.duration_kind,f.duration_source,f.review_total,
      coalesce(s.import_count,0) as users_that_imported,
      r.reviewed_at
    from catalog.games g
    left join catalog.game_metadata m on m.game_id=g.id
    left join catalog.game_features f on f.game_id=g.id
    left join catalog.game_sightings s on s.steam_app_id=g.steam_app_id
    left join catalog.review_decisions r on r.source_relation='catalog_duration_reviews'
      and r.source_record_key=g.steam_app_id::text and r.decision_kind='duration'
    where f.main_duration_minutes is null and f.extras_duration_minutes is null
      and f.completion_duration_minutes is null
  ), page as (
    select jsonb_build_object('steam_appid',steam_app_id,'name',title,
      'header_url',header_image_url,'capsule_url',capsule_image_url,
      'duration_status',duration_status,'duration_kind',duration_kind,
      'duration_source',duration_source,'users_that_imported',users_that_imported,
      'review_total',review_total) as game,
      users_that_imported,review_total,steam_app_id
    from candidates where reviewed_at is null
    order by users_that_imported desc,review_total desc nulls last,steam_app_id limit 100
  )
  select jsonb_build_object('total',(select count(*) from candidates),
    'remaining',(select count(*) from candidates where reviewed_at is null),
    'games',coalesce((select jsonb_agg(game order by users_that_imported desc,
      review_total desc nulls last,steam_app_id) from page),'[]'::jsonb));
$$;

create function catalog.save_duration_review(p_app_id bigint,p_text text,p_kind text,p_url text)
returns void language plpgsql security definer
set search_path = pg_catalog
as $$
declare v_game_id integer;
begin
  if p_app_id is null or p_app_id<1 or p_app_id>4294967295
    or p_text is null or length(btrim(p_text)) not between 1 and 2000
    or p_kind is null or p_kind not in ('note','hltb_url')
    or (p_kind='note' and p_url is not null)
    or (p_kind='hltb_url' and (p_url is null or
      p_url !~ '^https?://(www\.)?howlongtobeat\.com/game/[0-9]+/?([?#].*)?$')) then
    raise exception 'Invalid duration review' using errcode='22023';
  end if;
  -- Serialise save/undo for this game; no new lease or review history.
  select g.id into v_game_id from catalog.games g where g.steam_app_id=p_app_id for update;
  if v_game_id is null or not exists(select 1 from catalog.game_features f
    where f.game_id=v_game_id and f.main_duration_minutes is null
      and f.extras_duration_minutes is null and f.completion_duration_minutes is null)
    or exists(select 1 from catalog.review_decisions r where r.source_relation='catalog_duration_reviews'
      and r.source_record_key=p_app_id::text and r.reviewed_at is not null) then
    raise exception 'Game is no longer waiting for a duration review' using errcode='55000';
  end if;
  insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,
    source_record_key,source,precedence_rank,decision_status,response_text,response_kind,
    source_url,reviewed_at,created_at,updated_at)
  values(v_game_id,p_app_id,'duration','catalog_duration_reviews',p_app_id::text,
    'manual_duration_review',90,'retained',btrim(p_text),p_kind,p_url,now(),now(),now())
  on conflict(source_relation,source_record_key) do update set response_text=excluded.response_text,
    response_kind=excluded.response_kind,source_url=excluded.source_url,
    reviewed_at=excluded.reviewed_at,updated_at=excluded.updated_at;
end;
$$;

create function catalog.undo_duration_review(p_app_id bigint)
returns void language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if p_app_id is null or p_app_id<1 or p_app_id>4294967295 then
    raise exception 'Invalid duration review' using errcode='22023';
  end if;
  perform 1 from catalog.games where steam_app_id=p_app_id for update;
  delete from catalog.review_decisions where source_relation='catalog_duration_reviews'
    and source_record_key=p_app_id::text and decision_kind='duration';
end;
$$;
revoke all on function catalog.duration_review_queue() from public,vault_app,vault_worker;
revoke all on function catalog.save_duration_review(bigint,text,text,text) from public,vault_app,vault_worker;
revoke all on function catalog.undo_duration_review(bigint) from public,vault_app,vault_worker;
grant execute on function catalog.duration_review_queue() to vault_worker;
grant execute on function catalog.save_duration_review(bigint,text,text,text) to vault_worker;
grant execute on function catalog.undo_duration_review(bigint) to vault_worker;
commit;
