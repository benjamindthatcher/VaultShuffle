alter table public.games
  add column if not exists is_quarantined boolean not null default false,
  add column if not exists quarantine_reason text;

create table if not exists public.catalog_game_quarantine (
  steam_appid bigint primary key check (steam_appid > 0),
  name text,
  steam_type text,
  matched_rule text,
  reason text not null,
  genres text[] not null default '{}',
  categories text[] not null default '{}',
  review_status text not null default 'excluded'
    check (review_status in ('excluded', 'allowed')),
  source text not null default 'automatic'
    check (source in ('automatic', 'manual')),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  reviewed_at timestamptz,
  review_notes text,
  updated_at timestamptz not null default now()
);

alter table public.catalog_game_quarantine enable row level security;

drop policy if exists catalog_game_quarantine_server_only
  on public.catalog_game_quarantine;
create policy catalog_game_quarantine_server_only
  on public.catalog_game_quarantine
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on public.catalog_game_quarantine from anon, authenticated;
grant select, insert, update, delete on public.catalog_game_quarantine to service_role;

create or replace function public.sync_game_quarantine_visibility()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  update public.games
  set is_quarantined = (new.review_status = 'excluded'),
      quarantine_reason = case
        when new.review_status = 'excluded' then new.reason
        else null
      end,
      updated_at = now()
  where steam_appid = new.steam_appid::text;

  return new;
end;
$$;

drop trigger if exists sync_game_quarantine_visibility
  on public.catalog_game_quarantine;
create trigger sync_game_quarantine_visibility
after insert or update of review_status, reason
on public.catalog_game_quarantine
for each row execute function public.sync_game_quarantine_visibility();

insert into public.catalog_game_quarantine (
  steam_appid,
  name,
  matched_rule,
  reason
)
select distinct
  games.steam_appid::bigint,
  games.title,
  'title_pattern',
  'Title matched an automatic non-game rule.'
from public.games
where games.steam_appid ~ '^[0-9]+$'
  and games.steam_appid::numeric <= 9223372036854775807
  and games.title ~* '\m(playtest|dedicated server|test (server|realm|client)|public test|technical test|pts|ptr|sdk|benchmark|editor|soundtrack|artbook)\M'
on conflict (steam_appid) do update
set name = excluded.name,
    last_detected_at = now(),
    updated_at = now();
