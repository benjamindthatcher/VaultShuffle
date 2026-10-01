-- Existing Wishlist discovery lanes; only public IDs cross the private
-- quarantine boundary. Hydration uses the app's bounded shared catalogue read.
create function catalog.wishlist_discovery_candidates(p_lane text)
returns table(game_id integer)
language sql stable security definer set search_path=pg_catalog as $$
  select g.id
  from catalog.games g join catalog.game_metadata m on m.game_id=g.id
  join catalog.game_features f on f.game_id=g.id
  where p_lane in('discovery','short','acclaimed','budget')
    and g.game_type='game' and g.lifecycle_status='active' and g.steam_app_id is not null
    and m.genres is not null and m.weighted_tags is not null
    and (m.header_image_url is not null or m.capsule_image_url is not null)
    and f.review_total>=case when p_lane in('acclaimed','budget') then 500 else 50 end
    and f.review_positive>=f.review_total*0.7
    and (p_lane<>'short' or f.main_duration_minutes between 1 and 600)
    and (p_lane<>'budget' or exists(select 1 from catalog.offers o join catalog.offer_prices p on p.offer_id=o.id
      where o.game_id=g.id and o.region_code='US' and p.is_current and p.currency='USD' and p.price_final_cents between 1 and 2600))
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id
      and d.decision_kind='quarantine' and d.decision_status='excluded')
  order by case when p_lane='discovery' then f.popularity_rank end asc nulls last,
    f.review_total desc nulls last,g.steam_app_id
  limit case when p_lane='discovery' then 6000 when p_lane in('short','acclaimed','budget') then 3000 else 0 end
$$;
revoke all on function catalog.wishlist_discovery_candidates(text) from public,vault_app,vault_worker;
grant execute on function catalog.wishlist_discovery_candidates(text) to vault_app;
