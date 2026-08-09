-- The shared catalogue now owns Steam app metadata. Retire legacy worker jobs
-- already covered by a useful catalogue snapshot so the fallback queue only
-- contains genuinely uncatalogued user AppIDs.
update public.steam_app_metadata m
set title = coalesce(nullif(c.name, ''), nullif(m.title, '')),
    genre = case
      when cardinality(coalesce(c.genres, array[]::text[])) > 0 then array_to_string(c.genres, ' / ')
      when m.genre is not null and m.genre not in ('', 'Unknown') then m.genre
      else 'Unknown'
    end,
    rating = case
      when coalesce(c.review_total, 0) > 0
        then round(c.review_positive::numeric * 10 / c.review_total)::integer
      else coalesce(m.rating, 0)
    end,
    review_total = greatest(coalesce(m.review_total, 0), coalesce(c.review_total, 0)),
    review_positive = greatest(coalesce(m.review_positive, 0), coalesce(c.review_positive, 0)),
    capsule_url = coalesce(c.capsule_url, m.capsule_url),
    header_url = coalesce(c.header_url, m.header_url),
    price_currency = case when c.price_currency = 'USD' then 'USD' else m.price_currency end,
    price_initial = case when c.price_currency = 'USD' then c.price_initial else m.price_initial end,
    price_final = case when c.price_currency = 'USD' then c.price_final else m.price_final end,
    discount_percent = case when c.price_currency = 'USD' then c.discount_percent else m.discount_percent end,
    is_free = coalesce(c.is_free, false) or coalesce(m.is_free, false),
    status = 'ready',
    failure_count = 0,
    last_error = null,
    checked_at = now(),
    next_attempt_at = null,
    processing_started_at = null,
    updated_at = now()
from public.catalog_games c
where c.steam_appid::text = m.steam_appid
  and m.status in ('pending', 'processing', 'failed')
  and c.metadata_fetched_at is not null
  and (
    nullif(c.name, '') is not null
    or cardinality(coalesce(c.genres, array[]::text[])) > 0
    or coalesce(c.review_total, 0) > 0
    or c.capsule_url is not null
    or c.header_url is not null
  );
