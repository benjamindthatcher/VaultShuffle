-- Public store data, shared across visitors, accessible only through our server.
create table public.wishlist_store_cache (
  steam_appid bigint not null check (steam_appid between 1 and 4294967295),
  country text not null check (country in ('GB', 'US', 'DE', 'CA', 'AU')),
  game jsonb,
  checked_at timestamptz,
  expires_at timestamptz not null default 'epoch',
  retry_after timestamptz not null default 'epoch',
  lease_token uuid,
  lease_until timestamptz not null default 'epoch',
  primary key (steam_appid, country)
);
alter table public.wishlist_store_cache enable row level security;
revoke all on public.wishlist_store_cache from public, anon, authenticated;
grant select, insert, update, delete on public.wishlist_store_cache to service_role;

-- A short database lease deduplicates refreshes across server instances.
-- No locks are held while the server calls Steam. Expired leases self-recover.
create function public.claim_wishlist_store_refresh(p_appid bigint, p_country text, p_token uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  entry public.wishlist_store_cache;
  claimed boolean := false;
begin
  insert into public.wishlist_store_cache (steam_appid, country)
    values (p_appid, p_country) on conflict do nothing;
  select * into entry from public.wishlist_store_cache
    where steam_appid = p_appid and country = p_country for update;
  if entry.expires_at <= now() and entry.retry_after <= now() and entry.lease_until <= now() then
    update public.wishlist_store_cache set lease_token = p_token, lease_until = now() + interval '30 seconds'
      where steam_appid = p_appid and country = p_country returning * into entry;
    claimed := true;
  end if;
  return to_jsonb(entry) || jsonb_build_object('claimed', claimed);
end;
$$;
revoke all on function public.claim_wishlist_store_refresh(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_wishlist_store_refresh(bigint, text, uuid) to service_role;
