-- Current Family approximation, using the existing lender/candidate/access model.
-- Ordinary runtime never receives shared catalogue write grants.
create function app.begin_family_lookup(p_endpoint text)
returns table(allowed boolean, block_code text, attempt_id uuid, attempt_token uuid,
  provider_mode text, expires_at timestamptz, retry_at timestamptz)
language plpgsql security definer set search_path = pg_catalog as $$
begin
  if app.current_account_id() is null or p_endpoint not in ('vanity','profile','public_owned_lookup') then
    raise exception using errcode='22023', message='family_lookup_invalid';
  end if;
  return query select c.allowed,c.block_code,c.attempt_id,c.attempt_token,c.provider_mode,c.expires_at,c.retry_at
    from ops.consume_provider_attempt(p_endpoint,null,null,1,null,120) c;
end $$;

-- Internal only. Callers hold the existing parent account lock. Unknown catalogue
-- facts keep earlier access; an explicit exclusion can end access. Candidacy
-- alone never admits a game, and no lender playtime is copied to the borrower.
create function app._refresh_family_access()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  a integer := app.current_account_id(); m record; result jsonb := '{}'::jsonb;
  totals jsonb := '{"seen":0,"importable":0,"alreadyOwned":0,"excluded":0,"pending":0}';
  counts jsonb; changed boolean := false; affected integer;
begin
  if a is null then raise exception using errcode='22023',message='family_account_required'; end if;
  for m in select id,public_id,candidate_app_ids from app.family_members where account_id=a order by id loop
    with candidates as (
      select distinct c.value::bigint appid from jsonb_array_elements_text(m.candidate_app_ids) c
    ), facts as (
      select c.appid,g.id,
        exists(select 1 from app.library_games l where l.account_id=a and l.game_id=g.id) owned,
        case when g.lifecycle_status is not null and g.lifecycle_status<>'active'
          or exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
          or o.is_free then 'excluded'
        when md.categories is null or jsonb_array_length(md.categories)=0 then 'pending'
        when md.categories @> '["Family Sharing"]'::jsonb then 'importable'
        else 'excluded' end eligibility
      from candidates c left join catalog.games g on g.steam_app_id=c.appid
      left join catalog.game_metadata md on md.game_id=g.id
      left join lateral(select offer.is_free from catalog.offers offer where offer.game_id=g.id and offer.region_code='US' order by offer.last_observed_at desc,offer.id desc limit 1) o on true
    ) select jsonb_build_object('seen',count(*),'alreadyOwned',count(*) filter(where owned),
        'importable',count(*) filter(where not owned and eligibility='importable'),
        'excluded',count(*) filter(where not owned and eligibility='excluded'),
        'pending',count(*) filter(where not owned and eligibility='pending')) into counts from facts;

    insert into app.family_game_access(account_id,member_id,game_id,provenance)
      select a,m.id,g.id,'inferred' from catalog.games g join catalog.game_metadata md on md.game_id=g.id
      where g.steam_app_id in (select value::bigint from jsonb_array_elements_text(m.candidate_app_ids))
        and g.lifecycle_status='active' and md.categories @> '["Family Sharing"]'::jsonb
        and not coalesce((select o.is_free from catalog.offers o where o.game_id=g.id and o.region_code='US' order by o.last_observed_at desc,o.id desc limit 1),false)
        and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
      on conflict(account_id,member_id,game_id) do nothing;
    get diagnostics affected = row_count; changed := changed or affected>0;

    delete from app.family_game_access f using catalog.games g
      where f.account_id=a and f.member_id=m.id and g.id=f.game_id and (
        not (m.candidate_app_ids @> jsonb_build_array(g.steam_app_id))
        or g.lifecycle_status<>'active'
        or coalesce((select o.is_free from catalog.offers o where o.game_id=g.id and o.region_code='US' order by o.last_observed_at desc,o.id desc limit 1),false)
        or exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
        or exists(select 1 from catalog.game_metadata md where md.game_id=g.id and jsonb_array_length(md.categories)>0 and not md.categories @> '["Family Sharing"]'::jsonb));
    get diagnostics affected = row_count; changed := changed or affected>0;
    update app.family_members set checked_at=statement_timestamp(),last_synced_at=statement_timestamp(),last_error=null,error_status='ok'
      where account_id=a and id=m.id;
    result := result || jsonb_build_object(m.public_id::text,counts);
    select jsonb_object_agg(k, (totals->>k)::integer+(counts->>k)::integer) into totals from jsonb_object_keys(totals) k;
  end loop;
  perform app._clear_unavailable_family_commitments();
  if changed then update app.accounts set library_revision=library_revision+1 where id=a; end if;
  return jsonb_build_object('counts',totals,'byMember',result);
end $$;

create function app._clear_unavailable_family_commitments()
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare a integer := app.current_account_id(); changed boolean := false;
begin
  delete from app.pins p where p.account_id=a and p.scope in ('library','family','all')
    and not exists(select 1 from app.library_games l where l.account_id=a and l.game_id=p.game_id)
    and not exists(select 1 from app.family_game_access f where f.account_id=a and f.game_id=p.game_id);
  changed := found;
  update app.vault_state v set current_game_id=null,current_draw_ref=null,revision=revision+1,updated_at=statement_timestamp()
    where v.account_id=a and v.current_game_id is not null
    and not exists(select 1 from app.library_games l where l.account_id=a and l.game_id=v.current_game_id)
    and not exists(select 1 from app.family_game_access f where f.account_id=a and f.game_id=v.current_game_id);
  changed := changed or found;
  if changed then update app.accounts set state_revision=state_revision+1 where id=a; end if;
end $$;

create function app.add_family_member(p_steam_id bigint,p_name text,p_avatar text,
  p_candidates jsonb,p_observed_at timestamptz,p_attempt_id uuid,p_attempt_token uuid)
returns table(member_public_id uuid,counts jsonb)
language plpgsql security definer set search_path = pg_catalog as $$
declare a integer:=app.current_account_id(); own_id bigint; member_id uuid; r jsonb; charge ops.provider_call_charges%rowtype;
begin
  perform 1 from app.accounts where id=a and lifecycle_status='active' for update;
  if not found then raise exception using errcode='22023',message='family_account_required'; end if;
  select steam_id into own_id from app.steam_profiles where account_id=a;
  if p_steam_id=own_id then raise exception using errcode='22023',message='family_is_self'; end if;
  if exists(select 1 from app.family_members where account_id=a and steam_id=p_steam_id) then
    raise exception using errcode='22023',message='family_already_added'; end if;
  if (select count(*) from app.family_members where account_id=a)>=5 then
    raise exception using errcode='22023',message='family_limit_reached'; end if;
  if p_steam_id is null or p_steam_id<=0 or p_name is null or length(btrim(p_name)) not between 1 and 200
    or (p_avatar is not null and length(p_avatar)>2048) or p_candidates is null or jsonb_typeof(p_candidates)<>'array'
    or jsonb_array_length(p_candidates)>10000 or pg_column_size(p_candidates)>2097152 then
    raise exception using errcode='22023',message='family_snapshot_invalid'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) c where jsonb_typeof(c)<>'object'
      or c->>'appId' is null or c->>'appId' !~ '^[1-9][0-9]{0,9}$'
      or jsonb_typeof(c->'title') is distinct from 'string' or length(btrim(c->>'title')) not between 1 and 500)
    or exists(select 1 from jsonb_array_elements(p_candidates) c where (c->>'appId')::bigint>4294967295)
    or (select count(distinct c->>'appId') from jsonb_array_elements(p_candidates) c)<>jsonb_array_length(p_candidates) then
    raise exception using errcode='22023',message='family_snapshot_invalid'; end if;
  select * into charge from ops.provider_call_charges c where c.attempt_id=p_attempt_id and c.attempt_token=p_attempt_token
    and c.account_id=a and c.endpoint='public_owned_lookup' and c.status='charged' and c.expires_at>clock_timestamp() for update;
  if not found or p_observed_at is null or p_observed_at<date_trunc('second',charge.fetch_started_at)
    or p_observed_at>clock_timestamp()+interval '1 second' then
    raise exception using errcode='22023',message='family_snapshot_stale'; end if;

  insert into catalog.games(steam_app_id,title,normalized_sort_title,title_source)
    select (c->>'appId')::bigint,c->>'title',lower(btrim(c->>'title')),
      case when c->>'title'='Steam App '||(c->>'appId') then 'catalog_stub' else 'steam_name' end
      from jsonb_array_elements(p_candidates) c order by (c->>'appId')::bigint
    on conflict(steam_app_id) do nothing;
  insert into app.family_members(account_id,steam_id,display_name,avatar_url,profile_url,candidate_app_ids,candidate_count,checked_at,error_status,last_synced_at)
    values(a,p_steam_id,p_name,p_avatar,'https://steamcommunity.com/profiles/'||p_steam_id::text,
      coalesce((select jsonb_agg((c->>'appId')::bigint order by (c->>'appId')::bigint) from jsonb_array_elements(p_candidates) c),'[]'),
      jsonb_array_length(p_candidates),p_observed_at,'ok',p_observed_at) returning public_id into member_id;
  update ops.provider_call_charges set status='applied',completed_at=clock_timestamp() where attempt_id=p_attempt_id;
  r:=app._refresh_family_access();
  update app.accounts set library_revision=library_revision+1 where id=a;
  return query select member_id,r->'byMember'->member_id::text;
end $$;

create function app.recheck_family_library()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform 1 from app.accounts where id=app.current_account_id() and lifecycle_status='active' for update;
  if not found then raise exception using errcode='22023',message='family_account_required'; end if;
  return app._refresh_family_access()->'counts';
end $$;

create function app.remove_family_member(p_member_id uuid)
returns table(removed integer,retained integer,display_name text)
language plpgsql security definer set search_path = pg_catalog as $$
declare a integer:=app.current_account_id(); m app.family_members%rowtype; lost integer; kept integer;
begin
  perform 1 from app.accounts where id=a and lifecycle_status='active' for update;
  if not found then raise exception using errcode='22023',message='family_account_required'; end if;
  select * into m from app.family_members where account_id=a and public_id=p_member_id;
  if not found then raise exception using errcode='22023',message='family_not_found'; end if;
  select count(*) filter(where not exists(select 1 from app.library_games l where l.account_id=a and l.game_id=f.game_id)
      and not exists(select 1 from app.family_game_access other where other.account_id=a and other.member_id<>m.id and other.game_id=f.game_id)),
    count(*) filter(where exists(select 1 from app.library_games l where l.account_id=a and l.game_id=f.game_id)
      or exists(select 1 from app.family_game_access other where other.account_id=a and other.member_id<>m.id and other.game_id=f.game_id))
    into lost,kept from app.family_game_access f where f.account_id=a and f.member_id=m.id;
  delete from app.family_members where account_id=a and id=m.id;
  perform app._clear_unavailable_family_commitments();
  update app.accounts set library_revision=library_revision+1 where id=a;
  return query select lost,kept,coalesce(m.display_name,'Steam player');
end $$;

revoke all on function app.begin_family_lookup(text),app._refresh_family_access(),app._clear_unavailable_family_commitments(),
  app.add_family_member(bigint,text,text,jsonb,timestamptz,uuid,uuid),app.recheck_family_library(),app.remove_family_member(uuid)
  from public,vault_app,vault_worker;
grant execute on function app.begin_family_lookup(text),app.add_family_member(bigint,text,text,jsonb,timestamptz,uuid,uuid),
  app.recheck_family_library(),app.remove_family_member(uuid) to vault_app;
