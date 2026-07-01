update public.games
set ownership = 'Wishlist'
where ownership = 'Game pass';

alter table public.games
alter column ownership set default 'Wishlist';

alter table public.games
drop constraint if exists games_ownership_check;

alter table public.games
add constraint games_ownership_check
check (ownership in ('Owned', 'Wishlist'));
