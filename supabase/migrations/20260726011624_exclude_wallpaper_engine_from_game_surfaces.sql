grant select, insert, update, delete
on public.catalog_game_quarantine
to service_role;

insert into public.catalog_game_quarantine (
  steam_appid,
  name,
  steam_type,
  matched_rule,
  reason,
  review_status,
  source,
  review_notes,
  reviewed_at,
  last_detected_at,
  updated_at
)
values (
  431960,
  'Wallpaper Engine',
  'game',
  'manual_appid:431960',
  'Desktop wallpaper software; excluded from game recommendation and review surfaces.',
  'excluded',
  'manual',
  'Manually confirmed as a non-game utility.',
  now(),
  now(),
  now()
)
on conflict (steam_appid) do update
set name = excluded.name,
    steam_type = excluded.steam_type,
    matched_rule = excluded.matched_rule,
    reason = excluded.reason,
    review_status = 'excluded',
    source = 'manual',
    review_notes = excluded.review_notes,
    reviewed_at = now(),
    last_detected_at = now(),
    updated_at = now();
