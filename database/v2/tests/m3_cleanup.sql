\set ON_ERROR_STOP on
\echo M3 rollback cleanup assertions

DO $$
declare
  v_count bigint;
begin
  -- Every M3 fixture file is rollback-only. The only intentional persistent
  -- row is the pending support retention decision created by the migration.
  select count(*) into v_count from app.accounts
   where display_name like 'M3 %';
  if v_count <> 0 then raise exception 'M3 fixture accounts survived rollback'; end if;

  select count(*) into v_count from catalog.games
   where steam_app_id between 3999999994 and 3999999999;
  if v_count <> 0 then raise exception 'M3 fixture games survived rollback'; end if;

  select count(*) into v_count from migration.runs;
  if v_count <> 0 then raise exception 'M3 run rows survived rollback'; end if;

  select count(*) into v_count
    from support.retention_policy_decisions
   where policy_key = 'support-content-retention'
     and decision_status = 'pending';
  if v_count <> 1 then raise exception 'M3 retention policy seed row is missing'; end if;

end
$$;

\echo M3 rollback cleanup passed
