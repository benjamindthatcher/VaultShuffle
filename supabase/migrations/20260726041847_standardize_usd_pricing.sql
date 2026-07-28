-- Applied to production as migration 20260726041847.
-- VaultShuffle prices are sourced exclusively from Steam's US storefront.
-- Never relabel foreign minor units as USD: clear them and queue a US refresh.

update public.steam_app_metadata
set price_currency = null,
    price_initial = null,
    price_final = null,
    discount_percent = 0,
    status = 'pending',
    last_error = null,
    checked_at = null,
    updated_at = now()
where price_currency is not null
  and price_currency <> 'USD';

update public.catalog_games
set price_currency = null,
    price_initial = null,
    price_final = null,
    discount_percent = 0,
    updated_at = now()
where price_currency is not null
  and price_currency <> 'USD';

insert into public.catalog_ingest_queue (
  steam_appid,
  status,
  reason,
  priority,
  requested_count,
  source_payload,
  next_attempt_at,
  last_requested_at,
  updated_at
)
select
  steam_appid,
  'pending',
  'refresh',
  90,
  1,
  jsonb_build_object('refresh_reason', 'usd_pricing_standardization'),
  now(),
  now(),
  now()
from public.catalog_games
where price_currency is null
  and not is_free
on conflict (steam_appid) do update
set status = 'pending',
    reason = 'refresh',
    priority = greatest(public.catalog_ingest_queue.priority, 90),
    source_payload = public.catalog_ingest_queue.source_payload
      || jsonb_build_object('refresh_reason', 'usd_pricing_standardization'),
    next_attempt_at = now(),
    last_requested_at = now(),
    updated_at = now();

alter table public.catalog_games
  drop constraint if exists catalog_games_usd_currency_check;
alter table public.catalog_games
  add constraint catalog_games_usd_currency_check
  check (price_currency is null or price_currency = 'USD');

alter table public.steam_app_metadata
  drop constraint if exists steam_app_metadata_usd_currency_check;
alter table public.steam_app_metadata
  add constraint steam_app_metadata_usd_currency_check
  check (price_currency is null or price_currency = 'USD');

comment on column public.catalog_games.price_currency is
  'USD only, sourced from Steam with cc=US. Null means unavailable or awaiting refresh.';
comment on column public.steam_app_metadata.price_currency is
  'USD only, sourced from Steam with cc=US. Null means unavailable or awaiting refresh.';
