-- Synthetic pre-correction rows. Run after Wishlist and before HLTB migration.
insert into catalog.games(steam_app_id,title,normalized_sort_title)
select 3999999000+n, 'HLTB legacy fixture '||n, 'hltb legacy fixture '||n from generate_series(1,5) n;
insert into catalog.game_features(game_id,main_duration_minutes,extras_duration_minutes,completion_duration_minutes,
  duration_source,duration_source_game_id,duration_source_updated_at,duration_confidence,duration_confidence_label,
  duration_kind,duration_status,duration_manual_override,popularity_source,popularity_rank)
select id,111,222,333,case when steam_app_id in(3999999001,3999999002) then 'igdb-parent' else 'hltb' end,
  99,'2026-09-01 00:00:00+00',0.9,'high',case when steam_app_id=3999999005 then 'endless' else 'finite' end,
  'ready',steam_app_id=3999999002,'igdb',12
from catalog.games where steam_app_id between 3999999001 and 3999999005;
insert into catalog.duration_estimates(game_id,steam_app_id,provider,provider_game_id,main_story_minutes,
  main_extra_minutes,completionist_minutes,match_status,match_confidence,checked_at,created_at,updated_at,evidence)
select id,steam_app_id,case when steam_app_id<3999999003 then 'igdb' else 'hltb' end,123,
  600,900,1200,'matched','high',now(),now(),now(),
  case when steam_app_id=3999999004 then '{}'::jsonb
       else '{"identity_validated":true,"verification_method":"profile_steam_exact","verification_tier":"steam_appid"}'::jsonb end
from catalog.games where steam_app_id between 3999999001 and 3999999005;
insert into catalog.provider_state(game_id,provider,evidence_kind,status,failure_count,next_attempt_at,updated_at)
select id,'unknown','duration','failed',5,now()+interval '1 day',now()
from catalog.games where steam_app_id=3999999001;
insert into catalog.duration_imports(legacy_id,source,imported_count,skipped_count,status,created_at)
values('99000000-0000-4000-8000-000000000001','igdb_bulk_export',2,0,'succeeded',now());
insert into migration.legacy_duration_job_archive(steam_app_id,status,attempts,created_at,source_snapshot_hash)
values(3999999001,'failed',5,now(),decode(repeat('aa',32),'hex'));

-- Attributed HLTB state is useful and must survive the obsolete queue cleanup.
insert into catalog.provider_state(game_id,provider,evidence_kind,status,failure_count,updated_at)
select id,'hltb','duration','failed',3,now() from catalog.games where steam_app_id=3999999004;
