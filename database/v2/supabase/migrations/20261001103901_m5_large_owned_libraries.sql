-- A real final-cutover library exceeded the original 10,000-game boundary.
-- Keep publication atomic and bounded: 20,000 games, unchanged 8 MiB payload,
-- authorization, leases, quotas, row validation, provenance and replay checks.
-- Existing applied migrations and function permissions remain unchanged.
do $migration$
declare
  definition text;
  old_bound constant text := 'v_game_count > 10000';
begin
  select pg_get_functiondef('ops._m2_publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamp with time zone,bigint)'::regprocedure)
    into definition;
  if (length(definition)-length(replace(definition,old_bound,'')))/length(old_bound) <> 1 then
    raise exception 'OWNED_PUBLICATION_BOUND_DRIFT';
  end if;
  execute replace(definition,old_bound,'v_game_count > 20000');
end
$migration$;
