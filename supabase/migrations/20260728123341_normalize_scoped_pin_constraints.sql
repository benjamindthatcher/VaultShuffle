-- Give Library and Wishlist independent three-slot pin scopes.
alter table public.user_game_pins
  drop constraint if exists user_game_pins_pkey;
alter table public.user_game_pins
  drop constraint if exists user_game_pins_user_id_slot_key;
alter table public.user_game_pins
  add constraint user_game_pins_pkey primary key (user_id, scope, game_id);
alter table public.user_game_pins
  add constraint user_game_pins_user_scope_slot_key unique (user_id, scope, slot);
