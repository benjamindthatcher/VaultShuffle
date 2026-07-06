alter table public.games
drop constraint if exists games_priority_check;

alter table public.games
add constraint games_priority_check
check (priority in ('Low', 'Medium', 'High', 'Must Play'));

create table if not exists public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.collection_games (
  collection_id uuid not null references public.collections(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  notes text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (collection_id, game_id)
);

drop trigger if exists collections_set_updated_at on public.collections;
create trigger collections_set_updated_at
before update on public.collections
for each row execute function public.set_updated_at();

create index if not exists collections_user_id_idx on public.collections(user_id);
create index if not exists collection_games_collection_id_idx on public.collection_games(collection_id);
create index if not exists collection_games_game_id_idx on public.collection_games(game_id);
create index if not exists collection_games_position_idx on public.collection_games(collection_id, position);

alter table public.collections enable row level security;
alter table public.collection_games enable row level security;

grant select, insert, update, delete on table public.collections to service_role;
grant select, insert, update, delete on table public.collection_games to service_role;
