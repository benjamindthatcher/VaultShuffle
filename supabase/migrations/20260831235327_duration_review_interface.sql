-- Owner-only evidence collection for catalogue games whose duration is still
-- unknown. A response is intentionally not projected into catalog_games: a
-- later, separately reviewed process decides whether it is an HLTB match, an
-- endless game, a non-game product or another kind of unresolved title.

create table if not exists public.catalog_duration_reviews (
  steam_appid bigint primary key references public.catalog_games (steam_appid) on delete cascade,
  response_text text not null check (
    char_length(btrim(response_text)) between 1 and 2000
  ),
  response_kind text not null check (response_kind in ('hltb_url', 'note')),
  source_url text,
  reviewer_user_id uuid references public.app_users (id) on delete set null,
  reviewed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (response_kind = 'hltb_url' and source_url is not null)
    or (response_kind = 'note' and source_url is null)
  )
);

comment on table public.catalog_duration_reviews is
  'Owner-supplied HLTB links or plain-language evidence for catalogue rows with no duration. Does not alter duration classifications.';

alter table public.catalog_duration_reviews enable row level security;
revoke all on table public.catalog_duration_reviews from public, anon, authenticated;
grant select, insert, update, delete on table public.catalog_duration_reviews to service_role;

-- The application queries this view only with its server-side service client.
-- security_invoker avoids the normal view-owner RLS bypass, while explicit
-- grants keep the review material out of the public Data API surface.
create or replace view public.catalog_duration_review_queue
with (security_invoker = true)
as
select
  game.steam_appid,
  game.name,
  game.header_url,
  game.capsule_url,
  game.duration_status,
  game.duration_kind,
  game.duration_source,
  game.users_that_imported,
  game.review_total,
  review.reviewed_at
from public.catalog_games as game
left join public.catalog_duration_reviews as review
  on review.steam_appid = game.steam_appid
where game.main_story_minutes is null
  and game.main_extras_minutes is null
  and game.completionist_minutes is null;

revoke all on table public.catalog_duration_review_queue from public, anon, authenticated;
grant select on table public.catalog_duration_review_queue to service_role;
