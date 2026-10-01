-- Wishlist is purchase intent, completely separate from library lifecycle and
-- the retired user_games.ownership = 'Wishlist' tombstone. Steam app IDs need
-- not yet exist in our catalogue (unreleased games can be wishlisted too).
create table public.user_wishlist (
  user_id uuid not null references public.app_accounts(id) on delete cascade,
  steam_appid bigint not null check (steam_appid > 0 and steam_appid <= 4294967295),
  source text not null default 'local' check (source in ('local', 'steam')),
  added_at timestamptz not null default now(),
  primary key (user_id, steam_appid)
);
create index user_wishlist_added_idx on public.user_wishlist(user_id, added_at desc, steam_appid);
alter table public.user_wishlist enable row level security;
-- This app uses server-validated Steam/browser-profile sessions, not Supabase
-- Auth JWTs. Every API operation scopes its service-role query to that account.
revoke all on public.user_wishlist from public, anon, authenticated;
grant select, insert, delete on public.user_wishlist to service_role;
