-- Tuning the recommender without a deploy, and remembering how much a game is
-- actually played.
--
-- Two changes to the same problem: the best games were not being pushed.
--
-- game_preference_globals.total_hours holds the hours every user has put into a
-- game, added up. The verdict already stored beside it is a RATE - positive over
-- total - and a rate is capped at 1 by construction, so volume normalises away:
-- a 50,000 hour game and a 5,000 hour game score identically, and measured on
-- live data both land at about 1.12x the odds. Popularity is an absolute fact
-- about a game and needs an absolute number to carry it.
--
-- algorithm_weights makes the signal weights data rather than code. They are the
-- thing most likely to need adjusting as the product changes, and every change
-- to them today needs a deploy and a rebuild. Now it is an update statement and
-- the next nightly run.

alter table public.game_preference_globals
  add column if not exists total_hours double precision not null default 0;

create table if not exists public.algorithm_weights (
  key text primary key,
  positive double precision not null default 0,
  total double precision not null default 0,
  note text,
  updated_at timestamptz not null default now()
);

alter table public.algorithm_weights enable row level security;

grant select, insert, update, delete, truncate, references, trigger
  on public.algorithm_weights to service_role;
grant select, insert, update, delete, truncate, references, trigger
  on public.algorithm_weights to postgres;

-- Seeded with the weights the recommender should run at, which are not quite the
-- ones it has been running at. Launching a game is the strongest thing anyone
-- can say about a pick and was tied with a thumbs-up; pinning was worth half of
-- it. Sleeping and "not really" are the two deliberate rejections and both move
-- up. The bare reroll doubles because it is now the only way to reject a pick at
-- all - the snooze button that used to carry 42% of all reactions is gone.
insert into public.algorithm_weights (key, positive, total, note) values
  ('event:opened_on_steam',       3, 3, 'Launching it is the strongest yes the product can observe'),
  ('event:liked',                 2, 2, 'A stated opinion, but only about the pick'),
  ('event:pinned',                2, 2, 'Committing to play it next'),
  ('event:disliked',              0, 3, 'A deliberate no about this game'),
  ('event:slept',                 0, 4, 'The most considered rejection there is'),
  ('event:hidden_for_session',    0, 1.5, 'Retired control; earns from history only'),
  ('event:reroll_not_interested', 0, 2, 'A reason given for the reroll'),
  ('event:reroll_wrong_mood',     0, 1, 'About the evening, not the game: mood rows only'),
  ('event:drew_again',            0, 1, 'The only rejection path left now snooze is gone'),
  ('decision:sleep',              0, 4, 'Matches the draw-side weight'),
  ('decision:keep',               1, 2, 'Deliberate retention, not an endorsement'),
  ('decision:pin',                2, 2, 'Matches the draw-side weight'),
  ('decision:complete',           1, 1, 'Real evidence, weaker than choosing it tonight'),
  ('playtime:per_owner',          0, 0.5, 'Inferred rather than said, so it stays light')
on conflict (key) do nothing;
