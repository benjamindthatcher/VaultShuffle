-- Record the completed catalogue-wide HLTB detail-page validation before any
-- automatic duration classification is rebuilt from its evidence.
--
-- This is deliberately a data migration rather than an optimistic marker: it
-- verifies the exact accepted-row totals from the source report and aborts if
-- any accepted row has incoherent evidence or duration values.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

lock table public.game_duration_estimates in share mode;

create table if not exists public.catalog_duration_import_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  imported_count integer not null default 0 check (imported_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  source_updated_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.catalog_duration_import_runs
  add column if not exists source_sha256 text,
  add column if not exists expected_app_count integer,
  add column if not exists staged_row_count integer,
  add column if not exists status text not null default 'legacy',
  add column if not exists completed_at timestamptz,
  add column if not exists manifest jsonb not null default '{}'::jsonb;

create unique index if not exists catalog_duration_import_runs_source_sha_uidx
  on public.catalog_duration_import_runs (source, source_sha256)
  where source_sha256 is not null;

do $$
declare
  matched_rows bigint;
  no_duration_rows bigint;
  verified_appids bigint;
begin
  select
    count(*) filter (where estimate.match_status = 'matched'),
    count(*) filter (where estimate.match_status = 'no_duration'),
    count(distinct estimate.steam_app_id)
  into matched_rows, no_duration_rows, verified_appids
  from public.game_duration_estimates as estimate
  where estimate.provider = 'hltb'
    and estimate.provider_game_id is not null
    and estimate.evidence @> '{"identity_validated": true}'::jsonb
    and estimate.evidence ->> 'verification_source' = 'detail_page_validator'
    and (
      (
        estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
        and estimate.evidence ->> 'verification_tier' = 'steam_appid'
      )
      or (
        estimate.evidence ->> 'verification_method' in (
          'safe_exact_title',
          'safe_exact_alias'
        )
        and estimate.evidence ->> 'verification_tier' in (
          'exact_title',
          'mixed_script_title'
        )
      )
    );

  if row(matched_rows, no_duration_rows, verified_appids)
    is distinct from row(19025::bigint, 7825::bigint, 26850::bigint)
  then
    raise exception
      'HLTB validation totals do not match the completed report: matched %, no-duration %, appids %',
      matched_rows,
      no_duration_rows,
      verified_appids;
  end if;

  if exists (
    select 1
    from public.game_duration_estimates as estimate
    where estimate.provider = 'hltb'
      and estimate.evidence @> '{"identity_validated": true}'::jsonb
      and estimate.evidence ->> 'verification_source' = 'detail_page_validator'
      and (
        (
          estimate.match_status = 'matched'
          and not (
            estimate.main_story_minutes > 0
            or estimate.main_extra_minutes > 0
            or estimate.completionist_minutes > 0
          )
        )
        or (
          estimate.match_status = 'no_duration'
          and (
            estimate.main_story_minutes is not null
            or estimate.main_extra_minutes is not null
            or estimate.completionist_minutes is not null
            or estimate.evidence ->> 'duration_basis' <> 'no_duration'
          )
        )
        or estimate.match_status not in ('matched', 'no_duration')
      )
  ) then
    raise exception 'HLTB validation contains incoherent accepted evidence';
  end if;
end;
$$;

insert into public.catalog_duration_import_runs (
  source,
  imported_count,
  skipped_count,
  source_updated_at,
  source_sha256,
  expected_app_count,
  staged_row_count,
  status,
  completed_at,
  manifest
)
values (
  'hltb_detail_validation',
  26850,
  1620,
  '2026-08-25 00:00:00+00'::timestamptz,
  'a3614aa730cd775342ceaf7fdece41fd72d84d35e63c35d917b6447c427466ee',
  28467,
  28470,
  'completed',
  now(),
  pg_catalog.jsonb_build_object(
    'schema_version', 1,
    'validator_errors', 0,
    'source_action_counts', pg_catalog.jsonb_build_object(
      'matched', 19025,
      'no_duration', 7830,
      'rejected', 1615
    ),
    'accepted_counts', pg_catalog.jsonb_build_object(
      'matched', 19025,
      'no_duration', 7825
    ),
    'identity_conflicts', pg_catalog.jsonb_build_object(
      'matched', 0,
      'no_duration', 5
    ),
    'final_verification', pg_catalog.jsonb_build_object(
      'missing_catalogue', 0,
      'job_state_mismatches', 0,
      'unhardened_hltb_projected_ready', 0,
      'no_duration_rows_with_raw_values', 0
    )
  )
)
on conflict (source, source_sha256) where source_sha256 is not null
do update
set imported_count = excluded.imported_count,
    skipped_count = excluded.skipped_count,
    source_updated_at = excluded.source_updated_at,
    expected_app_count = excluded.expected_app_count,
    staged_row_count = excluded.staged_row_count,
    status = excluded.status,
    completed_at = excluded.completed_at,
    manifest = excluded.manifest;

commit;
