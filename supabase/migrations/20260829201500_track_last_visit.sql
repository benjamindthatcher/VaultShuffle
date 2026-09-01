-- When an account was last here.
--
-- last_login_at was the only signal for "still using this", and the
-- landing-page redirect made it useless: a signed-in visitor is sent straight to
-- their dashboard, and with a thirty day session they can come back every day
-- for weeks without ever touching the sign-in path again. It measures how long
-- ago someone first arrived, not whether they are still around.
--
-- It sits on app_accounts rather than app_users because that is the table both
-- cohorts share - app_users.id and manual_steam_profiles.id are both an
-- app_accounts.id - so one column covers Steam accounts and browser profiles
-- alike. On app_users it would have answered for 416 of the 604 accounts.
--
-- Backfilled rather than left null, because every one of these accounts has
-- visited at least once and reading them all as "never returned" would be
-- false: Steam accounts from their last login, manual profiles from the newest
-- session they were last seen on, and anything neither covers from the day the
-- account was created.

alter table public.app_accounts
  add column if not exists last_visited_at timestamptz;

update public.app_accounts a
   set last_visited_at = coalesce(u.last_login_at, a.created_at)
  from public.app_users u
 where u.id = a.id
   and a.last_visited_at is null;

update public.app_accounts a
   set last_visited_at = coalesce(s.seen, a.created_at)
  from (
    select profile_id, max(last_seen_at) as seen
      from public.manual_profile_sessions
     group by profile_id
  ) s
 where s.profile_id = a.id
   and a.last_visited_at is null;

update public.app_accounts
   set last_visited_at = created_at
 where last_visited_at is null;

-- "Who has been back since <date>" is the whole point of the column, and it is
-- answered by an ordered range scan rather than a scan of every account.
create index if not exists app_accounts_last_visited_at_idx
  on public.app_accounts (last_visited_at desc nulls last);
