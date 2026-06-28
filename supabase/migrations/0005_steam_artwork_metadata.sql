alter table public.steam_app_metadata
  add column if not exists capsule_url text,
  add column if not exists header_url text;
