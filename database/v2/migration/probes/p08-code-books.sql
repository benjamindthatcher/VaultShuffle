-- ============================================================================
-- M3 source probe P08  -- readiness section 10 item 8
-- COUNT-ONLY plus safe catalogue metadata. Read-only. NOT RUN against source.
--
-- The code-book meanings for prev_active_status and recency_source must come
-- from a separately captured and reviewed definition. This public result only
-- reports whether definitions exist, their bounded shape and credential-word
-- flags. It never prints comments, defaults, trigger bodies, routine bodies or
-- constraint definitions. Frequency output uses allowlisted buckets and an
-- `other` bucket; it cannot infer a mapping from ordering or frequency.
-- ============================================================================

-- P08a  Column comments: presence/shape only. Comment text is private review
-- material because it is freeform and may contain a literal credential.
select
  count(*) as inspected_columns,
  count(*) filter (where col_description(c.oid, a.attnum) is not null)
    as columns_with_comments,
  count(*) filter (
    where col_description(c.oid, a.attnum) is not null
      and length(btrim(col_description(c.oid, a.attnum))) > 0
  ) as nonempty_comments,
  count(*) filter (
    where col_description(c.oid, a.attnum) ilike '%authorization%'
       or col_description(c.oid, a.attnum) ilike '%bearer %'
       or col_description(c.oid, a.attnum) ilike '%secret%'
       or col_description(c.oid, a.attnum) ilike '%token%'
       or col_description(c.oid, a.attnum) ilike '%key%'
  ) as comments_mention_credential_words,
  max(length(col_description(c.oid, a.attnum))) as longest_comment_chars
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a
  on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public'
  and c.relname in ('user_game_state', 'contact_messages', 'feedback_submissions');

-- P08a-2  Table comment presence/shape only.
select
  count(*) as inspected_tables,
  count(*) filter (where obj_description(c.oid, 'pg_class') is not null)
    as tables_with_comments,
  count(*) filter (
    where obj_description(c.oid, 'pg_class') ilike '%authorization%'
       or obj_description(c.oid, 'pg_class') ilike '%bearer %'
       or obj_description(c.oid, 'pg_class') ilike '%secret%'
       or obj_description(c.oid, 'pg_class') ilike '%token%'
       or obj_description(c.oid, 'pg_class') ilike '%key%'
  ) as table_comments_mention_credential_words,
  max(length(obj_description(c.oid, 'pg_class'))) as longest_table_comment_chars
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('user_game_state', 'contact_messages', 'feedback_submissions');

-- P08b  Check-constraint definition presence/shape. Definition text is kept in
-- the private review artifact and is never returned by this probe.
select
  count(*) as check_constraints,
  count(*) filter (where pg_get_constraintdef(con.oid) ilike '%prev_active_status%')
    as checks_mention_prev_active_status,
  count(*) filter (where pg_get_constraintdef(con.oid) ilike '%recency_source%')
    as checks_mention_recency_source,
  count(*) filter (
    where pg_get_constraintdef(con.oid) ilike '%authorization%'
       or pg_get_constraintdef(con.oid) ilike '%bearer %'
       or pg_get_constraintdef(con.oid) ilike '%secret%'
       or pg_get_constraintdef(con.oid) ilike '%token%'
       or pg_get_constraintdef(con.oid) ilike '%key%'
  ) as checks_mention_credential_words,
  max(length(pg_get_constraintdef(con.oid))) as longest_check_chars,
  count(distinct md5(pg_get_constraintdef(con.oid))) as distinct_check_shapes
from pg_catalog.pg_constraint con
join pg_catalog.pg_class c on c.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('user_game_state', 'contact_messages', 'feedback_submissions')
  and con.contype = 'c';

-- P08c  Routine references: names, arguments and bodies are private review
-- material. Only aggregate indicators leave the source.
select
  count(*) as matching_routines,
  count(*) filter (where p.prosecdef) as security_definer_routines,
  count(*) filter (where p.prosrc ilike '%prev_active_status%')
    as routines_mention_prev_active_status,
  count(*) filter (where p.prosrc ilike '%recency_source%')
    as routines_mention_recency_source,
  count(*) filter (where p.prosrc ilike '%user_game_state%')
    as routines_mention_user_game_state,
  count(*) filter (
    where p.prosrc ilike '%authorization%'
       or p.prosrc ilike '%bearer %'
       or p.prosrc ilike '%secret%'
       or p.prosrc ilike '%token%'
       or p.prosrc ilike '%key%'
  ) as routines_mention_credential_words,
  max(length(p.prosrc)) as longest_routine_body_chars,
  count(distinct md5(p.prosrc)) as distinct_routine_shapes
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'extensions')
  and (
    p.prosrc ilike '%prev_active_status%'
    or p.prosrc ilike '%recency_source%'
    or p.prosrc ilike '%user_game_state%'
  );

-- P08c-2  Trigger presence/shape only. Trigger definitions are private review
-- material and are represented by lengths, hashes and credential-word counts.
select
  count(*) as user_game_state_triggers,
  count(*) filter (where t.tgenabled = 'O') as enabled_triggers,
  count(*) filter (
    where pg_get_triggerdef(t.oid) ilike '%authorization%'
       or pg_get_triggerdef(t.oid) ilike '%bearer %'
       or pg_get_triggerdef(t.oid) ilike '%secret%'
       or pg_get_triggerdef(t.oid) ilike '%token%'
       or pg_get_triggerdef(t.oid) ilike '%key%'
  ) as triggers_mention_credential_words,
  max(length(pg_get_triggerdef(t.oid))) as longest_trigger_chars,
  count(distinct md5(pg_get_triggerdef(t.oid))) as distinct_trigger_shapes
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'user_game_state'
  and not t.tgisinternal;

-- P08c-3  Defaults on coded columns: presence/shape only.
select
  count(*) as coded_column_defaults,
  count(*) filter (
    where pg_get_expr(d.adbin, d.adrelid) ilike '%authorization%'
       or pg_get_expr(d.adbin, d.adrelid) ilike '%bearer %'
       or pg_get_expr(d.adbin, d.adrelid) ilike '%secret%'
       or pg_get_expr(d.adbin, d.adrelid) ilike '%token%'
       or pg_get_expr(d.adbin, d.adrelid) ilike '%key%'
  ) as defaults_mention_credential_words,
  max(length(pg_get_expr(d.adbin, d.adrelid))) as longest_default_chars,
  count(distinct md5(pg_get_expr(d.adbin, d.adrelid))) as distinct_default_shapes
from pg_catalog.pg_attrdef d
join pg_catalog.pg_class c on c.oid = d.adrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = d.adnum
where n.nspname = 'public'
  and c.relname = 'user_game_state';

-- P08d  Size of the coded population. Both code and parent text are reduced to
-- allowlisted buckets. A bucket is a measurement aid, never a code-book guess.

-- P08d-1  prev_active_status code versus the parent status bucket.
select
  case
    when s.prev_active_status in (1, 2) then s.prev_active_status::text
    when s.prev_active_status is null then 'null'
    else 'other'
  end as smallint_code_bucket,
  case
    when ug.previous_active_status in ('Not Started', 'Sampled', 'In Progress')
      then ug.previous_active_status
    when ug.previous_active_status is null then 'null'
    else 'other'
  end as parent_status_bucket,
  count(*) as rows
from public.user_game_state s
left join public.user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid
group by 1, 2
order by smallint_code_bucket, parent_status_bucket;

-- P08d-2  recency_source code versus the parent text bucket.
select
  case
    when s.recency_source in (1, 2, 3) then s.recency_source::text
    when s.recency_source is null then 'null'
    else 'other'
  end as smallint_code_bucket,
  case
    when ug.recency_source in ('steam_exact', 'observed_playtime_change', 'steam_recent_window')
      then ug.recency_source
    when ug.recency_source is null then 'null'
    else 'other'
  end as parent_recency_bucket,
  count(*) as rows
from public.user_game_state s
left join public.user_games ug
  on ug.user_id = s.user_id
 and ug.catalog_steam_appid = s.appid
group by 1, 2
order by smallint_code_bucket, parent_recency_bucket;

-- P08d-3  The size of each discarded/decoded population, with no code values.
select
  count(*) as staging_rows,
  count(*) filter (where prev_active_status is not null) as rows_with_prev_active_status,
  count(*) filter (where recency_source is not null) as rows_with_recency_source,
  count(*) filter (where prev_active_status is null) as rows_without_prev_active_status,
  count(*) filter (where recency_source is null) as rows_without_recency_source
from public.user_game_state;
