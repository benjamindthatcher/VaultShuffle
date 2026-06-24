create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  steam_id text not null unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null,
  genre text not null default 'Unknown',
  store text not null default 'Steam',
  ownership text not null default 'Owned',
  status text not null default 'Not Started',
  rating integer not null default 0,
  hours_played numeric(10, 1) not null default 0,
  completion_percentage integer not null default 0,
  priority text not null default 'Medium',
  date_added text,
  notes text not null default '',
  steam_appid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint games_ownership_check check (ownership in ('Owned', 'Wishlist', 'Game pass')),
  constraint games_status_check check (status in ('Not Started', 'In Progress', 'Completed')),
  constraint games_priority_check check (priority in ('Low', 'Medium', 'High')),
  constraint games_rating_check check (rating between 0 and 10),
  constraint games_completion_check check (completion_percentage between 0 and 100),
  constraint games_hours_check check (hours_played >= 0),
  constraint games_user_steam_appid_unique unique (user_id, steam_appid)
);

create table if not exists public.recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  game_id uuid references public.games(id) on delete set null,
  kind text not null,
  reason text not null default '',
  mood text,
  time_commitment text,
  created_at timestamptz not null default now(),
  constraint recommendations_kind_check check (kind in ('shuffle', 'top_backlog', 'top_wishlist', 'random'))
);

create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_settings_user_key_unique unique (user_id, key)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_users_set_updated_at on public.app_users;
create trigger app_users_set_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
before update on public.games
for each row execute function public.set_updated_at();

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists sessions_expires_at_idx on public.sessions(expires_at);
create index if not exists games_user_id_idx on public.games(user_id);
create index if not exists games_user_status_idx on public.games(user_id, status);
create index if not exists games_user_ownership_idx on public.games(user_id, ownership);
create index if not exists games_user_priority_idx on public.games(user_id, priority);
create index if not exists games_user_title_idx on public.games(user_id, lower(title));
create index if not exists recommendations_user_id_idx on public.recommendations(user_id);
create index if not exists recommendations_user_created_idx on public.recommendations(user_id, created_at desc);
create index if not exists app_settings_user_id_idx on public.app_settings(user_id);

alter table public.app_users enable row level security;
alter table public.sessions enable row level security;
alter table public.games enable row level security;
alter table public.recommendations enable row level security;
alter table public.app_settings enable row level security;

-- No anon/authenticated policies are created intentionally.
-- The Next.js server uses the Supabase service role key in route handlers,
-- looks up the signed Steam session, and scopes every query by app_users.id.
-- This prevents browser-side direct table reads with the anon key.
