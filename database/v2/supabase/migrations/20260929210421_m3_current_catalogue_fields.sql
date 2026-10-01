-- Current source catalogue fields; no additional feature/state system.
begin;
alter table catalog.game_features
  add column player_mode text check (player_mode is null or player_mode in ('single','coop','multi')),
  add column store_tags_checked_at timestamptz,
  add column store_tags_state text check (store_tags_state is null or length(store_tags_state) <= 120);
comment on column catalog.game_features.player_mode is 'Existing Steam signal classification; NULL remains unclassified.';
comment on column catalog.game_features.store_tags_checked_at is 'Exact last Steam Store tag check instant, separate from generic tag fetch state.';
comment on column catalog.game_features.store_tags_state is 'Existing Store check verdict preserved independently from generic tag lifecycle.';
-- Vault events already store bounded text: play_now_intent needs no new state,
-- table or enum migration. The current transform preserves it verbatim.
commit;
