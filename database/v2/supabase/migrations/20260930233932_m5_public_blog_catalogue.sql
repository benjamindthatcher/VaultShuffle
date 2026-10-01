-- Public article data only. Keep private quarantine provenance and all tenant
-- facts behind their existing boundaries; expose no general query endpoint.
create function catalog.blog_game_candidates(p_appids bigint[],p_min_reviews integer,p_deck integer,
  p_duration text,p_main_min integer,p_main_max integer,p_player text,p_limit integer,p_sort boolean,p_tags boolean)
returns table(steam_appid bigint,name text,header_url text,main_story_minutes integer,completionist_minutes integer,
  deck_compatibility smallint,review_total bigint,review_positive bigint,player_mode text,release_date date,tags jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select g.steam_app_id,g.title,m.header_image_url,f.main_duration_minutes,f.completion_duration_minutes,
    f.deck_compatibility_detail,f.review_total::bigint,f.review_positive::bigint,f.player_mode,m.release_date,
    case when p_tags then m.weighted_tags else null end
  from catalog.games g left join catalog.game_metadata m on m.game_id=g.id left join catalog.game_features f on f.game_id=g.id
  where g.lifecycle_status='active' and g.steam_app_id is not null
    and p_limit between 1 and 2000 and (p_appids is null or cardinality(p_appids)<=1000)
    and (p_appids is null or g.steam_app_id=any(p_appids))
    and (p_min_reviews is null or f.review_total>=p_min_reviews)
    and (p_deck is null or f.deck_compatibility_detail>=p_deck)
    and (p_duration is null or f.duration_kind=p_duration)
    and (p_main_min is null or f.main_duration_minutes>=p_main_min)
    and (p_main_max is null or f.main_duration_minutes<=p_main_max)
    and (p_player is null or f.player_mode=p_player)
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id
      and d.decision_kind='quarantine' and d.decision_status='excluded')
  order by case when p_sort then f.review_total end desc nulls last,g.steam_app_id
  limit greatest(0,least(p_limit,2000))
$$;
revoke all on function catalog.blog_game_candidates(bigint[],integer,integer,text,integer,integer,text,integer,boolean,boolean) from public,vault_app,vault_worker;
grant execute on function catalog.blog_game_candidates(bigint[],integer,integer,text,integer,integer,text,integer,boolean,boolean) to vault_app;
