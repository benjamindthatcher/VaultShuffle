-- Fixed public candidate projection; internal review decisions stay private.
-- Hydration is a second bounded read of shared catalogue tables only.
create function catalog.guest_catalogue_candidates()
returns table(game_id integer,steam_appid bigint,genres jsonb,tags jsonb,popularity_rank bigint,review_total bigint)
language sql stable security definer set search_path=pg_catalog as $$
  select g.id,g.steam_app_id,m.genres,m.weighted_tags,f.popularity_rank,f.review_total::bigint
  from catalog.games g join catalog.game_metadata m on m.game_id=g.id join catalog.game_features f on f.game_id=g.id
  where g.game_type='game' and g.lifecycle_status='active' and g.steam_app_id is not null
    and m.genres is not null and m.weighted_tags is not null and nullif(btrim(m.short_description),'') is not null
    and (m.header_image_url is not null or m.capsule_image_url is not null)
    and (f.main_duration_minutes is not null or f.duration_kind='endless') and f.review_total>=50
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
  order by f.popularity_rank asc nulls last,f.review_total desc nulls last,g.steam_app_id asc limit 3000
$$;
revoke all on function catalog.guest_catalogue_candidates() from public,vault_app,vault_worker;
grant execute on function catalog.guest_catalogue_candidates() to vault_app;
