-- Correct known Steam/IGDB title mismatches and retry them after alias review.
with canonical_titles(steam_app_id, canonical_name, search_title, release_year, notes) as (
  values
    (10190::bigint, 'Call of Duty: Modern Warfare 2', 'Call of Duty: Modern Warfare 2', 2009, 'Steam title includes a disambiguating year.'),
    (1938090::bigint, 'Call of Duty: Modern Warfare II', 'Call of Duty: Modern Warfare II', 2022, 'Disambiguated from the 2009 release by release year.'),
    (34440::bigint, 'Sid Meier''s Civilization IV', 'Sid Meier''s Civilization IV', 2005, 'Use the complete IGDB canonical title.'),
    (34460::bigint, 'Sid Meier''s Civilization IV: Beyond the Sword', 'Sid Meier''s Civilization IV: Beyond the Sword', 2007, 'Use the complete IGDB expansion title.'),
    (47830::bigint, 'Medal of Honor', 'Medal of Honor', 2010, 'Disambiguated from earlier releases by release year.'),
    (56437::bigint, 'Warhammer 40,000: Dawn of War II - Retribution', 'Warhammer 40,000: Dawn of War II - Retribution', 2011, 'Use IGDB punctuation for the expansion title.'),
    (4584110::bigint, 'Soul Land: Awakening World', 'Soul Land: Awakening World', 2026, 'New release retained for an explicit provider retry.')
)
update public.catalog_games c
set name = canonical_titles.canonical_name,
    normalized_name = trim(regexp_replace(
      lower(regexp_replace(canonical_titles.canonical_name, '[^a-zA-Z0-9]+', ' ', 'g')),
      '\s+',
      ' ',
      'g'
    )),
    updated_at = now()
from canonical_titles
where c.steam_appid = canonical_titles.steam_app_id;

insert into public.game_duration_aliases (
  steam_app_id,
  search_title,
  release_year,
  review_status,
  notes
)
values
  (10190, 'Call of Duty: Modern Warfare 2', 2009, 'approved', 'Steam title includes a disambiguating year.'),
  (1938090, 'Call of Duty: Modern Warfare II', 2022, 'approved', 'Disambiguated from the 2009 release by release year.'),
  (34440, 'Sid Meier''s Civilization IV', 2005, 'approved', 'Use the complete IGDB canonical title.'),
  (34460, 'Sid Meier''s Civilization IV: Beyond the Sword', 2007, 'approved', 'Use the complete IGDB expansion title.'),
  (47830, 'Medal of Honor', 2010, 'approved', 'Disambiguated from earlier releases by release year.'),
  (56437, 'Warhammer 40,000: Dawn of War II - Retribution', 2011, 'approved', 'Use IGDB punctuation for the expansion title.'),
  (4584110, 'Soul Land: Awakening World', 2026, 'approved', 'New release retained for an explicit provider retry.')
on conflict (steam_app_id) do update
set search_title = excluded.search_title,
    release_year = excluded.release_year,
    review_status = excluded.review_status,
    notes = excluded.notes,
    updated_at = now();

update public.game_duration_jobs
set status = 'retry',
    priority = 100,
    attempts = 0,
    next_attempt_at = now(),
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where steam_app_id in (10190, 1938090, 34440, 34460, 47830, 56437, 4584110);

update public.game_duration_estimates
set next_refresh_at = now(),
    updated_at = now()
where steam_app_id in (10190, 1938090, 34440, 34460, 47830, 56437, 4584110)
  and match_status = 'not_found';
-- Version aligned with the production Supabase migration history.
