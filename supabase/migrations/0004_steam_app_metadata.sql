create table if not exists public.steam_app_metadata (
  steam_appid text primary key,
  title text,
  genre text not null default 'Unknown',
  status text not null default 'pending',
  failure_count integer not null default 0,
  last_error text,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint steam_app_metadata_status_check check (status in ('pending', 'ready', 'failed'))
);

drop trigger if exists steam_app_metadata_set_updated_at on public.steam_app_metadata;
create trigger steam_app_metadata_set_updated_at
before update on public.steam_app_metadata
for each row execute function public.set_updated_at();

create index if not exists steam_app_metadata_status_checked_idx on public.steam_app_metadata(status, checked_at);
create index if not exists steam_app_metadata_genre_idx on public.steam_app_metadata(genre);

alter table public.steam_app_metadata enable row level security;

grant select, insert, update, delete on table public.steam_app_metadata to service_role;
