-- Complete existing Store metadata parity without new relations or stored payloads.
-- Keep the accepted lease/publication implementation and extend its fixed boundary.
begin;
alter function ops.claim_catalogue_metadata() rename to claim_catalogue_metadata_v1;
revoke all on function ops.claim_catalogue_metadata_v1() from public,vault_app,vault_worker;
create function ops.claim_catalogue_metadata()
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text,known_deck smallint)
language sql security definer set search_path=pg_catalog as $$
  select c.outbox_id,c.lease_token,c.steam_app_id,c.provider_mode,f.deck_compatibility_detail
  from ops.claim_catalogue_metadata_v1() c
  left join catalog.games g on g.steam_app_id=c.steam_app_id
  left join catalog.game_features f on f.game_id=g.id
$$;
revoke all on function ops.claim_catalogue_metadata() from public,vault_app,vault_worker;
grant execute on function ops.claim_catalogue_metadata() to vault_worker;

alter function ops.finish_catalogue_metadata(bigint,uuid,jsonb) rename to finish_catalogue_metadata_v1;
revoke all on function ops.finish_catalogue_metadata_v1(bigint,uuid,jsonb) from public,vault_app,vault_worker;
create function ops.finish_catalogue_metadata(p_id bigint,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare outcome text;d jsonb;total bigint;positive bigint;deck smallint;game integer;
begin
  if p_result->>'status'='complete' then
    d:=p_result->'details';
    if (d->>'reviewTotal' is null)<>(d->>'reviewPositive' is null) then
      raise exception using errcode='22023',message='catalogue_reviews_invalid';
    end if;
    if d->>'reviewTotal' is not null then
      if jsonb_typeof(d->'reviewTotal')<>'number' or jsonb_typeof(d->'reviewPositive')<>'number'
        or (d->>'reviewTotal')!~'^[0-9]{1,10}$' or (d->>'reviewPositive')!~'^[0-9]{1,10}$' then
        raise exception using errcode='22023',message='catalogue_reviews_invalid';
      end if;
      total:=(d->>'reviewTotal')::bigint;positive:=(d->>'reviewPositive')::bigint;
      if total>2147483647 or positive>total then
        raise exception using errcode='22023',message='catalogue_reviews_invalid';
      end if;
    end if;
    if d->>'deckCategory' is not null then
      if jsonb_typeof(d->'deckCategory')<>'number' or (d->>'deckCategory')!~'^[0-3]$' then
        raise exception using errcode='22023',message='catalogue_deck_invalid';
      end if;
      deck:=(d->>'deckCategory')::smallint;
    end if;
  end if;
  outcome:=ops.finish_catalogue_metadata_v1(p_id,p_token,p_result);
  if outcome='published' then
    select game_id into game from ops.enrichment_outbox where id=p_id;
    if total is not null then
      update catalog.game_features set review_total=total,review_positive=positive,review_negative=total-positive
        where game_id=game;
    end if;
    -- A concurrent known Deck fact wins over an older optional lookup.
    if deck is not null then
      update catalog.game_features set deck_compatibility_detail=deck,deck_checked_at=clock_timestamp(),
        deck_compatibility=case when deck in(2,3) then 'supported' when deck=1 then 'unsupported' else 'unknown' end
        where game_id=game and deck_compatibility_detail is null;
    end if;
  end if;
  return outcome;
end $$;
revoke all on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) from public,vault_app,vault_worker;
grant execute on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) to vault_worker;
commit;
