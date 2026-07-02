alter table public.games
drop constraint if exists games_status_check;

alter table public.games
add constraint games_status_check
check (status in ('Not Started', 'Sampled', 'In Progress', 'Completed'));
