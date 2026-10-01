-- Restore the existing excluded/pending/allowed quarantine behaviour for every
-- ordinary app catalogue read. Keep identities, ownership and authored state;
-- workers still need to read excluded identities to maintain their evidence.
create function catalog.quarantined_app_ids()
returns table (steam_app_id bigint)
language sql stable security definer
set search_path = pg_catalog
as $$
  select distinct d.steam_app_id
  from catalog.review_decisions d
  where d.decision_kind = 'quarantine' and d.decision_status = 'excluded'
$$;

revoke all on function catalog.quarantined_app_ids() from public, vault_worker;
grant execute on function catalog.quarantined_app_ids() to vault_app;

create policy catalogue_quarantine_read on catalog.games
as restrictive for select to vault_app
using (
  steam_app_id is null or steam_app_id not in (
    select blocked.steam_app_id from catalog.quarantined_app_ids() blocked
  )
);

comment on function catalog.quarantined_app_ids() is
  'App-only quarantine projection: excluded Steam AppIDs, without private review evidence. Pending and allowed remain visible.';
