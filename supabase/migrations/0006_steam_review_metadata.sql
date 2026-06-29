alter table public.steam_app_metadata
  add column if not exists rating integer not null default 0,
  add column if not exists review_score_desc text,
  add column if not exists review_total integer not null default 0,
  add column if not exists review_positive integer not null default 0;

create index if not exists steam_app_metadata_rating_idx on public.steam_app_metadata(rating);
