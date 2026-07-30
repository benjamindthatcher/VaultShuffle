-- These AppIDs are confirmed persistent multiplayer, live-service, sandbox,
-- social, competitive, or incremental experiences without a meaningful
-- completion endpoint. Keep this list explicit: broad genre matching has
-- previously misclassified conventional games.
with confirmed_endless(steam_appid, reason) as (
  values
    (8500::bigint, 'Persistent MMORPG'),
    (240, 'Persistent competitive multiplayer game'),
    (4000, 'Open-ended sandbox platform'),
    (440, 'Persistent competitive multiplayer game'),
    (113400, 'Persistent online live-service game'),
    (206480, 'Persistent MMORPG'),
    (215280, 'Persistent MMORPG'),
    (212740, 'Persistent MMORPG'),
    (218230, 'Persistent MMOFPS'),
    (224260, 'Replayable online co-op game without a completion endpoint'),
    (230410, 'Persistent online live-service game'),
    (252490, 'Open-ended online survival sandbox'),
    (252950, 'Persistent competitive multiplayer game'),
    (284160, 'Open-ended vehicle sandbox'),
    (295110, 'Open-ended online survival game'),
    (322170, 'Open-ended user-generated rhythm platform'),
    (334230, 'Persistent online social-deduction game'),
    (346110, 'Open-ended survival sandbox'),
    (359550, 'Persistent competitive multiplayer game'),
    (362300, 'Persistent online survival test environment'),
    (386180, 'Persistent online live-service game'),
    (407530, 'Persistent battle-royale survival game'),
    (438100, 'Open-ended social platform'),
    (476480, 'Persistent VR MMO'),
    (550900, 'Persistent MMORPG'),
    (625340, 'Open-ended online survival sandbox'),
    (670290, 'Persistent online sports game'),
    (700330, 'Persistent online multiplayer game'),
    (761890, 'Persistent MMORPG'),
    (1063730, 'Persistent MMORPG'),
    (1134700, 'Persistent online sandbox MMORPG'),
    (1172470, 'Persistent battle-royale live-service game'),
    (1172620, 'Open-ended online live-service game'),
    (1284410, 'Persistent online card game'),
    (1273710, 'Persistent online multiplayer game'),
    (1343370, 'Persistent MMORPG'),
    (1343400, 'Persistent MMORPG'),
    (1408720, 'Persistent competitive multiplayer game'),
    (1454400, 'Open-ended incremental game'),
    (1476970, 'Open-ended idle MMORPG'),
    (1533390, 'Persistent social multiplayer game'),
    (1590320, 'Persistent battle-royale game'),
    (1674470, 'Persistent MMORPG'),
    (1694200, 'Persistent MMORPG'),
    (1824220, 'Persistent competitive multiplayer game'),
    (1891700, 'Open-ended incremental game'),
    (2073850, 'Persistent competitive multiplayer game'),
    (2139460, 'Open-ended online survival live-service game'),
    (2180600, 'Persistent MMORPG'),
    (2507950, 'Persistent competitive live-service game'),
    (2551020, 'Replayable online co-op game without a completion endpoint'),
    (2881650, 'Replayable online co-op game without a completion endpoint'),
    (4124950, 'Persistent MMORPG'),
    (4584110, 'Persistent MMORPG')
),
updated as (
  update public.catalog_games c
  set duration_kind = 'endless',
      duration_status = 'ready',
      main_story_minutes = null,
      main_extras_minutes = null,
      completionist_minutes = null,
      duration_source = 'classification',
      duration_source_game_id = null,
      duration_source_updated_at = now(),
      duration_confidence = 'high',
      updated_at = now()
  from confirmed_endless e
  where c.steam_appid = e.steam_appid
  returning c.steam_appid
)
update public.game_duration_jobs j
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where j.steam_app_id in (select steam_appid from updated);
-- Version aligned with the production Supabase migration history.
