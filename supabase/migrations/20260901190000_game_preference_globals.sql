-- What people actually do with a specific game.
--
-- The learner has only ever reasoned about genres, and lately tags. Neither can
-- see what is wrong with the games people complain about: Hellblade's VR Edition
-- was slept by 10 of 10 people who met it, DEFCON Beta Demo by 9 of 9, Resident
-- Evil Resistance by 13 of 13. Every one of those shares its tags with a game
-- worth playing, so no amount of tag resolution reaches them. Only the game
-- itself does.
--
-- Population-wide rather than per person. One player meets a given game about
-- once, so there is no second observation to learn a per-player weight from -
-- but 2,515 games have now been decided on by two or more people and 767 by five
-- or more, which is a real verdict on the game.
--
-- Every game still has a score before anyone has touched it: what it is - its
-- reviews and reach - is applied separately in game-appeal, and this term only
-- moves a game off that as evidence about it accumulates. So a game nobody has
-- ever drawn, including one released tomorrow, is never unscored.

create table if not exists public.game_preference_globals (
  steam_appid bigint primary key,
  positive double precision not null default 0,
  total double precision not null default 0,
  updated_at timestamptz not null default now()
);

-- The rebuild sweeps rows it did not touch, the same way the genre tables do.
create index if not exists game_preference_globals_updated_at_idx
  on public.game_preference_globals (updated_at);

-- Matched to genre_preference_globals, which is the table this sits beside.
--
-- Row-level security on with no policy: nothing reaches this through the anon or
-- authenticated keys at all. Only the server, which holds the service role and
-- bypasses RLS, reads or writes it - and the service role still needs the grants
-- below, since bypassing RLS is not the same as being allowed near the table.
alter table public.game_preference_globals enable row level security;

grant select, insert, update, delete, truncate, references, trigger
  on public.game_preference_globals to service_role;
grant select, insert, update, delete, truncate, references, trigger
  on public.game_preference_globals to postgres;
