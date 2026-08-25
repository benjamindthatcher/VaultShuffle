alter table public.catalog_game_quarantine
  drop constraint catalog_game_quarantine_review_status_check;

alter table public.catalog_game_quarantine
  add constraint catalog_game_quarantine_review_status_check
  check (review_status = any (array['pending'::text, 'excluded'::text, 'allowed'::text]));

comment on column public.catalog_game_quarantine.review_status is
  'pending flags a possible non-game for manual review without hiding it; excluded hides a confirmed non-game; allowed records a reviewed false positive.';
