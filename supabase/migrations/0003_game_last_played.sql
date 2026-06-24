alter table public.games
add column if not exists last_played_at timestamptz;
