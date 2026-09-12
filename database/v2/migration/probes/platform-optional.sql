-- ============================================================================
-- M3 source probes P02  -- optional Supabase platform relations
-- COUNT-ONLY. Read-only. NOT RUN against the source in this batch.
--
-- This file is deliberately separate from the public-inventory probes. The
-- runner must preflight every relation with to_regclass/to_regprocedure and
-- report an explicit `absent` result before executing an object-specific
-- statement. A direct statement below is therefore only compiled when its
-- @requires relation exists in the inspected project.
--
-- No vault secret relation is referenced. No bucket/object path, command,
-- response text, schedule name, job id, role name or migration definition is
-- returned. Definitions are captured separately in a private review artifact.
-- ============================================================================

-- P02a  Relation-kind inventory for known platform schemas. The schema names
-- are a fixed allowlist; relation names are intentionally not returned.
select
  n.nspname as schema_bucket,
  count(*) filter (where c.relkind = 'r') as base_tables,
  count(*) filter (where c.relkind = 'v') as views,
  count(*) filter (where c.relkind = 'm') as matviews,
  count(*) filter (where c.relkind = 'p') as partitioned
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname in (
  'auth', 'cron', 'extensions', 'graphql', 'graphql_public',
  'net', 'realtime', 'storage', 'supabase_migrations', 'vault'
)
group by n.nspname
order by n.nspname;

-- @requires auth.users
-- P02b  A nonzero count reopens the custom-session design. The relation is
-- optional, so the runner reports `absent` rather than failing compilation.
select
  count(*) as auth_users_rows,
  (count(*) = 0) as auth_is_unused_as_expected
from auth.users;

-- @requires cron.job
-- P02c  Schedule fence inventory. Credential-bearing command text is reduced
-- to booleans and a length; no job identity, schedule or command is printed.
select
  count(*) as schedule_rows,
  count(*) filter (where active) as active_schedule_rows,
  count(*) filter (
    where command ilike '%authorization%' or command ilike '%bearer %'
  ) as commands_mention_authorization,
  count(*) filter (
    where command ilike '%key%' or command ilike '%secret%' or command ilike '%token%'
  ) as commands_mention_key_material,
  max(length(command)) as longest_command_chars
from cron.job;

-- @requires cron.job_run_details
-- P02d  Recent run outcomes, bucketed to known pg_cron states. Unexpected or
-- NULL states are counted as `other` and their text is never returned.
select
  case
    when status in ('succeeded', 'failed', 'running', 'pending') then status
    when status is null then 'null'
    else 'other'
  end as status_bucket,
  count(*) as recent_runs,
  max(start_time) as most_recent_run
from cron.job_run_details
where start_time > now() - interval '7 days'
group by
  case
    when status in ('succeeded', 'failed', 'running', 'pending') then status
    when status is null then 'null'
    else 'other'
  end
order by status_bucket;

-- @requires net.http_request_queue
-- P02e  Queue size only. The recorded source metadata has NO `created` column;
-- do not invent an age or reference that absent column. The runner executes this
-- only when the relation exists.
select count(*) as queued_http_requests
from net.http_request_queue;

-- P02e-metadata  The column check is safe even when the optional relation is
-- absent. It is the only supported way to report whether a queue age can be
-- measured; this deliberately returns zero for `created` on the current source.
select
  count(*) filter (where a.attname = 'created') as created_column_count,
  count(*) filter (where a.attname in ('created_at', 'enqueued_at')) as known_age_column_count
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'net'
  and c.relname = 'http_request_queue'
  and a.attnum > 0
  and not a.attisdropped;

-- @requires storage.buckets,storage.objects
-- P02f  Storage coverage, grouped only by the fixed public/private boolean.
-- Paths and arbitrary metadata values never leave the database. Invalid/missing
-- size fields count as zero in the byte aggregate and are separately counted.
select
  b.public as bucket_public,
  count(distinct b.id) as bucket_rows,
  count(o.id) as object_rows,
  count(o.id) filter (
    where o.metadata is null
       or not (o.metadata ? 'size')
       or (o.metadata->>'size') !~ '^[0-9]+$'
  ) as objects_without_numeric_size,
  coalesce(sum(
    case
      when (o.metadata ? 'size') and (o.metadata->>'size') ~ '^[0-9]+$'
        then (o.metadata->>'size')::numeric
      else 0
    end
  ), 0) as total_numeric_bytes
from storage.buckets b
left join storage.objects o on o.bucket_id = b.id
group by b.public
order by b.public;

-- @requires supabase_migrations.schema_migrations
-- P02g  Applied-migration bounds only. Migration statement bodies remain in a
-- private reviewed artifact because DDL can contain credentials.
select
  count(*) as applied_migrations,
  min(version) as earliest_version,
  max(version) as latest_version
from supabase_migrations.schema_migrations;

-- P02b-vault  There is intentionally no relation probe for vault.secrets or a
-- decrypted equivalent. P02a counts catalogue relation kinds only; secret rows
-- and secret counts are excluded absolutely.

